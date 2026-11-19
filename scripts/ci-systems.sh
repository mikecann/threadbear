#!/bin/bash
# Which systems the Desktop app workflow (.github/workflows/desktop.yml)
# runs on for pushes to your fork's main, by setting the repository variable
# DESKTOP_CI_SYSTEMS on origin's GitHub repo with your gh.
#
#   scripts/ci-systems.sh            what it's set to now
#   scripts/ci-systems.sh auto       the system this machine runs (uname)
#   scripts/ci-systems.sh mac        or linux, windows, a list (mac,linux), or all
#   scripts/ci-systems.sh off        delete it: your pushes run nothing again
#
# A fork runs no desktop CI on its pushes until this is set, as most of a
# fork's runs on all three systems went red over things that were never its
# owner's (19 Nov 2026), and the three together take 75 to 100 minutes.
# Once it's set, tb land holds a desktop landing while your own last run on
# main is red (docs/thread-worktrees.md, "Red on GitHub").
#
# In mikecann/threadbear it's unset, which there means all three; this
# refuses to touch it there unless you pass --mike.
set -euo pipefail
die() { echo "$*" >&2; exit 1; }

NAME=DESKTOP_CI_SYSTEMS
mike=false
want=
for a in "$@"; do
  case "$a" in
    --mike) mike=true ;;
    -h | --help) sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "Unknown option $a (see --help)" ;;
    *) [ -z "$want" ] || die "One value at a time (see --help)"; want=$a ;;
  esac
done

command -v gh > /dev/null || die "This needs GitHub's gh (https://cli.github.com), signed in."
url=$(git remote get-url origin 2> /dev/null) || die "No origin remote here."
repo=$(printf '%s' "$url" | sed -E 's#^git@[^:]+:##; s#^[a-z+]+://([^@/]+@)?[^/]+/##; s#\.git/?$##; s#/$##')
case "$url" in *github.com*) ;; *) die "origin isn't on GitHub ($url)." ;; esac
mikes=false
[ "$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')" = mikecann/threadbear ] && mikes=true
if $mikes && ! $mike; then
  die "origin is Mike's repo, where unset means all three systems. Pass --mike to change it there."
fi

if [ -z "$want" ]; then
  if now=$(gh variable get "$NAME" --repo "$repo" 2> /dev/null); then
    echo "$NAME on $repo is $now"
  elif $mikes; then
    echo "$NAME isn't set on $repo (or gh can't read it), which there means all three systems."
  else
    echo "$NAME isn't set on $repo (or gh can't read it), so its pushes run no desktop CI."
  fi
  exit 0
fi

want=$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]')
case "$want" in
  off)
    if gh variable delete "$NAME" --repo "$repo" 2> /dev/null; then
      if $mikes; then echo "Deleted $NAME on $repo: it runs on all three systems again."; else echo "Deleted $NAME on $repo: its pushes run no desktop CI now."; fi
    else
      echo "$NAME wasn't set on $repo (or gh couldn't delete it): gh variable list --repo $repo"
    fi
    exit 0
    ;;
  auto)
    case "$(uname -s)" in
      Darwin) want=mac ;;
      Linux) want=linux ;;
      MINGW* | MSYS* | CYGWIN*) want=windows ;;
      *) die "Can't tell which system $(uname -s) is: say mac, linux or windows." ;;
    esac
    ;;
esac
for w in ${want//,/ }; do
  case "$w" in
    mac | linux | windows | all) ;;
    *) die "\"$w\" isn't a system: use auto, mac, linux, windows, all or off." ;;
  esac
done

gh variable set "$NAME" --repo "$repo" --body "$want" > /dev/null
echo "Set $NAME on $repo to $want: pushes to its main that change what desktop.yml checks run on just those."
echo "Started by hand (gh workflow run desktop.yml --repo $repo), it runs those too. Set it to all for every system."
