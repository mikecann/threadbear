#!/bin/bash
# Runs the GPUI app with Mike's desktop fixes patched in as he lands them,
# and a full build of them swapped in once the Mac is left alone:
#
#   desktop/scripts/hotpatch.sh start    # from now on, and at every login
#   desktop/scripts/hotpatch.sh stop     # back to the installed app
#   desktop/scripts/hotpatch.sh status
#   desktop/scripts/hotpatch.sh run      # what start's launch agent runs
#
# The app runs under `dx serve --hot-patch` (dx is the Dioxus CLI, `cargo
# install dioxus-cli@0.7.10`) from one of two checkouts of this repo,
# ~/Library/Caches/Threadbear/hotpatch/src and src-b, each with its own build
# folder: Mike's main with this script and the app's `hotpatch` feature on
# top. dx watches the live one's source, and when a file changes compiles
# only the changed functions and sends them to the running app, where GPUI's
# subsecond support swaps them in and draws every window again
# (vendor/gpui-pre/src/hot_reload.rs, and gpui/src/hot.rs for the calls the
# app hands over once at launch).
#
# Every 30 seconds this fetches Mike's main (the `upstream` remote, or
# `origin` in his own copy). When it
# has moved, hotpatch-classify.mjs says whether the change can go in as a
# patch: a change to a function can; a change to a struct's fields, a trait,
# a static, a Cargo file, the vendored crates or the Objective-C can't, as
# the running app's memory has the old shapes.
#
# Either way the other checkout then builds Mike's latest in full, in the
# background, while the live app keeps running. A change that can be patched
# is in the live app within a minute and in a full build soon after; one that
# can't waits only for that build. Once it's done and the Mac has been left
# alone for a couple of minutes, dx starts from that checkout, its app opens
# in front, and the old one is quit; the two checkouts swap places. So
# patches never pile up for long, and nothing waits on a build to show.
#
# The installed app (~/Applications/Threadbear GPUI.app) is quit while this
# runs, and opened again by `stop`. The live one is a debug build: it sends
# nothing to Sentry, keeps no log of its own, and doesn't update itself. It
# borrows the installed app's web helper and icon.
#
# Logs: ~/Library/Logs/Threadbear/hotpatch (follow.log says what came in and
# how; dx.log is dx's own, build.log the background builds').
set -uo pipefail

HOME_DIR="$HOME/Library/Caches/Threadbear/hotpatch"
SLOT_A="${THREADBEAR_HOTPATCH_CHECKOUT:-$HOME_DIR/src}"
SLOT_B="$HOME_DIR/src-b"
REPO="${THREADBEAR_HOTPATCH_REPO:-$HOME/threadbear}"
# Mike's repo: `upstream` in a fork, `origin` in his own copy.
REMOTE="${THREADBEAR_HOTPATCH_REMOTE:-$(git -C "${THREADBEAR_HOTPATCH_REPO:-$HOME/threadbear}" remote get-url upstream >/dev/null 2>&1 && echo upstream || echo origin)}"
EVERY="${THREADBEAR_HOTPATCH_EVERY:-30}"
IDLE_FOR_SWAP="${THREADBEAR_HOTPATCH_IDLE:-120}"
LOGS="$HOME/Library/Logs/Threadbear/hotpatch"
INSTALLED="$HOME/Applications/Threadbear GPUI.app"
LABEL="com.threadbear.hotpatch"
AGENT="$HOME/Library/LaunchAgents/$LABEL.plist"
# The launch agent runs a copy of this script and the classifier, so a merge
# into either checkout never changes the script bash is reading.
BIN="$HOME_DIR/bin"
DX_ARGS=(--macos -p threadbear-gpui --bin threadbear-gpui --features hotpatch --profile hotpatch)
export PATH="$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
# Node, for the classifier: nvm's newest, when it isn't on PATH already.
if ! command -v node >/dev/null; then
  node_bin="$(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$node_bin" ] && export PATH="$node_bin:$PATH"
fi
mkdir -p "$LOGS" "$HOME_DIR"

