#!/bin/sh
# Apply the exact isolated preview tree, with its settled conflict files.
# Node 24 is required by Threadbear setup too; no packages are loaded.
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
# The Node the rest of Threadbear runs on (THREADBEAR_NODE in a thread), not
# whatever node is first on PATH (Gemini's break-it review of 187/188).
. "$here/../runner/scripts/find-node.sh"
node_bin=$(threadbear_find_node) || exit 1
exec "$node_bin" "$here/merge-prepared.mjs" "$@"
