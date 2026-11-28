import { execFile, execFileSync } from 'node:child_process';
import { noHooksPath } from './platform.ts';
import os from 'node:os';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Standalone Windows setup does not inherit main.ts's executable-search
// guard. Resolve Git from absolute PATH entries, never the working folder.
export function gitProgram(): string {
  if (process.platform !== 'win32') return 'git';
  for (const dir of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const file = path.join(dir, 'git.exe');
    try { if (fs.statSync(file).isFile()) return file; } catch { /* Try the next PATH entry. */ }
  }
  throw new Error('Git for Windows is not on the absolute PATH. Install it before continuing.');
}

// git in a folder Threadbear hasn't trusted, or whose .git it didn't make.
// A folder from a zip, a tarball or a shared drive can carry its own
// .git/config, and `core.fsmonitor` there names a program git starts on
// anything that reads the working tree: `git ls-files`, `git status`,
// `git worktree add`. Settings given with -c beat the repo's own, so these
// turn it off (and the untracked cache, which feeds from it) whatever the
// folder says. Every git the runner runs in a thread's folder goes through
// these (docs/protocol/trust.md, "Trusting a folder's patches").
export const UNTRUSTED_GIT_CONFIG: readonly string[] = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'];

// The arguments for `git -C <dir> ...args` with those settings first.
export function untrustedGitArgs(dir: string, args: readonly string[]): string[] {
  return [...UNTRUSTED_GIT_CONFIG, '-C', dir, ...args];
}

// Keep Git's commit identities and its non-executable discovery ceiling.
// Other GIT_ variables set when the runner was started from inside a git hook (or by hand) could point git
// at another repo, or add config (GIT_CONFIG_COUNT, GIT_CONFIG_PARAMETERS)
// that comes after the -c settings above.
export function untrustedGitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const k of Object.keys(env)) if (/^GIT_/i.test(k) && !/^GIT_(?:(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)|CEILING_DIRECTORIES)$/.test(k)) delete env[k];
  // Git for Windows starts helpers by name (ssh, git merge-file) in the
  // repo's folder; scripts run outside the runner (setup, deploy,
  // merge-prepared) don't have the runner's setting (Gemini's second
  // break-it review of 187/188, 28 Nov 2026).
  if (process.platform === 'win32') env.NoDefaultCurrentDirectoryInExePath = '1';
  return env;
}

// A listing never fetches or runs a hook. A folder's .git can also say
// it's a partial clone with objects missing (a sparse index whose tree
// isn't there), and git fetches a missing object by itself as it reads the
// index, through the repo's own core.sshCommand, a remote's uploadpack or
// an ext:: address: `git ls-files -s` ran a planted core.sshCommand with
// fsmonitor off (Codex's review of this fix, 9 Nov 2026). GIT_NO_LAZY_FETCH
// stops that in git 2.44 and later. For older git, every transport is
// refused too, each by name, as a protocol's own setting in the repo's
// config would beat protocol.allow. A listing missing an object leaves
// those files out, which is what Claude would see too.
const PROTOCOL_NAMES = ['ext', 'fd', 'file', 'git', 'ssh', 'http', 'https'];
function protocols(allowed: readonly string[]): string[] {
  return ['-c', 'protocol.allow=never', ...PROTOCOL_NAMES.flatMap((p) => ['-c', `protocol.${p}.allow=${allowed.includes(p) ? 'always' : 'never'}`])];
}
const NO_FETCH: readonly string[] = protocols([]);
const LISTINGS = new Set(['ls-files', 'rev-parse']);
export const LISTING_GIT_CONFIG: readonly string[] = [...UNTRUSTED_GIT_CONFIG, ...NO_FETCH, '-c', `core.hooksPath=${noHooksPath()}`];
// And the environment a listing runs with. A protocol a repo allows itself
// (protocol.<name>.allow, any name) beats protocol.allow=never, and a git
// that ignores GIT_NO_LAZY_FETCH (before 2.44, unless patched) ran the
// repo's own transport helper for a missing object; GIT_ALLOW_PROTOCOL
// beats every config, so with a name no transport has, none is allowed
// (Gemini's break-it review of 187/188, 28 Nov 2026). No prompt or askpass
// program either, should a transport start anyway.
export const LISTING_GIT_ENV: Readonly<Record<string, string>> = { GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: 'none', GIT_ASKPASS: '', GIT_TERMINAL_PROMPT: '0' };

// A git listing in `dir`, read whole: what claude-trust and tracked-packages
// use to see what a folder holds before it's trusted. Throws as
// execFileSync does when git fails.
export function untrustedGitSync(dir: string, args: readonly string[]): string {
  // Only listings: nothing here switches filters off (ls-files never runs one).
  if (!LISTINGS.has(args[0] ?? '')) throw new Error(`untrustedGitSync is for listings, not git ${args[0]}`);
  return execFileSync(gitProgram(), [...LISTING_GIT_CONFIG, '-C', dir, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...untrustedGitEnv(), ...LISTING_GIT_ENV },
  });
}

// git that a repo's own config can't make run anything, for work beyond a
// listing in a folder Threadbear didn't vet: a move's git (move-git.ts)
// reads, hashes and checks out the working tree, makes commits and fetches
// (security review, 10 Nov 2026: a move's preview ran `git status` in a
// shared checkout, and a .git/config from an archive with a
// `filter.<name>.clean` command, selected by its .gitattributes, ran as
// the owner). On top of a listing's settings:
// - every filter driver named in any config git reads is switched off
//   (clean, smudge and process blank, required false): a blank command is
//   no filter, and the owner's own ones go too, as git-lfs's filter itself
//   runs commands a repo's config names (`lfs.extension.*`, custom
//   transfers). Files go across as the disk has them.
// - diff drivers' programs blank, for the same reason, though none of a
//   move's commands diff.
// - no commit signing (gpg.program is the repo's to name), no submodule
//   recursion (a submodule's own config isn't read here), no auto gc.
// - with `network`, for a fetch or a clone: only https, ssh and file, and
//   the programs a transport runs (credential helpers, core.sshCommand,
//   core.askPass, core.alternateRefsCommand) are the owner's own (system
//   or global config) whatever the repo's says. A remote's uploadpack is
//   the one setting where git takes the first it reads, not the last, so a
//   fetch or clone is given git's own upload-pack on its command line. A
//   local origin's upload-pack reads that repo's config, but git takes
//   its one program setting (uploadpack.packObjectsHook) only from the
//   owner's own, and it doesn't lazy fetch (GIT_NO_LAZY_FETCH).
// The config is read each time, just before the command, so what's
// switched off is what that command would find. A live command's git
// (shell-allowlist.ts liveCommandEnv) refuses a repo whose own config
// sets anything unusual instead; a move can't, as it has to work in any
// repo a thread is in (husky's core.hooksPath, a local git-lfs install),
// so known program settings are switched off. Unknown local settings fail
// closed with guidance to move owner-approved settings to global config.
// `bytes`: stdout as git wrote it, with UntrustedGitOptions.bytes (a blob that
// isn't UTF-8 would not survive the string).
export type UntrustedGitResult = { ok: boolean; code: number; stdout: string; stderr: string; bytes?: Buffer };
export type UntrustedGitOptions = {
  // Extra variables (GIT_INDEX_FILE, the author), set after the runner's
  // own GIT_ ones are dropped.
  env?: Record<string, string>;
  // 'bundle': a fetch from a bundle file (the file protocol only).
  // 'remote': a fetch or clone from a remote, see above.
  network?: 'bundle' | 'remote';
  // For the whole call, reading the repo's config included.
  timeoutMs?: number;
  bytes?: boolean;
  input?: string | Buffer;
};