say() { echo "$(date '+%F %T') $*" >> "$LOGS/follow.log"; }
notify() {
  local text="${1//\"/\'}"
  /usr/bin/osascript -e "display notification \"$text\" with title \"Threadbear live\"" >/dev/null 2>&1 || true
}

# Which checkout is live, kept across restarts.
LIVE="$(cat "$HOME_DIR/live" 2>/dev/null || echo "$SLOT_A")"
[ -d "$LIVE" ] || LIVE="$SLOT_A"
other() { [ "$1" = "$SLOT_A" ] && echo "$SLOT_B" || echo "$SLOT_A"; }
STANDBY="$(other "$LIVE")"
port() { [ "$1" = "$SLOT_A" ] && echo 8080 || echo 8081; }
gl() { git -C "$LIVE" "$@"; }
gs() { git -C "$STANDBY" "$@"; }

installed_pids() { pgrep -f "^$INSTALLED/Contents/MacOS/threadbear-gpui" || true; }
slot_app_pids() { pgrep -f "^$1/desktop/target/dx/threadbear-gpui/.*/threadbear-gpui$" || true; }
idle_seconds() { ioreg -c IOHIDSystem | awk '/HIDIdleTime/ { print int($NF / 1000000000); exit }'; }
# AppKit's activate, through JavaScript for Automation: no Apple Events, so
# no permission prompt (System Events asked for one).
front() { /usr/bin/osascript -l JavaScript -e "ObjC.import('AppKit'); \$.NSRunningApplication.runningApplicationWithProcessIdentifier($1).activateWithOptions(3)" >/dev/null 2>&1; }

# dx's first build in a checkout has to link the app itself, to learn how,
# so it clears cargo's record that the app is built. dx 0.7.10 looks for that
# record where cargo kept it before Rust 1.94's build-dir layout
# (target/<triple>/<profile>/build/<crate>/<hash>/fingerprint now), finds
# nothing, and the build fails with "Missing linker args for fat link".
bust_fingerprint() { rm -rf "$1"/desktop/target/*/hotpatch/build/threadbear-gpui/*/fingerprint; }

# Started from a thread (by hand), the app would otherwise sign in to the
# runner as that thread.
clean_env=(env -u THREADBEAR_THREAD_ID -u THREADBEAR_THREAD_KEY -u THREADBARE_THREAD_ID -u THREADBARE_THREAD_KEY)

