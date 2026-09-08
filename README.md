# Agent Room

A local conversation room for a human, active coding agents, GLM through OpenCode, and Astra through Codex. Messages, selected evidence and versioned decisions survive fresh agent sessions. The CLI and browser interface use the same command contracts.

**Status:** development preview. Offline behavior and local client configuration are verified; live plan/model compatibility and the consumer pilot are pending. See [verification](docs/verification.md) for the exact evidence and open checks. Execution starts disabled. This package does not update task status, approve reviews, or merge code.

## Runtime and installation

The verified runtime is Node **24.20.0 on macOS arm64**, including built-in SQLite and FTS5. Node 26.0.0 is also exercised during development. The runtime guard accepts Node 24.20+ within major 24, or major 26, on macOS/Linux. Linux verification remains pending; Windows is unsupported in this preview.

There are no runtime npm dependencies. Build an archive from this directory:

```sh
npm pack --ignore-scripts
```

Copy the resulting versioned archive to another toolkit and install it into a separate tools directory. Keep the archive or its release location and SHA-256 alongside the adopting toolkit's dependency record.

```sh
npm install --prefix .tools/agent-room --offline --ignore-scripts --no-audit --no-fund /absolute/path/productengineered-agent-room-0.1.0.tgz
.tools/agent-room/node_modules/.bin/agent-room doctor --offline --runtime-only
```

For source development, use `node packages/agent-room/bin/agent-room.mjs` from the toolkit root, or `node bin/agent-room.mjs` from this package. The examples below use the installed `agent-room` command.

## Open a local room

Initialize explicitly as the human operator, using an existing project directory:

```sh
agent-room init --operator --project /absolute/path/to/project
agent-room serve --operator
```

Open the printed `session_url`. Its fragment carries the local operator capability; the page removes the fragment and keeps the capability in that tab's session storage. Treat this URL like the local operator token. The server binds only to `127.0.0.1`, checks Host and Origin, and requires a capability on every API call. It does not open a browser automatically.

State defaults to `$XDG_STATE_HOME/agent-room`, or `~/.local/state/agent-room`. Override it with `--state-dir` or `AGENT_ROOM_STATE_DIR`. State, source blobs, configuration, job packets and capabilities live outside the installed package. They must not be copied into toolkit source or committed. The SQLite database requires a local filesystem; do not put the active store on a network drive or shared cloud-sync folder.

Opening the UI, posting, polling, searching, previewing context and exporting make no model calls. **Ask consultants** records an invitation and reserves allowance. Actual execution additionally requires an enabled allowance and a started worker. Stopping the worker stops new jobs; use Cancel to stop an active consultation.

## CLI conversation

All command output is JSON. Supply `--project <id-or-path>` when the current directory does not identify one registered project. Copy returned IDs into subsequent commands; placeholder IDs below are not literal values.

```sh
agent-room thread open --operator --title 'Choose the failure contract' --mode independent
agent-room post --operator --thread THREAD_ID --body 'Preserve the original failure reason.'
agent-room constraint set --operator --thread THREAD_ID --body 'Use existing plan logins only.'
agent-room source add --operator --thread THREAD_ID --path docs/contract.md --working-tree
agent-room context preview --operator --thread THREAD_ID --for astra
agent-room ask --operator --thread THREAD_ID --to glm,astra --body-file question.txt --key question-1
agent-room read --operator --thread THREAD_ID
agent-room search --operator --query 'failure contract'
```

Use `--body-file` or `--body-stdin` for multiline content. `--key` makes a write idempotent; reusing a key with different input is an error. `post` treats quoted mentions as text. `ask` is the explicit invocation boundary. Independent mode gives first-round consultants the same question boundary and excludes each other's initial responses. New human instructions remain visible and can make an older response stale.

Source capture is explicit and bounded: selected UTF-8 files up to 1 MiB, inside the registered project, excluding sensitive paths and escaping symlinks. Use `--revision COMMIT` for a captured Git version, or `--working-tree` for current file content. Working-tree captures are checked again before launch. Changed captures receive new identities; older evidence remains available for inspection.

Packets include the direct question, relevant human messages, pinned constraints, accepted decisions, unresolved claims, selected sources and bounded retrieval results. The default full prompt limit is 32 KiB. If required material does not fit, the job stops with `needs_scoping`. The packet hash, selection, omissions, byte count and estimated token count are inspectable. Token counts are estimates, not a quota measurement.

## Consultant execution

The preview pins these client contracts and model requests:

| Participant | Client | Authentication route | Model |
|---|---|---|---|
| `glm` | OpenCode 1.18.18 | Saved Z.AI Coding Plan credential | `zai-coding-plan/glm-5.3` |
| `astra` | Codex 0.153.4 | Saved ChatGPT login | `gpt-6-astra` |

```sh
agent-room doctor --offline
agent-room policy enable --operator --max-calls 6
agent-room work --operator --once
agent-room work --operator --once
agent-room policy pause --operator
```