export const TRUSTED_SCOPES: ReadonlySet<string> = new Set(['system', 'global', 'unknown']); // 'unknown': Apple's own git config
// diff.external too: a blank one is no program, even with --ext-diff (git
// fails rather than run one).
const ALWAYS: readonly string[] = ['-c', 'diff.external=', '-c', 'safe.bareRepository=explicit', '-c', 'http.saveCookies=false', '-c', 'commit.gpgSign=false', '-c', 'tag.gpgSign=false', '-c', 'submodule.recurse=false', '-c', 'fetch.recurseSubmodules=false', '-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'core.commitGraph=false', '-c', 'core.sparseCheckout=false', '-c', 'core.sparseCheckoutCone=false', '-c', 'merge.autoStash=false', '-c', 'rebase.autoStash=false', '-c', 'rebase.updateRefs=false', '-c', 'rebase.instructionFormat=%s', '-c', 'core.pager=cat', '-c', 'log.showSignature=false', '-c', 'format.pretty=medium', '-c', 'gpg.program=', '-c', 'gpg.openpgp.program=', '-c', 'gpg.x509.program=', '-c', 'gpg.ssh.program=', '-c', 'gpg.ssh.defaultKeyCommand=', '-c', 'merge.verifySignatures=false', '-c', 'push.gpgSign=false', '-c', 'push.recurseSubmodules=no', '-c', 'core.attributesFile=' + os.devNull, '-c', 'merge.default=text', '-c', 'init.templateDir=', '-c', 'core.alternateRefsCommand=true', '-c', 'diff.ignoreSubmodules=all', '-c', 'status.submoduleSummary=false', '-c', 'fsck.skipList=' + os.devNull, '-c', 'advice.graftFileDeprecated=false', '-c', 'log.showRoot=true', '-c', 'diff.relative=false', '-c', 'color.ui=false', '-c', 'log.follow=false', '-c', 'core.protectNTFS=true', '-c', 'core.protectHFS=true', '-c', 'rebase.backend=merge', '-c', 'rerere.enabled=false', '-c', 'rerere.autoUpdate=false', '-c', 'pull.twohead=ort', '-c', 'pull.octopus=octopus', '-c', 'fetch.all=false', '-c', 'commit.template=', '-c', 'rebase.rebaseMerges=false', '-c', 'rebase.autoSquash=false', '-c', 'rebase.missingCommitsCheck=ignore', '-c', 'merge.directoryRenames=conflict', '-c', 'merge.renames=true', '-c', 'diff.renames=true', '-c', 'merge.renormalize=false', '-c', 'merge.ff=true', '-c', 'push.followTags=false', '-c', 'push.default=simple'];
// Transport programs a fetch or clone may run, with what stands in when the
// owner's config has none.
const TRANSPORT: { key: RegExp; fallback: string }[] = [
  { key: /^core\.sshcommand$/, fallback: 'ssh' },
  { key: /^core\.askpass$/, fallback: '' },
  { key: /^core\.alternaterefscommand$/, fallback: 'true' },
];

type ConfigEntry = { scope: string; key: string; value: string };

// `git config --list --show-scope -z`: scope NUL key LF value NUL, ...
export function parseConfigList(out: string): ConfigEntry[] {
  const parts = out.split('\0');
  const list: ConfigEntry[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const kv = parts[i + 1]!;
    const nl = kv.indexOf('\n');
    list.push({ scope: parts[i]!, key: nl < 0 ? kv : kv.slice(0, nl), value: nl < 0 ? '' : kv.slice(nl + 1) });
  }
  return list;
}

// The same from git's own bytes. A setting's name is bytes to git, and node
// hands -c to git as UTF-8, so a name that isn't UTF-8 (a hook named with
// byte 0xff) read as text comes back as U+FFFD and switching it off would
// name a different setting, leaving the repo's on (Codex's review of
// Daybreak 179, 24 Nov 2026): it fails instead, as one -c can't carry does.
const UTF8 = new TextDecoder('utf-8', { fatal: true });
export function parseConfigListBytes(out: Buffer): ConfigEntry[] {
  return parseConfigList(out.toString('latin1')).map((e) => {
    let key: string;
    try {
      key = UTF8.decode(Buffer.from(e.key, 'latin1'));
    } catch {
      throw new Error(`This repo's git config has a setting whose name isn't UTF-8 text (${JSON.stringify(e.key.slice(0, 80))}), which Threadbear can't switch off, so it left git alone.`);
    }
    return { scope: e.scope, key, value: Buffer.from(e.value, 'latin1').toString('utf8') };
  });
}

// A name git's -c can carry: it splits `key=value` at the first =.
export function settable(key: string): string {
  if (key.includes('=') || key.includes('\n')) throw new Error(`This repo's git config has a setting Threadbear can't switch off (${JSON.stringify(key.slice(0, 80))}), so it left git alone.`);
  return key;
}

// Local settings must either be passive or have an explicit override below.
// New Git options cannot silently add another repository-selected program.
const LOCAL_KEYS = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|autocrlf|eol|checkstat|trustctime|worktree|sparsecheckout|sparsecheckoutcone|fsmonitor|untrackedcache|hookspath|sshcommand|askpass|alternaterefscommand|pager|attributesfile|excludesfile|longpaths|commitgraph)$/,
  /^remote\.[\s\S]+\.(url|pushurl|fetch|tagopt|prune|prunetags|gh-resolved|skipdefaultupdate|skipfetchall|promisor|partialclonefilter|uploadpack|receivepack|proxy|proxyauthmethod)$/,
  /^branch\.[\s\S]+\.(remote|merge|pushremote|rebase|description|mergeoptions)$/,
  /^extensions\.(worktreeconfig|objectformat|refstorage|partialclone|relativeworktrees)$/,
  /^user\.(name|email|signingkey)$/,
  /^credential\.[\s\S]+$/,
  /^filter\.[\s\S]*\.(clean|smudge|process|required)$/,
  /^diff\.[\s\S]*\.(command|textconv|binary|cachetextconv|xfuncname|wordregex|algorithm)$/,
  /^merge\.[\s\S]*\.(name|driver)$/,
  /^hook\.[\s\S]*\.(command|event|enabled)$/,
  /^submodule\.[\s\S]*\.(url|path|active|ignore|branch|fetchrecursesubmodules|update|shallow)$/,
  /^protocol\.[\s\S]*\.allow$/,
  /^protocol\.version$/,
  /^(url|http)\.[\s\S]+$/,
  /^include\.path$/,
  /^lfs\.repositoryformatversion$/,
  /^(pull\.(rebase|ff)|push\.(default|autosetupremote|gpgsign|recursesubmodules)|init\.(defaultbranch|templatedir)|fetch\.(prune|prunetags|recursesubmodules)|rerere\.enabled|commit\.gpgsign|tag\.gpgsign|submodule\.recurse|gc\.auto|maintenance\.auto|merge\.(autostash|default|verifysignatures)|rebase\.(autostash|updaterefs|instructionformat)|sequence\.editor|format\.pretty|log\.showsignature|diff\.(external|ignoresubmodules)|status\.submodulesummary|advice\.graftfiledeprecated|fsck\.skiplist|safe\.barerepository)$/,
  /^gpg\.(program|format|openpgp\.program|x509\.program|ssh\.(program|defaultkeycommand|allowedsignersfile|revocationfile))$/,
];

// Beyond those, tools write settings of their own into a repo's config
// (VS Code's branch.<name>.vscode-merge-base, gh's branch.<name>.github-pr-*,
// git-lfs's lfs.<url>.*), and refusing every name not listed above stopped
// worktrees and landings in ordinary repos (Gemini's break-it review of
// 187/188, 28 Nov 2026). So a setting in a section whose settings run nothing
// in the commands untrustedGit runs goes through too, unless its name says
// it names a program or moves a transfer. Any other section still fails
// closed (pager.*, sendemail.*, web.*, a tool's own section).
const PASSIVE_SECTIONS = /^(advice|am|apply|blame|branch|checkout|color|column|commit|core|diff|feature|fetch|format|gc|gui|help|i18n|index|init|interactive|lfs|log|maintenance|merge|notes|pack|pretty|pull|push|rebase|remote|repack|rerere|status|submodule|tag|transfer|user|worktree)\./;
const NAMES_A_PROGRAM = /(command|cmd|program|helper|hook|proxy|exec|vcs|bundleuri|filter)$/;
function localKeyOk(key: string): boolean {
  // A merge driver's recursive one picks another way to merge (binary,
  // union) that a blanked driver can't stand in for (Gemini's fifth review).
  if (/^merge\.[\s\S]+\.recursive$/.test(key)) return false;
  // A remote's mirror or push refspec changes what a plain push sends
  // (Gemini's eighth review).
  if (/^remote\.[\s\S]+\.(mirror|push)$/.test(key)) return false;
  if (LOCAL_KEYS.some((p) => p.test(key))) return true;
  return PASSIVE_SECTIONS.test(key) && !NAMES_A_PROGRAM.test(key.slice(key.lastIndexOf('.') + 1));
}

// A partial clone fetches what it lacks from its promisor remotes by
// itself, with that remote's settings and none of the command line's, on a
// git that ignores GIT_NO_LAZY_FETCH (before 2.44, unless patched). One
// across the network is bounded by GIT_ALLOW_PROTOCOL and the owner's
// transport programs; one on this machine (a path, file://, or a name with
// no address) would run a git server with that repository's own config, and
// a remote's own server program (uploadpack, receivepack) would run as
// named. So a partial clone with either is refused, here, where the release
// check (upstream.ts) gets it too (Gemini's fifth and sixth break-it
// reviews, 28 Nov 2026). A partial clone of a network remote is fine.
function promisorNames(entries: readonly ConfigEntry[]): Set<string> {
  const names = new Set<string>();
  for (const e of entries) {
    if (TRUSTED_SCOPES.has(e.scope)) continue;
    if (e.key === 'extensions.partialclone' && e.value) names.add(e.value);
    const m = /^remote\.([\s\S]+)\.promisor$/.exec(e.key);
    if (m && !/^(false|no|off|0)$/i.test(e.value)) names.add(m[1]!);
  }
  return names;
}
function partialCloneProblem(entries: readonly ConfigEntry[]): string | undefined {
  const names = promisorNames(entries);
  if (!names.size) return undefined;
  // Only a remote with an address in the config: one without, git looks up
  // in .git/remotes or .git/branches (any name without a slash, a:b too),
  // and a repo's own url rewrite would move one that has (Gemini's seventh
  // break-it review).
  const rewrite = entries.find((e) => !TRUSTED_SCOPES.has(e.scope) && /^url\./.test(e.key));
  if (rewrite) return `This repo is a partial clone that rewrites remote addresses itself (${rewrite.key}); it must move to your global git config.`;
  for (const name of names) {
    const urls = entries.filter((e) => e.key === `remote.${name}.url`).map((e) => e.value);
    if (!urls.length) return `This repo is a partial clone whose promisor remote (${name}) has no address in its git config; Threadbear refused to run git here.`;
    if (urls.some(localAddress)) return `This repo is a partial clone whose promisor remote (${name}) is on this machine, which git would fetch from by itself with that repository's own settings; Threadbear refused to run git here.`;
  }
  const server = entries.find((e) => !TRUSTED_SCOPES.has(e.scope) && /^remote\.[\s\S]+\.(uploadpack|receivepack)$/.test(e.key));
  return server ? `This repo is a partial clone that names a remote's server program (${server.key}), which a fetch git starts by itself would run; it must move to your global git config.` : undefined;
}

