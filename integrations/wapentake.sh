#!/usr/bin/env bash
# Install as .claude/scripts/wapentake.sh in an adopting toolkit or consumer.
set -euo pipefail
wapentake_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
wapentake_node="${WAPENTAKE_NODE:-node}"
wapentake_cli="${WAPENTAKE_CLI:-}"
if [[ -z "$wapentake_cli" ]]; then
  wapentake_install_root="${WAPENTAKE_INSTALL_ROOT:-$HOME/.local/share/wapentake}"
  wapentake_cli="$wapentake_install_root/current/node_modules/@productengineered/wapentake/bin/wapentake.mjs"
fi
if [[ ! -f "$wapentake_cli" ]]; then
  echo '{"error":{"code":"client_unsupported","message":"Wapentake is not installed; follow the package integration instructions"}}'
  exit 3
fi
cd "$wapentake_project_root"
exec "$wapentake_node" "$wapentake_cli" "$@"
