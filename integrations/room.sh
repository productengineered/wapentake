#!/usr/bin/env bash
# Install as .claude/scripts/room.sh in an adopting toolkit or consumer.
set -euo pipefail
room_project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
room_node="${AGENT_ROOM_NODE:-node}"
room_cli="${AGENT_ROOM_CLI:-}"
if [[ -z "$room_cli" ]]; then
  if [[ -f "$room_project_root/packages/agent-room/bin/agent-room.mjs" ]]; then
    room_cli="$room_project_root/packages/agent-room/bin/agent-room.mjs"
  else
    room_cli="$room_project_root/.tools/agent-room/node_modules/@productengineered/agent-room/bin/agent-room.mjs"
  fi
fi
if [[ ! -f "$room_cli" ]]; then
  echo '{"error":{"code":"client_unsupported","message":"Agent Room package is not installed; follow the package integration instructions"}}'
  exit 3
fi
cd "$room_project_root"
exec "$room_node" "$room_cli" "$@"