// The -c settings for `entries` (a repo's config as git reads it): see above.
export function repoProofConfig(entries: readonly ConfigEntry[], network?: 'bundle' | 'remote', filesForTests = false): string[] {
  const out: string[] = [...UNTRUSTED_GIT_CONFIG, '-c', `core.hooksPath=${noHooksPath()}`, ...ALWAYS, ...protocols(network === 'remote' ? ['https', 'ssh', 'file'] : network === 'bundle' ? ['file'] : [])];
  // Pinned on above anyway; a repo that switches either off wants to write
  // a checkout under another spelling of .git (Gemini's third break-it review).
  for (const e of entries) if (!TRUSTED_SCOPES.has(e.scope) && /^core\.protect(ntfs|hfs)$/.test(e.key) && !/^(true|yes|on|1)$/i.test(e.value)) throw new Error(`This repo switches off git's check of .git's other spellings (${e.key}); remove it before Threadbear runs git here.`);
  const partial = partialCloneProblem(entries);
  if (partial) throw new Error(partial);
  for (const e of entries) if (!TRUSTED_SCOPES.has(e.scope) && /^includeif\./i.test(e.key)) throw new Error('This repo has conditional git includes. Move them to your global git config before Threadbear changes worktrees.');
  const drivers = new Set<string>();
  const hooks = new Set<string>();
  const submodules = new Set<string>();
  const allowed = network === 'remote' ? ['https', 'ssh', 'file'] : network === 'bundle' ? ['file'] : [];
  for (const e of entries) {
    if (e.scope !== 'command' && !TRUSTED_SCOPES.has(e.scope) && !localKeyOk(e.key) && !(filesForTests && /^url\./.test(e.key))) throw new Error(`This repo's git setting (${e.key}) must move to your global git config before Threadbear can run git here.`);
    // A protocol the repo names beats protocol.allow too (ftp, a helper's
    // name for `foo::`), so each one it names is turned off by name.
    // Any name, empty and with line separators too, which `.` skips
    // (Gemini's review of Daybreak 179, as for hooks below).
    const p = /^protocol\.([\s\S]*)\.allow$/.exec(e.key);
    if (p && !allowed.includes(p[1]!) && !PROTOCOL_NAMES.includes(p[1]!)) out.push('-c', `${settable(e.key)}=never`);
    if (/^branch\.[\s\S]*\.mergeoptions$/.test(e.key)) out.push('-c', `${settable(e.key)}=`);
    const sub = /^submodule\.([\s\S]*)\.[^.]+$/.exec(e.key);
    if (sub) submodules.add(sub[1]!);
    const m = /^merge\.([\s\S]*)\.driver$/.exec(e.key);
    if (m) out.push('-c', `${settable(e.key)}=git merge-file --marker-size=%L -- %A %O %B`);
    if (network && !filesForTests && !TRUSTED_SCOPES.has(e.scope) && (/^(url\.|http\.)/.test(e.key) || /^remote\.[\s\S]*\.(proxy|proxyauthmethod)$/.test(e.key) || /^remote\.[\s\S]*[:/\\][\s\S]*\.[^.]+$/.test(e.key))) throw new Error(`This repo's transport config (${e.key}) must move to your global git config before Threadbear can fetch or push.`);
    const f = /^filter\.([\s\S]*)\.[^.]+$/.exec(e.key);
    if (f) drivers.add(`filter.${f[1]}`);
    const d = /^diff\.([\s\S]*)\.(command|textconv)$/.exec(e.key);
    if (d) out.push('-c', `${settable(`diff.${d[1]}.${d[2]}`)}=`);
    // A hook named in config (git 2.54's hook.<name>.command and .event)
    // runs whatever core.hooksPath says: update-ref ran a repo's
    // reference-transaction one (Codex's review, 18 Nov 2026).
    // Any name: empty ([hook ""]) and with line separators too, which `.`
    // skips (Codex's third review). One -c can't carry fails closed (settable).
    const h = /^hook\.([\s\S]*)\.[^.]+$/.exec(e.key);
    if (h) hooks.add(h[1]!);
  }
  for (const s of submodules) out.push('-c', `${settable(`submodule.${s}.ignore`)}=all`, '-c', `${settable(`submodule.${s}.update`)}=none`, '-c', `${settable(`submodule.${s}.fetchRecurseSubmodules`)}=false`);
  for (const h of hooks) out.push('-c', `${settable(`hook.${h}.enabled`)}=false`);
  for (const d of drivers) out.push('-c', `${settable(`${d}.clean`)}=`, '-c', `${d}.smudge=`, '-c', `${d}.process=`, '-c', `${d}.required=false`);
  if (network === 'remote') {
    const fromRepo = (match: (k: string) => boolean) => entries.some((e) => match(e.key) && !TRUSTED_SCOPES.has(e.scope));
    const owners = (match: (k: string) => boolean) => entries.filter((e) => match(e.key) && TRUSTED_SCOPES.has(e.scope));
    const helper = (k: string) => /^credential\.([\s\S]*\.)?helper$/.test(k);
    if (fromRepo(helper)) {
      // An empty helper empties the list so far; then the owner's, in order.
      out.push('-c', 'credential.helper=');
      for (const e of owners(helper)) out.push('-c', `${settable(e.key)}=${e.value}`);
    }
    for (const t of TRANSPORT) {
      for (const key of new Set(entries.filter((e) => t.key.test(e.key) && !TRUSTED_SCOPES.has(e.scope)).map((e) => e.key))) {
        const own = owners((k) => k === key).pop();
        out.push('-c', `${settable(key)}=${own ? own.value : t.fallback}`);
      }
    }
  }
  return out;
}

// One git the checks before a command need, run the same way by the async
// and the sync entry points (as objectChecks, below).
type GitStep = { cwd: string; args: string[]; env: NodeJS.ProcessEnv; timeoutMs: number; bytes?: boolean; input?: string | Buffer };

function* checkWorktree(dir: string, entries: readonly ConfigEntry[], env: NodeJS.ProcessEnv): Generator<GitStep, void, UntrustedGitResult> {
  if (!entries.some((e) => !TRUSTED_SCOPES.has(e.scope) && e.key === 'core.worktree')) return;
  let root = path.resolve(dir);
  while (!fs.existsSync(path.join(root, '.git'))) {
    const parent = path.dirname(root);
    if (parent === root) throw new Error('Cannot validate this repository core.worktree setting.');
    root = parent;
  }
  const result = yield { cwd: dir, args: [...LISTING_GIT_CONFIG, '-C', dir, 'rev-parse', '--show-toplevel'], env, timeoutMs: 10_000 };
  if (!result.ok || fs.realpathSync(result.stdout.trim()) !== fs.realpathSync(root)) throw new Error('This repository core.worktree points outside its checkout; Threadbear left it alone.');
}
function modulesFile(root: string): string | undefined {
  const file = path.join(root, '.gitmodules');
  try {
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 1024 * 1024) throw new Error('This repository has an unsafe .gitmodules file.');
    return file;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
}
function moduleEntries(data: Buffer): ConfigEntry[] {
  const out: ConfigEntry[] = [];
  for (const part of UTF8.decode(data).split('\0').filter(Boolean)) {
    const n = part.indexOf('\n');
    const key = n < 0 ? part : part.slice(0, n);
    const sub = /^submodule\.([\s\S]*)\.[^.]+$/.exec(key);
    if (sub) out.push({ scope: 'local', key: `submodule.${sub[1]}.ignore`, value: 'all' });
  }
  return out;
}

// The .gitmodules blobs in `git log -m --raw -- .gitmodules`: either side of
// every change, a version added or removed by a type change (a link or a
// gitlink becoming the file, Gemini's review of 187, 27 Nov 2026) too. git
// reads .gitmodules only as a regular file, so only those versions count. A
// line it can't read fails, rather than leaving a name out.
export function moduleHistoryBlobs(raw: string): string[] {
  const oids = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]{40,64}) ([0-9a-f]{40,64}) [^\t]+\t([\s\S]+)$/.exec(line);
    if (!m) throw new Error('Cannot read the submodule configuration history.');
    if (m[5].includes('\t')) throw new Error('Cannot read the submodule configuration history.');
    if (m[5] !== '.gitmodules') continue;
    for (const [mode, oid] of [[m[1]!, m[3]!], [m[2]!, m[4]!]] as const) {
      if ((mode === '100644' || mode === '100755') && !/^0+$/.test(oid)) oids.add(oid);
    }
  }
  if (oids.size > 1_000) throw new Error('The submodule configuration history is too large.');
  return [...oids];
}

function moduleRevCandidates(rest: readonly string[]): string[] {
  const base = ['HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REBASE_HEAD', 'ORIG_HEAD', 'FETCH_HEAD'];
  const extra = rest.flatMap((a) => (a.startsWith('-') ? [] : a.split(/\.\.\.?/).filter(Boolean)));
  return [...new Set([...base, ...extra])];
}

// A fetch, clone or ls-remote from a repository on this machine starts
// git-upload-pack in it, and a push starts git-receive-pack, and git hands
// neither the -c settings here (a local transport drops them): each would
// read that repository's own config, and receive-pack would run its hooks.
// So untrustedGit names that server itself, a fixed command with its own
// settings (serverCommand), and as a second layer reads every repository
// the transfer will use, found the way git finds it (checkTransfer,
// localGitDirs), refusing one that could run something: a source may not be
// a partial clone, have includes or settings outside the known ones; a push
// target must be a plain bare repository with no hooks. Earlier versions
// guessed at which word was the repository and were got round several ways
// (Codex's and Gemini's reviews of 187/188, 27 and 28 Nov 2026).
const TRANSFERS = new Set(['fetch', 'clone', 'ls-remote', 'push']);
const ENTER_REPO_SUFFIXES = ['/.git', '', '.git/.git', '.git'];
const PUSH_TARGET_KEYS = /^(core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|sharedrepository)|extensions\.(objectformat|refstorage)|remote\.[\s\S]+\.(url|pushurl|fetch|tagopt|mirror)|branch\.[\s\S]+\.(remote|merge|description)|user\.(name|email)|init\.defaultbranch|gc\.auto|advice\.[^.]+)$/;
const RUNS_ON_PUSH = /^(core\.(hookspath|fsmonitor|sshcommand|askpass|alternaterefscommand|pager|editor)$|hook\.|filter\.|credential\.|gpg\.|sequence\.editor$|merge\.[\s\S]*\.driver$|diff\.[\s\S]*\.(command|textconv)$)/;

