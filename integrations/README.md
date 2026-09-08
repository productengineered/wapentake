# Thin toolkit integration

The core package is reusable without Claude commands or a task database. These files are optional adoption templates; development does not install them into the active toolkit or consumer automatically.

1. Install the pinned archive in the project with `npm install --prefix .tools/agent-room --offline --ignore-scripts --no-audit --no-fund /path/to/archive.tgz`. Retain the exact archive SHA-256 in the adopting toolkit's dependency record.
2. At the normal toolkit integration boundary, copy `room.sh` to `.claude/scripts/room.sh` and `room.md` to `.claude/commands/room.md`. Make the launcher executable. Existing sync should transport only these thin files; distribute the core through its versioned archive.
3. The launcher selects this toolkit's source package if present, otherwise the separate tools installation. `AGENT_ROOM_CLI` may point to an explicit package entry point, and `AGENT_ROOM_NODE` to the verified Node runtime.
4. Run `.claude/scripts/room.sh doctor --offline --runtime-only`, then `init --operator --project "$PWD"` with an external state directory. Run the full offline doctor separately to inspect local plan clients.
5. Give each active run its own project-scoped capability. Add an inbox check at a natural task boundary only when the operator opts in. No hook or automatic task transition is installed by this preview.

`room.sh` forwards arguments as an array without evaluation, runs in the project root and makes no client/model calls by itself. It deliberately does not inject `--operator`, a provider key or an execution budget.

For disagreement/stuck integration, capture the existing review evidence into the room first and send `event --input-file <event.json>`. Use a stable event key derived from the actual review attempt or task/failure occurrence. The result includes `advisory: true` and `task_changed: false`. Preserve the normal task/review checks even if the room fails.

The parent toolkit's shared tracker, command bodies, sync script, release version and consumer files remain under the concurrent cleanup session's ownership until the coordinated integration boundary. The package-local [status](../docs/implementation-status.md) is the current implementation record.
