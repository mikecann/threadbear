#!/bin/sh
# Apply the exact isolated preview tree, with its settled conflict files.
# Node 24 is required by Threadbear setup too; no packages are loaded.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
exec node "$here/merge-prepared.mjs" "$@"