function refuse(why: string): Error {
  return new Error(`Threadbear refused the transfer: ${why}`);
}

// What a .git file names, or undefined for any other file (a bundle).
function gitfileTarget(file: string): string | undefined {
  const fd = fs.openSync(file, 'r');
  let head: Buffer;
  try {
    head = Buffer.alloc(8);
    head = head.subarray(0, fs.readSync(fd, head, 0, 8, 0));
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1') !== 'gitdir: ') return undefined;
  if (fs.statSync(file).size > 64 * 1024) throw refuse(`the .git file ${file} is too big to be one.`);
  const named = fs.readFileSync(file, 'utf8').slice(8).replace(/[\r\n]+$/, '');
  // Relative to the file's folder as written, as git's read_gitfile joins it.
  const target = path.isAbsolute(named) ? named : `${file.slice(0, Math.max(file.lastIndexOf('/'), file.lastIndexOf(path.sep)))}${path.sep}${named}`;
  try {
    return fs.realpathSync.native(target); // the OS's, which resolves `..` after a link
  } catch {
    return undefined; // git can't open it either
  }
}

// The path git takes from a file:// address: what follows file:// (or
// file://localhost), as written. git keeps ? and # in it and decodes %,
// where a URL parser drops or decodes them differently, and a parser also
// collapses `.` and `..` and, on a Mac or Linux, turns a backslash into a
// slash: an address it would change isn't followed (Gemini's second and
// third break-it reviews). On Windows the written form /C:/x is C:\x.
export function fileUrlPath(word: string, windows = process.platform === 'win32'): string {
  const shown = JSON.stringify(word.slice(0, 200));
  if (/[?#%]/.test(word)) throw refuse(`it doesn't follow a file:// address with ?, # or % in it (${shown}).`);
  let url: URL;
  try { url = new URL(word); } catch { throw refuse(`it can't read ${shown} as a file:// address.`); }
  if (url.hostname && url.hostname.toLowerCase() !== 'localhost') throw refuse(`${shown} isn't a path on this machine.`);
  let raw: string;
  try { raw = fileURLToPath(url, { windows }); } catch { throw refuse(`it can't read ${shown} as a file:// address.`); }
  let written = word.replace(/^file:\/\/(localhost)?/i, '');
  if (windows) written = written.replace(/^\/(?=[A-Za-z]:)/, '').replace(/\//g, '\\');
  if (raw !== written) throw refuse(`it doesn't follow a file:// address it can't read exactly as git does (${shown}).`);
  return raw;
}

// The repositories git could open on this machine for `word`: none for a
// network address.
function localGitDirs(dirs: readonly string[], word: string, home: string): string[] {
  let raw: string;
  if (/^file:\/\//i.test(word)) {
    raw = fileUrlPath(word);
  } else {
    // As git's url_is_local_not_ssh, with a backslash also counted as a
    // slash: taking more words as paths only checks more.
    const colon = word.indexOf(':'), slash = word.search(/[\\/]/);
    // C:evil is relative to drive C's own current folder on Windows (git
    // takes it as local there): it can't be followed, so it's refused.
    if (/^[A-Za-z]:(?![\\/])/.test(word)) throw refuse(`it can't follow a drive-relative path (${JSON.stringify(word.slice(0, 200))}).`);
    if (colon >= 0 && !(slash >= 0 && slash < colon) && !/^[A-Za-z]:[\\/]/.test(word)) return [];
    if (/^~(?:[\\/]|$)/.test(word)) raw = home + word.slice(1);
    else if (word.startsWith('~')) throw refuse(`it can't check ${JSON.stringify(word.slice(0, 200))}, another user's home, which git would open.`);
    else if (path.isAbsolute(word)) raw = word;
    else return [...new Set(dirs.flatMap((d) => localGitDirs([], `${d}${path.sep}${word}`, home)))];
  }
  // As written, its trailing slashes gone as enter_repo takes them off, so
  // the OS resolves `..` through a link as it does for git; and tidied too,
  // which only checks more.
  const stripped = raw.replace(/(?<=[^\\/])[\\/]+$/, '');
  const bases = [...new Set([stripped, path.resolve(stripped)])];
  const found = new Set<string>();
  for (const base of bases) {
    for (const suffix of ENTER_REPO_SUFFIXES) {
      const at = base + suffix;
      let st: fs.Stats;
      try { st = fs.statSync(at); } catch { continue; }
      if (st.isDirectory()) {
        // Joined as a string: path.join would take `link/..` out before the
        // OS resolves it through the link, as it does for git.
        if (fs.existsSync(`${at}${path.sep}HEAD`)) found.add(fs.realpathSync.native(at));
      } else if (st.isFile()) {
        const target = gitfileTarget(at);
        if (target) found.add(target);
      }
    }
  }
  return [...found];
}

function checkEndpoint(gitDir: string, listing: Buffer, push: boolean): void {
  // A partial clone of a network remote is a fine source: its server runs
  // serverCommand, which allows no transport at all.
  const partial = partialCloneProblem(parseConfigListBytes(listing));
  if (partial) throw refuse(`the repository at ${gitDir}: ${partial}`);
  for (const e of parseConfigListBytes(listing)) {
    if (e.scope === 'command' || TRUSTED_SCOPES.has(e.scope)) continue;
    if (/^includeif\./i.test(e.key)) throw refuse(`the repository at ${gitDir} has conditional git includes.`);
    // upload-pack's own settings: none runs a program from a repo's config
    // (git takes uploadpack.packObjectsHook only from the owner's own).
    if (/^uploadpack\./.test(e.key)) continue;
    // A mirror clone is a normal repository to fetch from or push to; its
    // mirror setting only shapes its own pushes.
    if (/^remote\.[\s\S]+\.mirror$/.test(e.key)) continue;
    // upload-pack runs Threadbear's own settings (serverCommand), but a
    // source naming a program anyway isn't read from either.
    if (e.key === 'core.alternaterefscommand') throw refuse(`the repository at ${gitDir} names a program in its git config (${e.key}).`);
    if (push && RUNS_ON_PUSH.test(e.key)) throw refuse(`the repository at ${gitDir} names a program in its git config (${e.key}), which a push would run.`);
    if (!localKeyOk(e.key)) throw refuse(`the repository at ${gitDir} has a git setting (${e.key}) Threadbear hasn't been checked for; move it to your global git config.`);
  }
  if (!push) return;
  // A push writes into the target as its own config says (receive.* can
  // check the pushed tree out, through git-lfs and the target's lfs.*
  // programs, into a work tree core.worktree puts anywhere: Gemini's second
  // break-it review, 28 Nov 2026). So a local push target is a bare
  // repository, of its own (not a linked worktree's), with only the plainest
  // settings, rather than a list of the dangerous ones.
  const local = parseConfigListBytes(listing).filter((e) => e.scope !== 'command' && !TRUSTED_SCOPES.has(e.scope));
  const bare = local.filter((e) => e.key === 'core.bare').pop();
  if (!bare || !/^(true|yes|on|1)$/i.test(bare.value) || fs.existsSync(path.join(gitDir, 'commondir'))) throw refuse(`it pushes only to a bare repository on this machine, and ${gitDir} isn't one.`);
  for (const e of local) if (!PUSH_TARGET_KEYS.test(e.key)) throw refuse(`the push target ${gitDir} has a git setting (${e.key}) beyond what a plain bare repository has.`);
  let common = gitDir;
  try {
    common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  for (const hooks of new Set([path.join(common, 'hooks'), path.join(gitDir, 'hooks')])) {
    let names: string[] = [];
    try { names = fs.readdirSync(hooks); } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
    const live = names.filter((n) => !n.endsWith('.sample'));
    if (live.length) throw refuse(`the repository at ${gitDir} has hooks (${live.slice(0, 3).join(', ')}), which a push to it would run.`);
  }
}

// Each transfer command's options: the ones that take a value as the next
// word (so the value is never read as the repository), and the ones that
// take none, by pattern. Any other option and the command can't be read for
// sure: then every repository it could reach counts as the one used.
type Grammar = { values: ReadonlySet<string>; flags: RegExp };
const INLINE = '[\\s\\S]*';
const TRANSFER_GRAMMAR: Record<string, Grammar> = {
  fetch: {
    values: new Set(['--depth', '--deepen', '--shallow-since', '--shallow-exclude', '--refmap', '--negotiation-tip', '-j', '--jobs', '--submodule-prefix', '--recurse-submodules-default', '-o', '--server-option', '--filter']),
    flags: new RegExp(`^(-[qvafktpPnu46]+|--(quiet|verbose|append|atomic|force|keep|no-tags|tags|prune|prune-tags|no-prune|no-prune-tags|dry-run|no-write-fetch-head|write-fetch-head|unshallow|update-shallow|update-head-ok|progress|no-progress|ipv4|ipv6|no-recurse-submodules|recurse-submodules(=[a-z-]+)?|show-forced-updates|no-show-forced-updates|set-upstream|all|multiple|no-auto-maintenance|no-auto-gc|refetch|(depth|deepen|shallow-since|shallow-exclude|refmap|negotiation-tip|jobs|submodule-prefix|recurse-submodules-default|server-option|filter)=${INLINE}))$`),
  },
  push: {
    values: new Set(['-o', '--push-option']),
    flags: new RegExp(`^(-[qvnfdu46]+|--(quiet|verbose|all|branches|mirror|tags|follow-tags|no-follow-tags|atomic|no-atomic|dry-run|porcelain|delete|force|force-if-includes|no-force-if-includes|set-upstream|thin|no-thin|prune|no-verify|verify|progress|no-progress|ipv4|ipv6|no-signed|signed(=[a-z-]+)?|force-with-lease(=${INLINE})?|no-force-with-lease|recurse-submodules=[a-z-]+|no-recurse-submodules|push-option=${INLINE}))$`),
  },
  'ls-remote': {
    values: new Set(['--sort', '-o', '--server-option']),
    flags: new RegExp(`^(-[htqb]+|--(heads|tags|branches|refs|quiet|exit-code|get-url|symref|(sort|server-option)=${INLINE}))$`),
  },
  clone: {
    values: new Set(['-c', '--config', '-o', '--origin', '-b', '--branch', '--reference', '--reference-if-able', '--depth', '--template', '--separate-git-dir', '--filter', '-j', '--jobs', '--shallow-since', '--shallow-exclude', '--server-option', '--bundle-uri', '--revision']),
    flags: new RegExp(`^(-[lsqvn]+|--(local|no-local|shared|no-hardlinks|quiet|verbose|progress|no-checkout|bare|mirror|sparse|single-branch|no-single-branch|no-tags|tags|recurse-submodules(=${INLINE})?|shallow-submodules|no-shallow-submodules|remote-submodules|no-remote-submodules|also-filter-submodules|reject-shallow|no-reject-shallow|dissociate|(depth|config|origin|branch|reference|reference-if-able|template|separate-git-dir|filter|jobs|shallow-since|shallow-exclude|server-option|bundle-uri|revision)=${INLINE}))$`),
  },
};

// The program git runs as a local transport's server is Threadbear's
// (serverCommand), so a caller never names one: every spelling git takes is
// refused (an abbreviation of --upload-pack, --receive-pack or --exec too,
// and clone's -u, attached or in a group), rather than taken out, which a
// second spelling got past (Gemini's fourth break-it review, 28 Nov 2026).
function namesAServer(sub: string, arg: string): boolean {
  // --no-upload-pack (and its abbreviations) puts git's own back.
  const long = /^--(?:no-)?([a-z-]+)(=|$)/.exec(arg)?.[1];
  if (long && ['upload-pack', 'receive-pack', 'exec'].some((o) => o.startsWith(long))) return true;
  return sub === 'clone' && /^-[^-]*u/.test(arg);
}

const PATH_OPTIONS = new Set(['--reference', '--reference-if-able']);
type TransferWords = { positionals: string[]; values: string[]; known: boolean; all: boolean; multiple: boolean };
function readTransfer(sub: string, rest: readonly string[]): TransferWords {
  const grammar = TRANSFER_GRAMMAR[sub]!;
  const out: TransferWords = { positionals: [], values: [], known: true, all: false, multiple: false };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--') { out.positionals.push(...rest.slice(i + 1)); break; }
    if (!a.startsWith('-') || a === '-') { out.positionals.push(a); continue; }
    if (namesAServer(sub, a)) throw refuse(`it picks the program a transfer's server runs itself, so it doesn't take ${JSON.stringify(a.slice(0, 80))}.`);
    // push's --repo stands in for the repository only when none is named
    // after it; nothing here uses it, so it's refused rather than read
    // (Gemini's fifth break-it review).
    const long = /^--(?:no-)?([a-z-]+)(=|$)/.exec(a)?.[1];
    if (sub === 'push' && long && long.length >= 3 && 'repo'.startsWith(long)) throw refuse("it doesn't take push's --repo; name the repository instead.");
    // Only a value that names a repository (clone's --reference) is read as
    // one: --force-with-lease=x:<oid> or -o k:v isn't a path (Gemini's final review).
    if (grammar.values.has(a)) { if (i + 1 < rest.length) { i++; if (PATH_OPTIONS.has(a)) out.values.push(rest[i]!); } continue; }
    if (a === '--all') out.all = true;
    if (a === '--multiple') out.multiple = true;
    const eq = a.indexOf('=');
    if (eq > 0 && PATH_OPTIONS.has(a.slice(0, eq))) out.values.push(a.slice(eq + 1));
    if (!grammar.flags.test(a)) out.known = false;
  }
  return out;
}

// The server a local transport starts, as a fixed command of Threadbear's:
// git gives a local upload-pack or receive-pack none of its -c settings, so
// it would read only the repository's own config (its hooks, an
// alternateRefsCommand, a lazy fetch). git runs this value with the shell,
// the repository's path after it; settings given to that git beat the
// repository's (Gemini's third break-it review of 187/188, 28 Nov 2026,
// checked on git 2.54 and 2.43).
function serverCommand(kind: 'upload-pack' | 'receive-pack'): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const settings = ['core.alternateRefsCommand=true', `core.hooksPath=${noHooksPath()}`, 'core.fsmonitor=false', 'protocol.allow=never', ...PROTOCOL_NAMES.map((p) => `protocol.${p}.allow=never`), ...(kind === 'receive-pack' ? ['receive.autogc=false', 'receive.denyCurrentBranch=refuse', 'receive.updateServerInfo=false'] : [])];
  return ['GIT_ALLOW_PROTOCOL=none', 'GIT_NO_LAZY_FETCH=1', q(gitProgram().replace(/\\/g, '/')), ...settings.flatMap((v) => ['-c', q(v)]), kind].join(' ');
}

// Whether git reaches `address` through a local transport (as
// url_is_local_not_ssh, file:// included).
function localAddress(address: string): boolean {
  if (/^file:\/\//i.test(address)) return true;
  const colon = address.indexOf(':'), slash = address.search(/[\\/]/);
  // Git for Windows takes any drive letter as local, C:evil included.
  return colon < 0 || (slash >= 0 && slash < colon) || /^[A-Za-z]:/.test(address);
}

// Works out the repositories git will use for the transfer, as git picks
// them: the one named (a remote's name when there is such a remote, as git
// resolves it, a path or address if not), or with none named the branch's
// (pushRemote, remote.pushDefault, its remote, else origin, each a remote's
// name first: Gemini's fourth break-it review found "origin" read as a
// path); --all every remote. Checks each on this machine, and says whether
// they're local (so their server runs serverCommand) or across the network;
// both at once is refused. A command it can't read for sure counts every
// repository it could reach as used, and leans to local.
function* checkTransfer(dir: string, sub: string, rest: readonly string[], entries: readonly ConfigEntry[], env: NodeJS.ProcessEnv, timeoutMs: number): Generator<GitStep, 'local' | 'network' | undefined, UntrustedGitResult> {
  const read = readTransfer(sub, rest);
  const step = (args: string[]): GitStep => ({ cwd: dir, args: [...LISTING_GIT_CONFIG, '-C', dir, ...args], env, timeoutMs });
  // An empty value is unset, as git's remote.c takes it.
  const last = (key: string) => entries.filter((e) => e.key === key).pop()?.value || undefined;
  const remoteNames = function* (): Generator<GitStep, string[], UntrustedGitResult> {
    const names = new Set(entries.flatMap((e) => /^remote\.([\s\S]+)\.(url|pushurl)$/.exec(e.key)?.[1] ?? []));
    const common = yield step(['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (common.ok) {
      for (const kind of ['remotes', 'branches']) {
        let files: string[] = [];
        try { files = fs.readdirSync(path.join(common.stdout.trim(), kind)); } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
        if (files.length > 64) throw refuse(`this repo has too many remotes in .git/${kind} to check.`);
        for (const f of files) names.add(f);
      }
    }
    return [...names];
  };
  // A remote's addresses as git resolves them (url rewriting, .git/remotes),
  // or the word itself when no remote has that name (or it has a slash,
  // which no remote's name has).
  const resolve = function* (spec: string, push: boolean): Generator<GitStep, string[], UntrustedGitResult> {
    if (/[\\/]/.test(spec)) return [spec];
    const urls = yield step(['remote', 'get-url', ...(push ? ['--push'] : []), '--all', '--', spec]);
    const got = urls.ok ? urls.stdout.split('\n').filter(Boolean) : [];
    return got.length ? got : [spec];
  };
  const branchDefault = function* (push: boolean): Generator<GitStep, string, UntrustedGitResult> {
    const head = yield step(['symbolic-ref', '-q', '--short', 'HEAD']);
    const branch = head.ok ? head.stdout.trim() : '';
    const remote = branch ? last(`branch.${branch}.remote`) : undefined;
    const pushRemote = branch ? last(`branch.${branch}.pushremote`) : undefined;
    // With none set, the only remote there is, or else origin (remote.c's
    // remotes_remote_for_branch counts each remote.<name>.* it read).
    const configured = new Set(entries.flatMap((e) => /^remote\.([\s\S]+)\.[^.]+$/.exec(e.key)?.[1] ?? []));
    const fallback = configured.size === 1 ? [...configured][0]! : 'origin';
    return (push ? pushRemote ?? last('remote.pushdefault') ?? remote : remote) ?? fallback;
  };
  const push = sub === 'push';
  let specs: string[];
  if (sub === 'clone') specs = read.positionals.slice(0, 1);
  else if (sub === 'fetch' && read.all) specs = yield* remoteNames();
  else if (sub === 'fetch' && read.multiple) specs = read.positionals.length ? read.positionals : yield* remoteNames();
  // No repository named: git uses exactly one, the branch's choice
  // (fetch.all is pinned off and remote groups refused, so nothing else can
  // add more); a name no remote has is git's own error.
  else specs = [read.positionals[0] ?? (yield* branchDefault(push))];
  if (!read.known) {
    // Every repository the command could reach: each word, each remote and
    // the branch's choice.
    specs = [...new Set([...specs, ...read.positionals, ...(yield* remoteNames()), yield* branchDefault(push)])];
  }
  const repos: string[] = [];
  for (const spec of specs) repos.push(...(sub === 'clone' ? [spec] : yield* resolve(spec, push)));
  if (!read.known) for (const spec of specs) if (!/[\\/]/.test(spec) && sub !== 'clone') repos.push(...(yield* resolve(spec, !push)));
  // A relative address is read from the repository's top folder (or .git,
  // when bare) as git chdirs there, as well as the command's folder.
  const roots = [dir];
  for (const ask of [['rev-parse', '--show-toplevel'], ['rev-parse', '--absolute-git-dir']]) {
    const r = yield step(ask);
    if (r.ok && r.stdout.trim()) roots.push(r.stdout.trim());
  }
  const home = env.HOME || os.homedir();
  const found = new Map<string, boolean>(); // git dir: checked as a push target
  for (const r of repos) for (const d of localGitDirs(roots, r, home)) found.set(d, push || !!found.get(d));
  // An option's value naming a repository (clone's --reference) is read as a source.
  for (const v of read.values) for (const d of localGitDirs(roots, v, home)) if (!found.has(d)) found.set(d, false);
  if (found.size > 64) throw refuse('the command could reach too many repositories on this machine to check.');
  for (const [d, asTarget] of found) {
    const listed = yield { cwd: dir, args: [...LISTING_GIT_CONFIG, `--git-dir=${d}`, 'config', '--list', '--show-scope', '-z'], env, timeoutMs, bytes: true };
    if (!listed.ok || !listed.bytes) throw refuse(`it couldn't read the git config of the repository at ${d}.`);
    checkEndpoint(d, listed.bytes, asTarget);
  }
  const local = repos.filter(localAddress).length;
  if (local && local < repos.length) throw refuse('the repositories it could reach are both on this machine and across the network; name the one to use.');
  return repos.length === 0 ? undefined : local ? 'local' : 'network';
}

function execGit(dir: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number, bytes = false, input?: string | Buffer): Promise<UntrustedGitResult> {
  return new Promise((resolve) => {
    const child = execFile(gitProgram(), args as string[], { cwd: dir, env, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL', encoding: 'buffer' }, (err, stdout, stderr) => {
      const e = err as { code?: unknown; signal?: unknown } | null;
      const code = !e ? 0 : typeof e.code === 'number' ? e.code : e.signal ? -1 : 1;
      const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout));
      resolve({ ok: !err, code, stdout: out.toString('utf8'), stderr: String(stderr), ...(bytes ? { bytes: out } : {}) });
    });
    child.stdin?.end(input);
  });
}

function execGitSync(dir: string, args: readonly string[], env: NodeJS.ProcessEnv, timeoutMs: number, bytes = false, input?: string | Buffer): UntrustedGitResult {
  try {
    const out = execFileSync(gitProgram(), args as string[], { cwd: dir, env, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs, killSignal: 'SIGKILL', input, stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true, code: 0, stdout: out.toString('utf8'), stderr: '', ...(bytes ? { bytes: out } : {}) };
  } catch (error) {
    const e = error as { status?: number; stdout?: Buffer; stderr?: Buffer; message?: string };
    return { ok: false, code: e.status ?? -1, stdout: e.stdout?.toString('utf8') ?? '', stderr: e.stderr?.toString('utf8') || e.message || 'git failed' };
  }
}

// What the update clone writes into its own .git/info/attributes (update.ts)
// to check out main's files exactly as committed: every attribute that
// changes the bytes written, unset for every path, over any .gitattributes.
// The one content of info/attributes untrustedGit takes.
export const NEUTRAL_ATTRIBUTES = '* -text -eol -crlf -ident -filter -working-tree-encoding\n';
const WRITES_FILES = new Set(['merge', 'merge-tree', 'rebase', 'cherry-pick', 'checkout', 'reset', 'commit', 'worktree', 'checkout-index', 'read-tree', 'add']);
const MODULE_BLOBS = [':0:.gitmodules', ':1:.gitmodules', ':2:.gitmodules', ':3:.gitmodules', 'HEAD:.gitmodules', 'MERGE_HEAD:.gitmodules', 'CHERRY_PICK_HEAD:.gitmodules', 'REBASE_HEAD:.gitmodules'];

// Everything untrustedGit and untrustedGitRunSync do before the command:
// read the repo's config (the same variables as the command, so it reads
// the config the command will), the checks above, and the -c settings. Ends
// with the command to run, or the failure to return instead.
function* prepare(dir: string, args: readonly string[], opts: UntrustedGitOptions): Generator<GitStep, { run: GitStep } | { result: UntrustedGitResult }, UntrustedGitResult> {
  // An empty GIT_ASKPASS stops git asking any program, core.askPass too.
  // No lazy fetch even for a fetch: a local origin's upload-pack inherits
  // it, and would otherwise fetch what it lacks through its own config.
  const env: NodeJS.ProcessEnv = { ...untrustedGitEnv(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1', GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':', ...opts.env, GIT_NO_REPLACE_OBJECTS: '1', GIT_GRAFT_FILE: os.devNull, GIT_ATTR_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: opts.network === 'remote' ? 'https:ssh:file' : opts.network === 'bundle' ? 'file' : 'none' };
  // A clone or fetch of a big repo can take a while.
  const timeout = opts.timeoutMs ?? (opts.network === 'remote' ? 30 * 60_000 : 5 * 60_000);
  const extra: string[] = [];
  let at = 0;
  while (at < args.length) {
    if (args[at] === '-c' && args[at + 1]) { extra.push('-c', args[at + 1]!); at += 2; }
    else if (/^--attr-source=[0-9a-f]{40,64}$/.test(args[at]!) || args[at]!.startsWith('--work-tree=')) extra.push(args[at++]!);
    else break;
  }
  const sub = args[at];
  const rest = args.slice(at + 1);
  // Commands used by moves, worktrees, format replay and deployment. Each
  // is covered by the configuration and per-command overrides below. Stash
  // and submodule commands remain out: they have their own execution paths.
  if (!sub || !SUBCOMMANDS.has(sub)) return { result: { ok: false, code: 1, stdout: '', stderr: `untrustedGit doesn't run git ${[sub, sub === 'worktree' ? rest[0] : undefined].filter(Boolean).join(' ')}: nobody has looked at what a repo's config could make it run.` } };
  const started = Date.now();
  const short = Math.min(10_000, timeout);
  const listEnv: NodeJS.ProcessEnv = { ...untrustedGitEnv(), ...opts.env, ...LISTING_GIT_ENV };
  const listed = yield { cwd: dir, args: [...LISTING_GIT_CONFIG, '-C', dir, 'config', '--list', '--show-scope', '-z'], env: listEnv, timeoutMs: short, bytes: true };
  // Outside a repo it still lists the owner's own config (empty is 0 too);
  // a config git can't parse fails the listing, and so this.
  if (!listed.ok) return { result: { ok: false, code: listed.code || 1, stdout: '', stderr: `couldn't read the repo's git config: ${listed.stderr.trim() || `git config exited ${listed.code}`}` } };
  let config: string[];
  let transport: 'local' | 'network' | undefined;
  try {
    const entries = parseConfigListBytes(listed.bytes ?? Buffer.from(listed.stdout));
    // A repo's own include.path names a file the command itself can rewrite
    // (a checkout), which a git it starts part-way (rebase's am) reads again
    // after these settings were read and switched off (Gemini's fourth
    // break-it review). The release check (upstream.ts) checks nothing out,
    // and keeps taking such a fork's releases with nothing included running.
    for (const e of entries) if (!TRUSTED_SCOPES.has(e.scope) && /^include\./i.test(e.key)) throw new Error(`This repo's own git config includes another file (${e.key}). Move it to your global git config before Threadbear runs git here.`);
    // A remote's server program is never the repo's to name: a fetch git
    // starts by itself (a partial clone's lazy fetch) doesn't get the
    // command line's (Gemini's fifth break-it review).
    for (const e of entries) if (!TRUSTED_SCOPES.has(e.scope) && /^remote\.[\s\S]+\.(uploadpack|receivepack)$/.test(e.key)) throw new Error(`This repo's git setting (${e.key}) names a remote's server program; it must move to your global git config before Threadbear runs git here.`);
    const partial = partialCloneProblem(entries);
    if (partial) throw new Error(partial);
    if (promisorNames(entries).size) {
      // A fetch git starts by itself takes a remote from .git/remotes or
      // .git/branches by name: none in a partial clone.
      const common = yield { cwd: dir, args: [...LISTING_GIT_CONFIG, '-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], env: listEnv, timeoutMs: short };
      if (!common.ok) throw new Error("Cannot find this partial clone's git folder safely.");
      for (const kind of ['remotes', 'branches']) {
        let files: string[] = [];
        try { files = fs.readdirSync(path.join(common.stdout.trim(), kind)); } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
        if (files.length) throw new Error(`This partial clone has remotes defined in .git/${kind}, which a fetch git starts by itself could use; Threadbear refused to run git here.`);
      }
    }
    yield* checkWorktree(dir, entries, listEnv);
    // .git/info/attributes beats every other attributes source and has no
    // setting to switch it off: merge=union or merge=binary there settles a
    // conflict by itself, ident or working-tree-encoding change the bytes
    // written (Gemini's sixth break-it review). A command that writes files
    // is refused while it has anything in it (the linked worktree's shared
    // one too, as --git-path finds it).
    if (WRITES_FILES.has(sub)) {
      const at = yield { cwd: dir, args: [...LISTING_GIT_CONFIG, '-C', dir, 'rev-parse', '--git-path', 'info/attributes'], env: listEnv, timeoutMs: short };
      if (!at.ok) throw new Error("Cannot find this repository's info/attributes safely.");
      // Only a plain empty file is nothing: a fifo would hang git as it
      // opened it, and a link could point at anything.
      let st: fs.Stats | undefined;
      try { st = fs.lstatSync(path.resolve(dir, at.stdout.trim())); } catch (e) { if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e; }
      if (st && (!st.isFile() || (st.size > 0 && fs.readFileSync(path.resolve(dir, at.stdout.trim()), 'utf8') !== NEUTRAL_ATTRIBUTES))) throw new Error("This repository has its own .git/info/attributes, which would change how Threadbear's git merges and writes files; empty or remove it first.");
    }
    if (TRANSFERS.has(sub)) transport = yield* checkTransfer(dir, sub, rest, entries, listEnv, short);
    if (['merge', 'rebase', 'commit', 'cherry-pick', 'checkout', 'reset'].includes(sub)) {
      const blobConfig = (spec: string): GitStep => ({ cwd: dir, args: [...LISTING_GIT_CONFIG, '-C', dir, 'config', '--no-includes', '--blob', spec, '--list', '-z'], env, timeoutMs: short, bytes: true });
      if (['rebase', 'merge', 'cherry-pick'].includes(sub)) {
        const baseConfig = repoProofConfig(entries);
        const revCheck = yield { cwd: dir, args: [...baseConfig, '-C', dir, 'cat-file', '--batch-check=%(objecttype) %(objectname)'], env, timeoutMs: short, input: moduleRevCandidates(rest).map((r) => `${r}^{commit}\n`).join('') };
        const extraCommits = revCheck.ok ? revCheck.stdout.split('\n').flatMap((l) => (/^commit ([0-9a-f]{40,64})$/.exec(l)?.[1] ? [l.slice(7)] : [])) : [];
        const history = yield { cwd: dir, args: [...baseConfig, '-C', dir, 'log', '-m', '--root', '--no-renames', '--no-follow', '--raw', '--no-abbrev', '--format=', '--all', ...extraCommits, '--', ':(top,literal).gitmodules'], env, timeoutMs: timeout };
        if (!history.ok) throw new Error('Cannot inspect submodule history safely.');
        for (const oid of moduleHistoryBlobs(history.stdout)) {
          const m = yield blobConfig(oid);
          if (m.ok && m.bytes) entries.push(...moduleEntries(m.bytes));
        }
      }
      const root = yield { cwd: dir, args: [...LISTING_GIT_CONFIG, '-C', dir, 'rev-parse', '--show-toplevel'], env, timeoutMs: short };
      const modules = root.ok ? modulesFile(root.stdout.trim()) : undefined;
      if (modules) {
        const m = yield { cwd: dir, args: [...LISTING_GIT_CONFIG, '-C', dir, 'config', '--no-includes', '--file', modules, '--list', '-z'], env, timeoutMs: short, bytes: true };
        if (!m.ok || !m.bytes) throw new Error('Cannot read .gitmodules safely.');
        entries.push(...moduleEntries(m.bytes));
      }
      for (const blob of [...MODULE_BLOBS, ...rest.filter((a) => !a.startsWith('-') && !a.includes(':')).map((a) => `${a}:.gitmodules`)]) {
        const m = yield blobConfig(blob);
        if (m.ok && m.bytes) entries.push(...moduleEntries(m.bytes));
      }
    }
    // A transfer that's local doesn't use the repo's http.* settings (a big
    // repo's http.postBuffer), so only a network one is refused for them.
    // A local transfer needs only the file transport, so that's all it's
    // allowed (a lazy fetch over https included: Gemini's final review), and
    // the repo's http.* settings, which then reach nothing, don't stop it (a
    // big repo's http.postBuffer).
    if (transport === 'local') env.GIT_ALLOW_PROTOCOL = 'file';
    config = transport === 'local' ? repoProofConfig(entries.filter((e) => TRUSTED_SCOPES.has(e.scope) || !/^http\./.test(e.key)), 'bundle') : repoProofConfig(entries, opts.network);
  } catch (e) {
    return { result: { ok: false, code: 1, stdout: '', stderr: e instanceof Error ? e.message : String(e) } };
  }
  // A local transport's server is Threadbear's own command (serverCommand),
  // in place of any the caller named; across the network, git's own.
  const server = sub === 'push' ? 'receive-pack' : 'upload-pack';
  const pack = !TRANSFERS.has(sub) ? [] : transport === 'local' ? [`--${server}=${serverCommand(server)}`] : opts.network ? [`--${server}=git-${server}`] : [];
  const control = ['merge', 'rebase', 'cherry-pick'].includes(sub) && rest.some((a) => ['--abort', '--quit', '--continue', '--skip', '--edit-todo', '--show-current-patch'].includes(a));
  const inside = control ? [] : (NO_SUBMODULES[sub] ?? []);
  // What's left of the caller's time, when it gave one.
  const left = opts.timeoutMs === undefined ? timeout : Math.max(1, timeout - (Date.now() - started));
  return { run: { cwd: dir, args: [...config, ...extra, '-C', dir, sub, ...inside, ...pack, ...rest], env, timeoutMs: left, ...(opts.bytes ? { bytes: true } : {}), ...(opts.input !== undefined ? { input: opts.input } : {}) } };
}

// `git -C dir ...args` as above. A config git can't read, or one with a
// setting -c can't reach, runs nothing and fails.
export async function untrustedGit(dir: string, args: readonly string[], opts: UntrustedGitOptions = {}): Promise<UntrustedGitResult> {
  const steps = prepare(dir, args, opts);
  let step = steps.next();
  while (!step.done) {
    const s = step.value;
    step = steps.next(await execGit(s.cwd, s.args, s.env, s.timeoutMs, s.bytes, s.input));
  }
  if ('result' in step.value) return step.value.result;
  const s = step.value.run;
  return execGit(s.cwd, s.args, s.env, s.timeoutMs, s.bytes, s.input);
}

export function untrustedGitRunSync(dir: string, args: readonly string[], opts: UntrustedGitOptions = {}): UntrustedGitResult {
  const steps = prepare(dir, args, opts);
  let step = steps.next();
  while (!step.done) {
    const s = step.value;
    step = steps.next(execGitSync(s.cwd, s.args, s.env, s.timeoutMs, s.bytes, s.input));
  }
  if ('result' in step.value) return step.value.result;
  const s = step.value.run;
  return execGitSync(s.cwd, s.args, s.env, s.timeoutMs, s.bytes, s.input);
}

// What untrustedGit runs. `git submodule` isn't one: it runs git in each
// submodule with that submodule's own config. check-ignore reads ignore
// rules only (the build cache cleanup asks it what a worktree ignores).
const SUBCOMMANDS = new Set(['add', 'checkout', 'checkout-index', 'check-ignore', 'cherry', 'cherry-pick', 'clean', 'commit', 'config', 'diff-tree', 'hash-object', 'log', 'ls-tree', 'merge', 'merge-tree', 'push', 'rebase', 'reflog', 'show', 'var', 'update-index', 'branch', 'bundle', 'cat-file', 'clone', 'commit-tree', 'diff', 'diff-files', 'diff-index', 'fetch', 'for-each-ref', 'fsck', 'ls-files', 'ls-remote', 'merge-base', 'read-tree', 'remote', 'reset', 'rev-list', 'rev-parse', 'status', 'symbolic-ref', 'update-ref', 'worktree', 'write-tree']);

// A submodule is a repo of its own, with its own config (.git/modules/<name>/
// config, or a .git inside it), and the settings above only switch off what
// the outer repo's config names. git starts another git inside a submodule to
// see whether it changed (status, diff) or to fetch or check it out too, and
// that one runs the filters, fsmonitor or sshCommand the submodule's config
// names: `git status` ran a submodule's `filter.<name>.clean` through
// untrustedGit (security review, 11 Nov 2026). So these never look inside
// one. Only the command line beats a repo's own `submodule.<name>.ignore` or
// `fetchRecurseSubmodules` (-c diff.ignoreSubmodules doesn't), so it's a flag
// on each command that would. A submodule shows as its commit, as if clean.
// And for a diff, git's own diff: diff.external is blank (ALWAYS), which
// a diff asked for its patch would try to run and fail.
const IGNORE: readonly string[] = ['--ignore-submodules=all'];
const DIFF: readonly string[] = [...IGNORE, '--no-ext-diff'];
const NO_RECURSE: readonly string[] = ['--no-recurse-submodules'];
const NO_SUBMODULES: Record<string, readonly string[]> = {
  status: IGNORE,
  merge: ['--no-verify-signatures', '--no-gpg-sign'],
  rebase: ['--no-gpg-sign'],
  commit: ['--no-gpg-sign'],
  'cherry-pick': ['--no-gpg-sign'],
  push: ['--recurse-submodules=no', '--signed=false'],
  show: ['--no-show-signature', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'],
  log: ['--no-show-signature', '--no-ext-diff', '--no-textconv', '--ignore-submodules=all'],
  'diff-tree': DIFF,
  checkout: NO_RECURSE,
  diff: DIFF,
  'diff-index': DIFF,
  'diff-files': DIFF,
  fetch: NO_RECURSE,
  clone: [...NO_RECURSE, '--template='],
  reset: NO_RECURSE,
  'read-tree': NO_RECURSE,
  'ls-files': NO_RECURSE,
};

// Verify only the snapshots about to be read, in bounded batches. Merge
// verification also checks ancestor commit headers and merge-base snapshots,
// without hashing every historical version of every file.
function* objectChecks(roots: readonly string[], history: boolean): Generator<string[], void, UntrustedGitResult> {
  const ids: string[] = [];
  for (const root of roots) {
    const r = yield ['rev-parse', '--verify', '--end-of-options', `${root}^{commit}`];
    if (!r.ok || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(r.stdout.trim())) throw new Error('Cannot resolve the release commit for object verification.');
    ids.push(r.stdout.trim());
  }
  const snapshots = [...ids];
  if (history && ids.length > 1) {
    const pending: string[][] = [];
    const addPairs = (group: readonly string[]) => { for (let i = 0; i < group.length; i++) for (let j = i + 1; j < group.length; j++) pending.push([group[i]!, group[j]!]); };
    addPairs(ids);
    const seen = new Set<string>(), discovered = new Set<string>();
    while (pending.length) {
      const pair = pending.pop()!.sort(), key = pair.join(' ');
      if (seen.has(key)) continue; seen.add(key);
      const r = yield ['merge-base', '--all', ...pair];
      if (!r.ok && r.code !== 1) throw new Error('Cannot verify the merge bases.');
      const bases = r.stdout.trim().split('\n').filter(Boolean);
      snapshots.push(...bases);
      // Recursive/criss-cross merging reads the older bases of its bases.
      // Visit those too, without scanning every historical file snapshot.
      for (const base of bases) {
        if (!discovered.has(base)) { for (const old of discovered) pending.push([old, base]); discovered.add(base); }
      }
      if (seen.size > 10_000) throw new Error('The recursive merge-base graph is too large.');
    }
  }
  let commits = ids;
  if (history) {
    const r = yield ['rev-list', ...ids];
    if (!r.ok) throw new Error('Cannot list the release history for verification.');
    commits = r.stdout.trim().split('\n').filter(Boolean);
  }
  const r = yield ['rev-list', '--objects', '--no-object-names', '--no-walk', ...snapshots];
  if (!r.ok) throw new Error('Cannot list the release snapshot for verification.');
  const objects = [...new Set([...commits, ...r.stdout.trim().split('\n').filter(Boolean)])];
  if (objects.length > 200_000 || objects.some((id) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(id))) throw new Error('The release object list is invalid or too large.');
  const verified = new Map<string, string>();
  const refs: { id: string; type: string }[] = [];
  const treesNeeded = new Set(snapshots);
  for (let at = 0; at < objects.length; at += 32) {
    const batch = objects.slice(at, at + 32);
    const r = yield ['cat-file', '--batch', batch.join('\n') + '\n'];
    if (!r.ok || !r.bytes) throw new Error('Cannot read the release objects for verification.');
    const bytes = r.bytes; let pos = 0;
    for (const expected of batch) {
      const nl = bytes.indexOf(10, pos);
      const header = bytes.subarray(pos, nl).toString('ascii');
      const m = /^([0-9a-f]+) (commit|tree|blob|tag) (\d+)$/.exec(header);
      if (nl < pos || !m || m[1] !== expected) throw new Error('Malformed release object batch.');
      const size = Number(m[3]), end = nl + 1 + size;
      if (!Number.isSafeInteger(size) || end >= bytes.length || bytes[end] !== 10) throw new Error('Truncated release object batch.');
      const data = bytes.subarray(nl + 1, end); pos = end + 1;
      const got = createHash(expected.length === 40 ? 'sha1' : 'sha256').update(`${m[2]} ${size}\0`).update(data).digest('hex');
      if (got !== expected) throw new Error(`The release object ${expected} does not hash to its ID.`);
      verified.set(expected, m[2]!);
      if (m[2] === 'commit') {
        const head = data.toString('utf8').split('\n\n', 1)[0]!;
        const tree = /^tree ([0-9a-f]+)$/m.exec(head)?.[1];
        if (!tree) throw new Error('A release commit has no tree.');
        if (treesNeeded.has(expected)) refs.push({ id: tree, type: 'tree' });
        if (history) for (const parent of head.matchAll(/^parent ([0-9a-f]+)$/gm)) refs.push({ id: parent[1]!, type: 'commit' });
      } else if (m[2] === 'tree') {
        let i = 0;
        while (i < data.length) {
          const space = data.indexOf(32, i), nul = data.indexOf(0, space + 1), next = nul + 1 + expected.length / 2;
          if (space < i || nul < space || next > data.length) throw new Error('Malformed release tree.');
          const mode = data.subarray(i, space).toString('ascii');
          if (mode !== '160000') refs.push({ id: data.subarray(nul + 1, next).toString('hex'), type: mode === '40000' || mode === '040000' ? 'tree' : 'blob' });
          i = next;
        }
      }
    }
    if (pos !== bytes.length) throw new Error('Extra bytes in release object batch.');
  }
  for (const ref of refs) if (verified.get(ref.id) !== ref.type) throw new Error(`A release ${ref.type} object was not verified: ${ref.id}`);
}

export async function verifyGitObjects(dir: string, roots: readonly string[] = ['HEAD'], history = false): Promise<void> {
  const checks = objectChecks(roots, history);
  let step = checks.next();
  while (!step.done) {
    const args = step.value, input = args[0] === 'cat-file' ? args.pop() : undefined;
    step = checks.next(await untrustedGit(dir, args, { input, bytes: true }));
  }
}
export function verifyGitObjectsSync(dir: string, roots: readonly string[] = ['HEAD'], history = false): void {
  const checks = objectChecks(roots, history);
  let step = checks.next();
  while (!step.done) {
    const args = step.value, input = args[0] === 'cat-file' ? args.pop() : undefined;
    step = checks.next(untrustedGitRunSync(dir, args, { input, bytes: true }));
  }
}

// A byte read used as executable formatter configuration must prove its
// complete commit/tree path, not just trust cat-file's object filename.
export async function verifiedGitBlob(dir: string, spec: string): Promise<Buffer | undefined> {
  const colon = spec.indexOf(':');
  if (colon < 1) throw new Error('A verified blob needs an object and path.');
  const parts = spec.slice(colon + 1).split('/');
  if (parts.some((p) => !p || p === '.' || p === '..')) throw new Error('Invalid verified blob path.');
  const resolved = await untrustedGit(dir, ['rev-parse', '--verify', '--end-of-options', spec.slice(0, colon)]);
  if (!resolved.ok) return undefined;
  let id = resolved.stdout.trim();
  const read = async (type: string, oid: string): Promise<Buffer | undefined> => {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(oid)) throw new Error('Invalid verified object ID.');
    const r = await untrustedGit(dir, ['cat-file', type, oid], { bytes: true });
    if (!r.ok || !r.bytes) return undefined;
    const got = createHash(oid.length === 40 ? 'sha1' : 'sha256').update(`${type} ${r.bytes.length}\0`).update(r.bytes).digest('hex');
    if (got !== oid) throw new Error(`The release object ${oid} does not hash to its ID.`);
    return r.bytes;
  };
  let tree: Buffer | undefined;
  for (let count = 0; count < 16; count++) {
    const t = await untrustedGit(dir, ['cat-file', '-t', id]);
    if (!t.ok) return undefined;
    const type = t.stdout.trim(), data = await read(type, id);
    if (!data) return undefined;
    if (type === 'tag') { id = /^object ([0-9a-f]+)\n/.exec(data.toString('utf8'))?.[1] ?? ''; continue; }
    if (type === 'commit') {
      id = /^tree ([0-9a-f]+)\n/.exec(data.toString('utf8'))?.[1] ?? '';
      tree = await read('tree', id);
    } else if (type === 'tree') tree = data;
    break;
  }
  for (const [index, part] of parts.entries()) {
    if (!tree) return undefined;
    let at = 0, found: { id: string; dir: boolean } | undefined;
    while (at < tree.length) {
      const space = tree.indexOf(32, at), nul = tree.indexOf(0, space + 1), end = nul + 1 + id.length / 2;
      if (space < at || nul < space || end > tree.length) throw new Error('Malformed verified tree.');
      if (tree.subarray(space + 1, nul).equals(Buffer.from(part))) found = { id: tree.subarray(nul + 1, end).toString('hex'), dir: tree.subarray(at, space).toString('ascii') === '40000' };
      at = end;
    }
    if (!found) return undefined;
    id = found.id;
    if (index === parts.length - 1) return found.dir ? undefined : read('blob', id);
    if (!found.dir) return undefined;
    tree = await read('tree', id);
  }
  return undefined;
}

// Object verification precedes checkout; verify the materialized tree too.
// An old clone's index can retain skip-worktree bits or stale tracked files.
export async function verifyGitCheckout(dir: string, root: string): Promise<void> {
  const listed = await untrustedGit(dir, ['ls-tree', '-rz', '--full-tree', root], { bytes: true });
  if (!listed.ok || !listed.bytes) throw new Error('Cannot list the checked-out snapshot.');
  const parents = new Set<string>();
  for (const entry of UTF8.decode(listed.bytes).split('\0').filter(Boolean)) {
    const m = /^(100644|100755|120000|160000) (blob|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(entry);
    if (!m || !m[4]!.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes('\\'))) throw new Error('Invalid checkout path.');
    const parts = m[4]!.split('/'); let parent = dir;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      if (!parents.has(parent)) {
        const st = fs.lstatSync(parent);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error('A checkout parent is not a real directory.');
        parents.add(parent);
      }
    }
    const file = path.join(dir, ...parts), mode = m[1], id = m[3]!;
    if (mode === '160000') continue;
    const st = fs.lstatSync(file);
    const data = mode === '120000' && st.isSymbolicLink() ? Buffer.from(fs.readlinkSync(file)) : st.isFile() && !st.isSymbolicLink() ? fs.readFileSync(file) : undefined;
    if (!data || ((mode === '120000') !== st.isSymbolicLink() && !(process.platform === 'win32' && mode === '120000' && st.isFile())) || process.platform !== 'win32' && mode !== '120000' && Boolean(st.mode & 0o111) !== (mode === '100755')) throw new Error('The checkout file kind differs from the verified snapshot.');
    const hash = createHash(id.length === 40 ? 'sha1' : 'sha256').update(`blob ${data.length}\0`).update(data).digest('hex');
    if (hash !== id) throw new Error(`The checked-out file ${m[4]} differs from the verified snapshot.`);
  }
}