`doctor` inspects runtime, help, saved login type and the isolated OpenCode permission configuration. It makes no inference calls and cannot prove account model access. Codex uses `--ignore-user-config`, a fresh ephemeral session, read-only sandbox and disabled tool features. OpenCode uses an isolated configuration, `--pure`, the explicit plan provider and a deny-tools consultant profile. Neither adapter receives general API key environment overrides. Neither changes authentication or falls back to another model or billing route. Changed client versions refuse until their event/configuration contracts are verified.

The global worker runs one consultant process at a time. Defaults are six calls per thread, twenty per UTC day across the store, no automatic follow-up, a 600-second timeout and a 2 MiB native output limit. The operator can lower these limits. Reservations are atomic; a launched invocation counts even if its result is malformed or interrupted. A confirmed pre-spawn failure releases its reservation. Native usage is recorded when available; remaining provider quota is explicitly unknown.

CLI `work --once` runs one queued job in the foreground. The UI Start worker control, or explicit `serve --worker`, processes the queue until stopped, disabled, blocked by allowance, or a consultation error occurs. Ordinary `serve` does not start it.

Consultant responses must be a strict JSON envelope with valid packet citations. Tool activity, unexpected native events, invalid terminal output and invented citations cannot become normal answers. Consultants may propose decisions or request bounded context. Only an operator can accept, reject or supersede a decision. Stale consultant citations refuse direct acceptance until the changed context is reviewed.

## Active coding agents

Register a capability for a specific active run as the operator:

```sh
agent-room actor attach --operator --name claude:developer --run-id RUN_ID
```

Give that run only the returned `token_file` path. It uses `--token-file` or `AGENT_ROOM_TOKEN` and omits `--operator`:

```sh
agent-room inbox --token-file /path/to/agent.token
agent-room read --token-file /path/to/agent.token --thread THREAD_ID
agent-room post --token-file /path/to/agent.token --thread THREAD_ID --body-file reply.txt
agent-room ack --token-file /path/to/agent.token --thread THREAD_ID --through SEQUENCE
```

Agent capabilities are scoped to one project and expire after seven days by default. The local operator capability lasts 365 days. Agents can post, read, invite within policy, and propose decisions. They cannot accept decisions, alter execution policy, register projects, or run the worker. The local user remains trusted: capabilities separate application roles, not hostile processes running as the same OS account.

The inbox stays pending until that actor acknowledges it. Acknowledgment is not proof of comprehension. The room does not wake an inactive Claude session. The UI acknowledges only its own visible messages and never claims an agent has read them.

## Decisions, recovery and backup

```sh
agent-room decision propose --thread THREAD_ID --statement 'Return a typed failure' --rationale 'Keep the original reason visible'
agent-room decision accept --operator --thread THREAD_ID --stable-id DECISION_ID --statement 'Return a typed failure' --rationale 'Verified against the caller contract' --citations MESSAGE_ID
agent-room jobs --operator
agent-room cancel --operator --job JOB_ID
agent-room recover --operator --job JOB_ID --inspect
agent-room recover --operator --job JOB_ID --confirm-stopped
agent-room retry --operator --job JOB_ID --key retry-1
agent-room export --operator --thread THREAD_ID --out /new/export-directory
agent-room backup --operator --out /new/backup-directory
agent-room restore --operator --from /backup-directory --out /new/state-directory
```

Never recover a live worker claim. Inspect the stored process identity and establish that the original worker and child have stopped before `--confirm-stopped`. Recovery retains `interrupted_unknown` and uncertain consumption. Retrying is a new invitation and is never automatic for a lost process. Local cancellation cannot prove a remote service stopped processing.

Export includes Markdown, JSON records and captured source blobs. Backup uses SQLite's consistent backup facility and a manifest of referenced file hashes. Restore verifies the manifest into a new directory, revokes old capabilities, issues a new operator token, disables execution and marks restored in-flight work uncertain. Keep the original state until the restored store is inspected. Back up before upgrading. Newer database/configuration schemas and malformed stores refuse explicitly; there is no empty fallback database.

## Optional toolkit integration

The core does not require a `.claude` tree, task store or sibling consumer. [Integration instructions](integrations/README.md) provide a small launcher and `/room` command. Copy those through the toolkit's normal upstream/sync process at the agreed adoption boundary.

Disagreement and stuck-work triggers default off. Enable them explicitly with `call --action policy.update --input-file policy-patch.json` as an operator, adding them to `enabled_triggers`. A disagreement event needs both review references. A stuck event needs two distinct attempted fixes and the failure signature. Events have causal keys, reserve bounded invitations, and never change task state. Example payloads are in [examples](examples/README.md).

Automatic follow-up can be set to at most one round. It waits for initial answers to finish, only targets participants already in that discussion, and obeys the same thread/global allowance. Leave it off until the live pilot establishes useful behavior.

## Development verification

```sh
npm test
```

Tests create temporary stores/projects and use fake providers. They do not read real task databases or consume model quota. The optional `tests/browser-smoke.mjs` uses an explicitly supplied Playwright installation and a disposable browser context. Native client compatibility still needs the operator-authorized [live pilot](docs/live-pilot.md).

Exit codes: `0` success, `2` invalid input/not found, `3` authentication/authorization/disabled/unsupported/allowance, `4` conflict, `5` storage failure, `6` provider/cancel/invalid-output failure, `7` context needs scoping. The JSON error code carries the precise reason.
