#!/usr/bin/env bash
# Install as .claude/scripts/room.sh in an adopting toolkit or consumer.
set -euo pipefail
room_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
room_node="${AGENT_ROOM_NODE:-node}"
room_cli="${AGENT_ROOM_CLI:-}"
if [[ -z "$room_cli" ]]; then
  room_install_root="${AGENT_ROOM_INSTALL_ROOT:-$HOME/.local/share/agent-room}"
  room_cli="$room_install_root/current/node_modules/@productengineered/agent-room/bin/agent-room.mjs"
fi
if [[ ! -f "$room_cli" ]]; then
  echo '{"error":{"code":"client_unsupported","message":"Agent Room package is not installed; follow the package integration instructions"}}'
  exit 3
fi
cd "$room_project_root"
exec "$room_node" "$room_cli" "$@"