DX_PID=""
SHOWN=""
start_dx() {
  local slot="$1"
  bust_fingerprint "$slot"
  (cd "$slot/desktop/gpui" && exec "${clean_env[@]}" dx serve "${DX_ARGS[@]}" --hot-patch --port "$(port "$slot")" --interactive false --open false) >> "$LOGS/dx.log" 2>&1 &
  DX_PID=$!
  SHOWN=""
  say "dx serve started ($DX_PID) in $(basename "$slot") at $(git -C "$slot" rev-parse --short HEAD)"
}
stop_dx() {
  local pid="$1" slot="$2"
  [ -n "$pid" ] && kill -TERM "$pid" 2>/dev/null
  for _ in $(seq 1 50); do [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || break; sleep 0.2; done
  [ -n "$pid" ] && kill -KILL "$pid" 2>/dev/null
  # dx's app, which outlives it.
  for p in $(slot_app_pids "$slot"); do kill -TERM "$p" 2>/dev/null; done
}

# What dx's bundle lacks: the web runtime's helper processes beside the
# app's binary (gpui/src/web_runtime.rs), as dx builds only the app, and the
# icon, so the Dock shows Threadbear's. Both the installed app's.
give_bundle_extras() {
  local helper="$INSTALLED/Contents/MacOS/threadbear-web-helper" icon="$INSTALLED/Contents/Resources/threadbear.icns"
  find "$1/desktop/target/dx/threadbear-gpui" -path '*.app/Contents' -type d 2>/dev/null | while read -r dir; do
    [ -x "$helper" ] && [ ! -x "$dir/MacOS/threadbear-web-helper" ] && cp "$helper" "$dir/MacOS/threadbear-web-helper"
    [ -f "$icon" ] && [ ! -f "$dir/Resources/threadbear.icns" ] && mkdir -p "$dir/Resources" && cp "$icon" "$dir/Resources/threadbear.icns"
  done
}

# The copy dx started, the only one it sends patches to.
live_pid() { [ -n "$DX_PID" ] && pgrep -P "$DX_PID" -f "threadbear-gpui$" | head -1; }

# dx opens the app behind whatever's in front, and with no sign it's
# Threadbear it looked as if the app had gone (Seth, 18 Nov: "I had to
# relaunch threadbear"). So a new copy is brought to the front, by its pid:
# `open` on the bundle started a second copy, which no patch reached (Seth
# saw no change). The installed app, or a stray copy, opened while this one
# runs, is quit for it.
keep_live_in_front() {
  local pid; pid="$(live_pid)"
  if [ -z "$pid" ]; then
    # It was up and has gone: quit, or its window closed, and dx doesn't
    # open it again by itself. dx is started again, which does.
    if [ -n "$SHOWN" ]; then
      say "the live app went away; starting it again"
      stop_dx "$DX_PID" "$LIVE"
      start_dx "$LIVE"
    fi
    return 0
  fi
  if [ "$pid" != "$SHOWN" ]; then
    SHOWN="$pid"
    front "$pid"
  fi
  local others; others="$(installed_pids; slot_app_pids "$LIVE" | grep -vx "$pid")"
  if [ -n "$others" ]; then
    for p in $others; do kill -TERM "$p" 2>/dev/null; done
    front "$pid"
    say "another copy of the app was opened; quit it for the live one"
    notify "Threadbear is running live from Mike's main. To go back: desktop/scripts/hotpatch.sh stop"
  fi
}

# Takes Mike's main into a checkout. Cargo.lock is the one file that clashes
# with this branch's own change often; Mike's is taken and cargo puts this
# branch's few crates back.
merge_into() {
  local dir="$1" sha="$2"
  if git -C "$dir" merge --no-edit -q "$sha" >/dev/null 2>&1; then return 0; fi
  local clashes
  clashes="$(git -C "$dir" diff --name-only --diff-filter=U)"
  if [ "$clashes" = "desktop/Cargo.lock" ]; then
    git -C "$dir" checkout --theirs desktop/Cargo.lock && (cd "$dir/desktop" && cargo metadata --format-version 1 >/dev/null 2>&1) && git -C "$dir" add desktop/Cargo.lock && git -C "$dir" commit --no-edit -q && return 0
  fi
  git -C "$dir" merge --abort 2>/dev/null
  say "couldn't take in $(git -C "$dir" log -1 --format='%h %s' "$sha"): it clashes with this branch in $(echo "$clashes" | tr '\n' ' ')"
  notify "Couldn't take in Mike's $(git -C "$dir" log -1 --format=%h "$sha"): it clashes with the live branch. See follow.log."
  return 1
}

# The `hotpatch` branch in the repo follows whichever checkout is live, so
# it can be pushed; both checkouts are on detached heads.
record_live() { git -C "$REPO" update-ref refs/heads/hotpatch "$(gl rev-parse HEAD)" 2>/dev/null; echo "$LIVE" > "$HOME_DIR/live"; }

# A full build of <commit> in the standby checkout, in the background:
# the live checkout's own changes plus Mike's latest, which may not be in
# the live one (a change that can't be patched).
BUILD_PID=""
BUILD_OF=""
start_standby_build() {
  local tip="$1"
  if [ ! -d "$STANDBY" ]; then
    git -C "$REPO" worktree add -q --detach "$STANDBY" "$(gl rev-parse HEAD)" 2>>"$LOGS/follow.log" || { say "couldn't make the standby checkout $STANDBY"; return 1; }
  fi
  gs reset -q --hard && gs clean -qfd -e target 2>/dev/null
  gs checkout -q --detach "$(gl rev-parse HEAD)" || return 1
  if [ -n "$tip" ] && ! gs merge-base --is-ancestor "$tip" HEAD; then
    merge_into "$STANDBY" "$tip" || return 1
  fi
  BUILD_OF="$(gs rev-parse HEAD)"
  rm -f "$HOME_DIR/ready"
  bust_fingerprint "$STANDBY"
  (
    cd "$STANDBY/desktop/gpui" || exit 1
    if nice -n 10 "${clean_env[@]}" dx build "${DX_ARGS[@]}" --fat-binary >> "$LOGS/build.log" 2>&1; then
      echo "$BUILD_OF" > "$HOME_DIR/ready"
    fi
  ) &
  BUILD_PID=$!
  say "building $(gs rev-parse --short HEAD) in full in $(basename "$STANDBY")"
}
build_running() { [ -n "$BUILD_PID" ] && kill -0 "$BUILD_PID" 2>/dev/null; }
build_ready() { [ -f "$HOME_DIR/ready" ] && [ "$(cat "$HOME_DIR/ready")" = "$(gs rev-parse HEAD 2>/dev/null)" ]; }

# The standby checkout's build takes over: its dx starts (a relink, as the
# build is done), its app opens in front, and only then is the old one quit.
swap() {
  local old_pid="$DX_PID" old_slot="$LIVE"
  give_bundle_extras "$STANDBY"
  LIVE="$STANDBY"; STANDBY="$old_slot"
  start_dx "$LIVE"
  local new=""
  for _ in $(seq 1 300); do
    kill -0 "$DX_PID" 2>/dev/null || break
    new="$(live_pid)"; [ -n "$new" ] && break
    sleep 1
  done
  if [ -z "$new" ]; then
    say "the full build in $(basename "$LIVE") didn't open; staying on $(basename "$old_slot")"
    stop_dx "$DX_PID" "$LIVE"
    STANDBY="$LIVE"; LIVE="$old_slot"; DX_PID="$old_pid"; SHOWN=""
    return 1
  fi
  sleep 3
  front "$new"
  SHOWN="$new"
  stop_dx "$old_pid" "$old_slot"
  rm -f "$HOME_DIR/ready"
  # The build that made it is done; left set, the next look took it for a
  # failed build of the other checkout.
  BUILD_PID=""
  record_live
  say "swapped to the full build in $(basename "$LIVE") at $(gl rev-parse --short HEAD)"
  notify "Threadbear is on a full build of $(gl log -1 --no-merges --format=%s)"
}

run() {
  [ -d "$LIVE/.git" ] || [ -f "$LIVE/.git" ] || { say "no checkout at $LIVE"; exit 2; }
  command -v dx >/dev/null || { say "dx isn't installed: cargo install dioxus-cli@0.7.10 --locked"; exit 2; }
  # Detached, so the repo's `hotpatch` branch can follow whichever is live.
  gl symbolic-ref -q HEAD >/dev/null && gl checkout -q --detach
  trap 'stop_dx "$DX_PID" "$LIVE"; [ -n "$BUILD_PID" ] && kill "$BUILD_PID" 2>/dev/null; exit 0' TERM INT
  start_dx "$LIVE"
  record_live
  # Mike's commit the live app is waiting on a full build for, and whether
  # patches went in since the last full build.
  local waiting="" patched="" failed="" next_look=0
  while true; do
    if ! kill -0 "$DX_PID" 2>/dev/null; then
      say "dx serve went away; starting it again"
      sleep 5
      start_dx "$LIVE"
    fi
    give_bundle_extras "$LIVE"
    keep_live_in_front
    local now; now=$(date +%s)
    if [ "$now" -ge "$next_look" ]; then
      next_look=$((now + EVERY))
      gl fetch -q "$REMOTE" main 2>>"$LOGS/follow.log" || say "fetch from $REMOTE failed"
      # Mike's main as it is now, in one step: it fast-forwards to merges of
      # his thread branches, so stepping back through it lands in those
      # branches, which clash with each other.
      local tip; tip="$(gl rev-parse -q --verify "$REMOTE/main^{commit}")"
      if [ -n "$tip" ] && [ "$tip" != "$failed" ] && [ "$tip" != "$waiting" ] && ! gl merge-base --is-ancestor "$tip" HEAD; then
        local base kind what
        base="$(gl merge-base HEAD "$tip")"
        kind="$(node "$BIN/hotpatch-classify.mjs" "$LIVE" "$base" "$tip" 2>>"$LOGS/follow.log")"
        what="$(gl rev-list --count --no-merges "$base..$tip") of Mike's commits, the last \"$(gl log -1 --no-merges --format=%s "$base..$tip")\""
        case "$kind" in
          none)
            if [ -z "$waiting" ]; then merge_into "$LIVE" "$tip" && record_live || failed="$tip"; fi ;;
          patch)
            if [ -n "$waiting" ]; then
              # Behind a change that can't be patched: it comes with that
              # one's full build.
              waiting="$tip"
            elif merge_into "$LIVE" "$tip"; then
              record_live
              patched=1
              say "patching in $what"
              notify "Patched in: $(gl log -1 --no-merges --format=%s "$base..$tip")"
            else
              failed="$tip"
            fi ;;
          restart*)
            waiting="$tip"
            say "$what can't be patched in (${kind#restart: }); building it in full" ;;
          *)
            say "couldn't classify $what: $kind"; failed="$tip" ;;
        esac
      fi
    fi
    # A full build of what's waiting, or of the patched code, once nothing
    # is building and the last one is out of date.
    if ! build_running && { [ -n "$waiting" ] || [ -n "$patched" ]; }; then
      local want; want="$(gl rev-parse HEAD)"
      if ! build_ready || { [ -n "$waiting" ] && ! gs merge-base --is-ancestor "$waiting" HEAD 2>/dev/null; } || ! gs merge-base --is-ancestor "$want" HEAD 2>/dev/null; then
        start_standby_build "$waiting" || { say "the full build couldn't start"; [ -n "$waiting" ] && failed="$waiting"; waiting=""; patched=""; }
      elif [ "$(idle_seconds)" -ge "$IDLE_FOR_SWAP" ]; then
        if swap; then waiting=""; patched=""; fi
      fi
    fi
    if [ -n "$BUILD_PID" ] && ! build_running; then
      build_ready || say "the full build in $(basename "$STANDBY") failed; see build.log"
      # Not tried again until Mike's main moves on.
      if ! build_ready; then [ -n "$waiting" ] && failed="$waiting"; waiting=""; patched=""; fi
      BUILD_PID=""
    fi
    sleep 2
  done
}

