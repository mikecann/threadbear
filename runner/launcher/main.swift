// Threadbear Runner: the executable inside "Threadbear Runner.app", which
// the runner's LaunchAgent runs (scripts/install-runner.sh writes the
// plist, launcher/build-launcher.sh builds the app). It starts the command
// it is given, `node <home>/runner/launch.mjs`, as a child, forwards the
// signals launchd sends it, and exits with the child's exit code.
//
// Why an app at all: macOS asks about a protected folder (Desktop,
// Documents, Dropbox, ...) in the name of the *responsible process*, which
// for a launchd job is the job's own program, and every process it starts
// inherits it. When the plist ran node straight, every prompt an agent's
// shell caused said "node", and the grant went to that Node binary, so it
// was lost when Node updated. With this app as the program the prompts say
// "Threadbear Runner" and the grant stays with the app, which is rebuilt
// only when these sources change and is always signed the same way
// (build-launcher.sh), so it survives runner releases and Node updates.
//
// The child is spawned, not exec'd, so this process stays the responsible
// one. It stays in the launcher's process group, so launchd's cleanup when
// the job ends (AbandonProcessGroup is off) still reaches node and the
// agent CLIs under it, as it did before.
import Darwin
import Foundation

#if APP_SWAP_HELPER
// Built separately from the LaunchAgent executable (build-launcher.sh).
let files = FileManager.default

func posixError() -> POSIXError {
  POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO)
}

func identity(_ path: String) throws -> String? {
  var info = stat()
  if lstat(path, &info) == 0 { return "\(info.st_dev):\(info.st_ino)" }
  if errno == ENOENT { return nil }
  throw posixError()
}

func move(_ source: String, _ destination: String) throws {
  if rename(source, destination) != 0 { throw posixError() }
}

func exchange(_ source: String, _ installed: String) throws {
  // A rename fills an empty slot. Exchange existing bundles in one step
  // so launchd always finds an executable at the installed path.
  if rename(source, installed) == 0 { return }
  if (errno == ENOTEMPTY || errno == EEXIST) &&
    renamex_np(source, installed, UInt32(RENAME_SWAP)) == 0 { return }
  throw posixError()
}

func verifies(_ app: String) throws -> Bool {
  guard access("\(app)/Contents/MacOS/Threadbear Runner", X_OK) == 0 else { return false }
  let verifier = Process()
  verifier.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
  verifier.arguments = ["--verify", app]
  try verifier.run()
  verifier.waitUntilExit()
  return verifier.terminationStatus == 0
}

enum Action: String {
  case apply, install, restore
}

struct SwapRecord: Codable {
  let incoming: String
  let keepPrevious: Bool
}

func updateApp(_ action: Action, installed: String, staged: String) throws -> Bool {
  // A restart and an installer can meet here. The lock is released by the
  // OS if either helper is killed. The builder publishes to staged separately.
  let lock = open(staged + ".lock", O_CREAT | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0o600)
  guard lock >= 0 else { throw posixError() }
  defer { close(lock) }
  guard flock(lock, LOCK_EX) == 0 else { throw posixError() }

  let pending = staged + ".swap"
  let recordURL = URL(fileURLWithPath: pending + ".incoming")
  let installDir = staged + ".install"
  let previous = installDir + "/previous.app"

  // The record is written before the exchange and removed after the old
  // bundle is moved or deleted. An unrecorded pending bundle is still the
  // incoming one. After the exchange its inode is the old bundle's.
  func finishExchange(keepBackup: Bool) throws {
    guard try identity(recordURL.path) != nil else { return }
    let record = try JSONDecoder().decode(SwapRecord.self, from: Data(contentsOf: recordURL))
    let remaining = try identity(pending)
    if remaining == record.incoming { return }
    if remaining != nil {
      if record.keepPrevious && keepBackup && files.fileExists(atPath: installDir) {
        try move(pending, previous)
      } else {
        try files.removeItem(atPath: pending)
      }
    }
    try files.removeItem(at: recordURL)
  }

  // A fresh full install keeps the app it is about to replace. Recovery
  // and rollback honor any outstanding backup from the interrupted swap.
  try finishExchange(keepBackup: action != .install)
  if action == .restore {
    // A retry after the exchange must not put the failed build back.
    let restoreRecord = URL(fileURLWithPath: installDir + "/restoring")
    if try identity(restoreRecord.path) != nil {
      let expected = try String(contentsOf: restoreRecord, encoding: .utf8)
      if try identity(installed) == expected { return true }
      guard try identity(previous) == expected else { return false }
    } else {
      guard let expected = try identity(previous) else { return false }
      try expected.write(to: restoreRecord, atomically: true, encoding: .utf8)
    }
    try exchange(previous, installed)
    return true
  }

  // A stage published since the last attempt can supersede the pending
  // build. Check it before discarding a candidate we could still install.
  if try identity(pending) != nil, try identity(staged) != nil, try verifies(staged) {
    try files.removeItem(atPath: pending)
    try finishExchange(keepBackup: false)
  }
  if try identity(pending) == nil, try identity(staged) != nil {
    try move(staged, pending)
  }
  guard let incoming = try identity(pending) else { return false }
  guard try verifies(pending) else {
    // Keep a rejected build available for diagnosis at the staging path.
    // A newer stage may already occupy it.
    if try identity(staged) == nil {
      try move(pending, staged)
      try finishExchange(keepBackup: false)
    }
    fputs("The staged Threadbear Runner.app doesn't verify.\n", stderr)
    exit(1)
  }
  let record = SwapRecord(incoming: incoming, keepPrevious: action == .install)
  try JSONEncoder().encode(record).write(to: recordURL, options: .atomic)
  try exchange(pending, installed)
  try finishExchange(keepBackup: true)
  return true
}