install_bin() {
  mkdir -p "$BIN"
  local here; here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
  cp "$here/hotpatch.sh" "$here/hotpatch-classify.mjs" "$BIN/"
}

case "${1:-}" in
  run) run ;;
  start)
    install_bin
    mkdir -p "$(dirname "$AGENT")"
    cat > "$AGENT" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>$LABEL</string>
    <key>ProgramArguments</key>
    <array><string>/bin/bash</string><string>$BIN/hotpatch.sh</string><string>run</string></array>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ProcessType</key><string>Interactive</string>
    <key>StandardOutPath</key><string>$LOGS/agent.log</string>
    <key>StandardErrorPath</key><string>$LOGS/agent.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    launchctl bootstrap "gui/$(id -u)" "$AGENT" && echo "Started. The live app opens once dx has built it; follow it in $LOGS/follow.log." ;;
  stop)
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null
    rm -f "$AGENT"
    for slot in "$SLOT_A" "$SLOT_B"; do for p in $(slot_app_pids "$slot"); do kill -TERM "$p" 2>/dev/null; done; done
    open "$INSTALLED"
    echo "Stopped; the installed app is back." ;;
  status)
    if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then echo "Running."; else echo "Not running."; fi
    echo "Live: $(basename "$LIVE") at $(gl log -1 --format='%h %s'), $(gl rev-list --count HEAD.."$REMOTE/main" 2>/dev/null || echo '?') of Mike's commits not in yet."
    tail -8 "$LOGS/follow.log" 2>/dev/null ;;
  -h|--help|"") awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0" ;;
  *) echo "Unknown command: $1" >&2; exit 2 ;;
esac