let args = CommandLine.arguments
guard args.count == 4, let action = Action(rawValue: args[1]) else {
  fputs("Usage: replace-app apply|install|restore <installed app> <staged app>\n", stderr)
  exit(64)
}
do {
  if try updateApp(action, installed: args[2], staged: args[3]) { print("changed") }
} catch {
  fputs("Could not \(args[1]) the launcher: \(error.localizedDescription)\n", stderr)
  exit(1)
}
#else

// The child's pid, read by the signal handlers. A signal that arrives
// before the child exists is kept and forwarded once it does.
nonisolated(unsafe) var childPid: pid_t = 0
nonisolated(unsafe) var pendingSignal: Int32 = 0

func log(_ level: String, _ message: String) {
  // launch.mjs's line format (and the runner's), since stderr is the
  // runner's log file.
  let at = ISO8601DateFormatter().string(from: Date())
  let line = "\(at) \(level) launcher: \(message)\n"
  line.withCString { _ = write(2, $0, strlen($0)) }
}

let arguments = CommandLine.arguments
if arguments.count < 2 {
  log("ERROR", "nothing to run. Threadbear Runner is started by launchd (com.mikerosoft.threadbear.runner) with the runner's command as its arguments; install it with runner/scripts/install-runner.sh rather than opening it.")
  exit(64)
}
let command = Array(arguments.dropFirst())

// Forwarded, not handled: the child decides what to do with them (launch.mjs
// stops its runners on SIGTERM, SIGINT and SIGHUP).
for sig in [SIGTERM, SIGINT, SIGHUP, SIGUSR1, SIGUSR2] {
  signal(sig) { sig in
    if childPid > 0 {
      kill(childPid, sig)
    } else {
      pendingSignal = sig
    }
  }
}

var argv: [UnsafeMutablePointer<CChar>?] = command.map { strdup($0) }
argv.append(nil)
var attrs: posix_spawnattr_t? = nil
posix_spawnattr_init(&attrs)
// Our handlers aren't inherited across exec anyway; this also hands the
// child the default dispositions for everything, whatever launchd gave us.
var all = sigset_t()
sigfillset(&all)
posix_spawnattr_setsigdefault(&attrs, &all)
posix_spawnattr_setflags(&attrs, Int16(POSIX_SPAWN_SETSIGDEF))

var pid: pid_t = 0
let rc = posix_spawnp(&pid, command[0], nil, &attrs, argv, environ)
posix_spawnattr_destroy(&attrs)
if rc != 0 {
  log("ERROR", "could not start \(command[0]): \(String(cString: strerror(rc)))")
  // 127 as a shell does for a command that can't be run; launchd starts
  // the job again after its ThrottleInterval, as for any failed start.
  exit(127)
}
childPid = pid
log("INFO", "started \(command.joined(separator: " ")) (pid \(pid))")
if pendingSignal != 0 {
  kill(pid, pendingSignal)
}

var status: Int32 = 0
while waitpid(pid, &status, 0) == -1 {
  if errno != EINTR {
    log("ERROR", "waitpid failed: \(String(cString: strerror(errno)))")
    exit(1)
  }
}
// WIFEXITED / WEXITSTATUS / WTERMSIG by hand: the macros don't come
// through to Swift.
if status & 0x7f == 0 {
  exit((status >> 8) & 0xff)
}
let terminated = status & 0x7f
log("INFO", "the runner was stopped by signal \(terminated)")
// The shell's convention for a child killed by a signal.
exit(128 + terminated)
#endif
