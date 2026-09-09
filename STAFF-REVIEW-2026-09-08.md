# Agent Room staff review: findings and remediation guidance

Date: 2026-09-08. Reviewed commit: `97401ac` on `main`, clean working tree.
Scope: read every tracked file in full, ran the suite and the offline doctor, and probed the CLI and HTTP server against throwaway state directories under the session scratchpad. No repository file was edited. No real state directory was read. No model call was made. The full `doctor --offline` was deliberately not run because it spawns the real Codex and OpenCode clients.

This document is written for the engineer or agent who will remediate. Each finding has an ID, evidence with `file:line` references, and a concrete remediation. Items marked **Approval required** change a CLI contract, an exit code, the recovery or restore path, or add a dependency. Do not implement those without the operator's explicit approval.

---

## 1. Baseline

| Check | Result |
|---|---|
| `npm test` on Node 26.0.0 arm64 | 41 tests pass, 0 fail, 0 skipped, 9.1 s |
| `node bin/agent-room.mjs doctor --offline --runtime-only` | `ready_offline: true`, exit 0, 70 ms, SQLite 3.53.4, FTS5 available |
| Node 24.20.0 | Not reproducible on this machine; no Node 24 binary installed. `docs/verification.md` records 41 passing on 24.20.0 |
| Git | `main`, clean, 4 commits |

---

## 2. System model as implemented

The layering is sound and visible in the directory layout. This section records how the system actually behaves so remediation does not accidentally weaken it.

- **Storage** (`src/store.mjs`): one SQLite file `room.sqlite` at the state root, WAL, `synchronous=FULL`, `user_version=1`. Refuses future schemas, unversioned nonempty databases, malformed files and invalid stored policy without touching data. Blobs are content-addressed under `projects/<id>/blobs/<sha256>`; job artifacts under `projects/<id>/jobs/<job>/`. Backup uses the `node:sqlite` backup API plus a hashed manifest; restore verifies every hash into a new directory, revokes every capability, issues a new operator token, disables execution, marks `preparing`/`running` jobs `interrupted_unknown`, deletes the worker claim.
- **Capabilities** (`src/store.mjs:83-106`, `src/room.mjs:10-11`): a token is 32 random bytes base64url; only its SHA-256 is stored. Roles are `operator` (365 days, one per store, file `operator.token`) and `agent` (project-scoped, 1 to 30 days, default 7, file `capabilities/<actor>.token`). Every operator-only mutation calls `room.operator()`: register, move, attach, thread status, constraints, non-proposal decisions, policy, retry, backup, worker, recovery, inspection, reconcile.
- **Allowance and reservation** (`src/room.mjs:215-238`, `src/worker.mjs:39-70`, `:94-101`, `:120-125`): `ask` posts the question and inserts one `budget_ledger` row per recipient in state `reserved`, inside one `BEGIN IMMEDIATE` transaction, refusing with `budget_exhausted` if the UTC-day count or the thread lifetime count of `reserved+started` rows would exceed policy. The worker claim transaction sets the job `preparing` and re-checks the day. The launch transaction sets the job `running`, the ledger `started`, and writes a `launch_intent` event, and only after it commits does the adapter spawn inference. On failure the ledger is released only if the launch transaction never ran or the adapter reported `details.spawned === false`. Cancel of a `queued` job releases; cancel of `running` sets `cancel_requested` and the heartbeat aborts the child.
- **Worker lifecycle**: `queued -> preparing -> running -> succeeded | failed | cancelled`, or `queued/preparing -> needs_scoping | auth_required | quota_wait | disabled`. A singleton `worker_claim` row carries owner PID and `ps lstart` identity plus child PID and identity. Recovery refuses while either process is alive by identity; `recover --confirm-stopped` marks `interrupted_unknown` and deletes the claim; retry is a new job with a new reservation and, for an independent first round, the original boundary.
- **Packet builder** (`src/context.mjs`): deterministic; required material is the direct question, the current operator question, every operator message since it, active constraints, current decisions, unresolved objections up to the boundary, the reply chain, cited messages, required and cited sources, and stored retrieval. Optional material is up to six recent non-stale messages and optional sources as 8 KiB excerpts, each added only if the rendered prompt stays under `max_packet_bytes - 1200`. Refuses with `needs_scoping` before launch if required material exceeds the budget or a required working-tree source changed. `config_hash` covers participant row, policy, prompt text and schema.
- **Envelope validation** (`src/contracts.mjs:78-118`): exact key set, schema 1, kind enum, body 4,000 chars, at most 30 citations all inside `allowed_citations`, at most 3 context requests with bounded shapes, `needs_context` if and only if requests exist, proposals and follow-ups only on `answer`, follow-up participant must be in the discussion. Every failure is `invalid_output`.
- **Adapters**: Codex pinned to 0.153.4 with `--ignore-user-config --ephemeral --sandbox read-only --json --output-schema` and 22 disabled features; OpenCode pinned to 1.18.18 with `--pure`, an isolated `XDG_CONFIG_HOME`, `OPENCODE_CONFIG_CONTENT`, a deny-all agent, and a post-run session export that verifies exact provider/model and zero tool parts. Child environment is an allowlist; no API key variables pass.
- **Transport** (`web/server.mjs`): binds `127.0.0.1` on an ephemeral port, checks Host on every request and Origin when present, requires a bearer capability on `/api/command`, 128 KiB body cap, CSP with `frame-ancestors 'none'`, no browser launch. The worker loop is off unless `--worker` or the operator's `worker.start` action.
- **Exit codes** (`src/contracts.mjs:8`): the table matches the README exactly. `main().catch` maps unknown codes to 5.

---

## 3. Findings

Severity order within each category. **Blast radius** names what changes for callers.

### 3.1 Correctness bugs

#### C1. Undocumented error codes leak into the JSON error contract

**Evidence.** `bin/agent-room.mjs:160` emits `error.code ?? 'storage_error'` for any thrown error, so Node system errors pass through verbatim. Verified on a throwaway store:

| Input | Output | Exit |
|---|---|---|
| `--project /nonexistent/path` (`bin/agent-room.mjs:75`) | `{"code":"ENOENT","message":"ENOENT: no such file or directory, lstat '/nonexistent'"}` | 5 |
| `--body-file /missing.txt` (`bin/agent-room.mjs:69`) | `{"code":"ENOENT", ...}` | 5 |
| `--token-file /missing.token` (`bin/agent-room.mjs:99`) | `{"code":"ENOENT", ...}` | 5 |
| `--operator` with `operator.token` absent (`bin/agent-room.mjs:99`) | `{"code":"ENOENT", ...}` | 5 |
| `--input-file /missing.json` (`bin/agent-room.mjs:80`) | `{"code":"ENOENT", ...}` | 5 |
| `serve` on an occupied port (`web/server.mjs:61`) | `{"code":"EADDRINUSE", ...}` | 5 |

The README states that the JSON error code carries the precise reason and that exit 5 means storage failure. These are input and authentication errors reported as storage failures with codes outside the documented vocabulary.

**Remediation.**
1. In `bin/agent-room.mjs`, add a `readInput(path, flag)` helper that wraps `readFileSync` and throws `RoomError('invalid_input', \`Cannot read ${flag} ${path}: ${error.code}\`)`. Use it for `--body-file`, `--body-stdin`, `--token-file`, `--input-file`.
2. For the operator token: if `operator.token` is missing, throw `RoomError('auth_required', \`No operator capability at ${path}; run init --operator with this --state-dir\`)`.
3. In `locate()`, catch the `realpathSync` failure and throw `RoomError('not_found', \`No registered project matches ${arg}\`)`.
4. In `main().catch`, never pass a non-RoomError code through: `const code = error instanceof RoomError ? error.code : 'storage_error'; const details = error instanceof RoomError ? error.details : { cause: error.code ?? error.name };`. This keeps the original reason in `details.cause` while conforming to the vocabulary.
5. For `serve`, catch listen errors and rethrow as `RoomError('invalid_input', \`Cannot listen on 127.0.0.1:${port}: ${error.code}\`)`.
6. Test: an exit-code table test that drives each documented code through `bin/agent-room.mjs` with `spawnSync` and asserts both `error.code` and `status`. Include the six inputs above.

**Approval required.** Exit codes for these inputs move from 5 to 2 or 3, and the JSON `code` changes from leaked system codes to documented values. Blast radius: any script that matched on `ENOENT` in this JSON. Migration: none needed; the documented table already promised these values.

#### C2. Missing `--thread`, `project`, or `id` reaches SQLite as `undefined`

**Evidence.** `src/commands.mjs:44-69` passes `thread`, `project` and `data.id` straight to `Room` methods, which bind them as SQL parameters. `node:sqlite` throws `TypeError [ERR_INVALID_ARG_TYPE]: Provided value cannot be bound to SQLite parameter 2.` Verified:

- CLI `read --project P` without `--thread`: `{"code":"ERR_INVALID_ARG_TYPE","message":"Provided value cannot be bound to SQLite parameter 2."}` exit 5.
- CLI `call --action messages.get --input-file '{}'`: same.
- HTTP `messages.read` with no `thread`, and `messages.get` with `{}`: `500 {"error":{"code":"storage_error","message":"The local operation failed"}}`, and nothing is written to stderr (`web/server.mjs:57`).

The message names a SQL parameter index, not the missing flag.

**Remediation.**
1. In `src/commands.mjs`, declare command metadata once and validate before dispatch:
   ```js
   const ACTIONS = {
     'messages.read':   { project: true, thread: true },
     'messages.get':    { project: true, id: true },
     'jobs.cancel':     { project: true, id: true },
     'policy.update':   { project: false },
     // ... one row per action
   };
   export function requirements(action) { const r = ACTIONS[action]; if (!r) fail('invalid_input', `Unknown command action: ${action}`); return r; }
   ```
   In `execute()`: `const r = requirements(action); if (r.project) text(project, 'project id', 300); if (r.thread) text(thread, 'thread id', 300); if (r.id) text(data.id, 'id', 300);`. The error then reads `thread id must be nonempty text of at most 300 characters`.
2. In `bin/agent-room.mjs:108`, replace the hand-maintained `needsProject` expression with `requirements(action).project`, and when `--thread` is required but absent fail with `--thread is required for this command`.
3. In `web/server.mjs:57`, log non-RoomError failures: `process.stderr.write(\`${new Date().toISOString()} unexpected ${req.url}: ${error.stack}\n\`)` before sending the generic 500. Keep the generic client message.
4. Tests: CLI `read` without `--thread` returns `invalid_input` exit 2; HTTP `messages.read` without `thread` returns 400 `invalid_input`; HTTP with an injected throwing worker returns 500 and writes to stderr.

Blast radius: exit code moves from 5 to 2 for these inputs. Not a contract change; this is conformance. Flag it in the commit message.

#### C3. Committed sources over 1 MiB return `invalid_input`; every git failure collapses into one message

**Evidence.** `src/sources.mjs:32` runs `git show` with `maxBuffer = max_source_bytes + 1`. A committed file of 1 MiB + 2 bytes exceeds the buffer, `execFileSync` throws `ENOBUFS`, and `src/sources.mjs:19` converts every failure into `invalid_input: The selected Git revision/path could not be read`, exit 2. The working-tree path at `src/sources.mjs:26` correctly returns `needs_scoping`, exit 7. Verified on a throwaway git project:

| Case | Code | Exit |
|---|---|---|
| 1 MiB + 2 bytes via HEAD | `invalid_input` | 2 |
| Same file via `--working-tree` | `needs_scoping` | 7 |
| `--revision deadbeef` | `invalid_input`, same message | 2 |
| Untracked file at HEAD | `invalid_input`, same message | 2 |
| Non-git project, no flag | `invalid_input`, same message | 2 |

Git's stderr, which says exactly which of these happened, is discarded.

**Remediation.**
1. In `git()`:
   ```js
   catch (error) {
     if (error.code === 'ENOBUFS') fail('needs_scoping', 'Selected source exceeds the source capture limit');
     const stderr = String(error.stderr ?? '').trim().slice(0, 500);
     if (/not a git repository/i.test(stderr)) fail('invalid_input', 'Project is not a Git repository; capture with --working-tree', { git: stderr });
     fail('invalid_input', 'The selected Git revision or path could not be read', { git: stderr, args });
   }
   ```
2. Tests: revision capture succeeds and records the resolved commit; oversized committed file returns `needs_scoping`; bad revision and untracked path return `invalid_input` with `details.git` populated; non-git project returns the `--working-tree` hint.

**Approval required.** Exit code for an oversized committed file moves from 2 to 7. Blast radius: none known; this aligns with the README's 1 MiB limit and exit table.

#### C4. A consultant `read` request for an unknown source fails the job as `not_found`

**Evidence.** `src/worker.mjs:163` calls `this.room.source(...)` for each read request; a miss throws `not_found`, which the catch at `:117-118` records as `error_code: not_found`, status `failed`. `work --once` then exits 2, the "invalid input" code, although the operator's input was valid and the consultant's output was not.

**Remediation.** Wrap the lookup:
```js
for (const request of response.context_requests) if (request.kind === 'read') {
  try { this.room.source(job.project_id, request.source_id); }
  catch (error) { if (error.code === 'not_found') fail('invalid_output', `Consultant requested source ${request.source_id}, which is not in this project`); throw error; }
}
```
Test: fake adapter returns `needs_context` with a read for a random id; assert `error_code === 'invalid_output'` and the ledger stays `started`.

**Approval required.** This is inside the worker path. Blast radius: `error_code` and exit code for this one failure shape.

#### C5. OpenCode output with no session ID crashes the exporter with a Node internals message

**Evidence.** `src/adapters/opencode.mjs:88` passes `normalized.session_id` to `runProcess` as an argument. `normalizeOpenCode` returns `null` when no event carried `sessionID` (`:21`, `:38`). `spawn` throws `TypeError [ERR_INVALID_ARG_TYPE]` synchronously inside the promise executor; the worker records `provider_error` with message `The "args[1]" argument must be of type string...`.

**Remediation.** Before spawning the export: `if (typeof normalized.session_id !== 'string' || !normalized.session_id) fail('invalid_output', 'OpenCode did not report a session ID; session metadata cannot be verified');`. Test: run `normalizeCapture` through a fake `opencode` executable path with events lacking `sessionID`; assert `invalid_output`.

#### C6. `event --input-file` with a non-object JSON body crashes before validation

**Evidence.** `bin/agent-room.mjs:144` reads `data.key` immediately after parsing. Input `null` yields `{"code":"storage_error","message":"Cannot read properties of null (reading 'key')"}` exit 5. Verified.

**Remediation.** Call `object(data, 'event')` right after `jsonFile()` and before `data.key`. Test with `null`, `[]`, `"text"`.

#### C7. Two concurrent `init` calls race on the migration

**Evidence.** `src/store.mjs:28` reads `PRAGMA user_version` before the `BEGIN IMMEDIATE` at `:35`. Two processes can both observe 0; the second's `CREATE TABLE meta` fails and surfaces as `storage_error: Cannot open room database: table meta already exists`. No data loss. Low impact because `init` is a one-time operator action.

**Remediation.** Re-read `user_version` inside the transaction and return early if it is already 1. Test: spawn two `init` processes against one empty state directory; both exit 0.

### 3.2 Safety-invariant risks

#### S1. A worker that dies during `preparing` leaks its reservation permanently

**Evidence.** `recover --confirm-stopped` at `src/worker.mjs:22-24` and `restoreBackup` at `src/store.mjs:181-183` set the job to `interrupted_unknown` and delete the claim, but never touch `budget_ledger`. A job in `preparing` has a ledger row in state `reserved` because the launch transaction at `src/worker.mjs:94-101` is the only writer of `started`. That `reserved` row counts against the thread's lifetime allowance in `_reserve` at `src/room.mjs:218` forever. No command can release it: `cancel` on a non-queued, non-running job at `src/room.mjs:246-250` only logs an event and returns. Each such crash shrinks the six-call thread cap by one. Retrying then reserves a second slot for the same question.

Status `preparing` with a confirmed-stopped owner is a proven pre-spawn stop: the launch transaction is durable with `synchronous=FULL` and precedes the inference spawn, so if the ledger is still `reserved`, inference was never launched. This satisfies the invariant's own condition for release.

**Remediation.** In `Worker.recover`, after the live-process check and before or after marking the job:
```js
const ledger = this.store.get('SELECT state FROM budget_ledger WHERE job_id=?', id);
const released = ledger?.state === 'reserved';
if (released) this.store.run("UPDATE budget_ledger SET state='released' WHERE job_id=? AND state='reserved'", id);
this.store.event(id, 'operator_reconciled', { actor_id: ..., automatic_retry: false, reservation_released: released, launch_recorded: ledger?.state === 'started' });
```
Use the ledger state, not the job status, as the proof. This also repairs jobs already marked `interrupted_unknown` from an earlier `preparing` loss: re-running `recover --confirm-stopped` on them releases the row. Apply the same rule in `restoreBackup` for jobs it marks uncertain. Keep `started` rows untouched. Tests: kill a child worker while a fake adapter's `prepare` blocks, recover, assert ledger `released` and `usage.reserved` decremented; kill while `run` blocks, recover, assert ledger stays `started`. See T-S5 for the kill harness.

**Approval required.** Touches recovery and restore. Blast radius: recovered `preparing` jobs stop consuming allowance; nothing else changes. Migration: operators with existing leaked rows run `recover --confirm-stopped` once per affected job.

#### S2. The client-version and auth-mode gates have zero tests

**Evidence.** `CodexAdapter.inspect` at `src/adapters/codex.mjs:53-64` enforces `0.153.4`, four required `exec --help` flags, and ChatGPT login. `OpenCodeAdapter.inspect` at `src/adapters/opencode.mjs:52-73` enforces `1.18.18`, four flags, the Coding Plan credential, and the effective-config check at `:64-70`. None of this runs in `npm test`; `adapters.test.mjs` tests only the argument builders and normalizers. The README invariant "changed client versions refuse until their event/configuration contracts are re-verified" is enforced solely by code that no test executes. A regex change or a version bump typo would ship silently.

**Remediation.** Add `tests/inspect.test.mjs` using fake executables written to a temp directory at test time, mode 0o700:
```js
// fake codex: a node script
#!/usr/bin/env node
const a = process.argv.slice(2).join(' ');
if (a === '--version') console.log(process.env.FAKE_CODEX_VERSION ?? 'codex-cli 0.153.4');
else if (a === 'exec --help') console.log('--ignore-user-config --output-schema --ephemeral --json');
else if (a === 'login status') console.log(process.env.FAKE_CODEX_AUTH ?? 'Logged in using ChatGPT');
else process.exit(2);
```
Instantiate `new CodexAdapter({ executable: fakePath })` and assert: correct version passes and returns `client_version`; `0.153.5` fails `client_unsupported`; missing flag fails `client_unsupported` naming the flag; `Logged in using API key` fails `wrong_auth_mode`; not logged in fails `auth_required`. Same shape for OpenCode with `--version`, `run --help`, `auth list`, and `debug config --pure` printing `process.env.OPENCODE_CONFIG_CONTENT` back, so the effective-config check can be tested with a tampered profile that fails `permission_config_error`. Use `env` overrides through the existing `env` option so the fake reads its settings without polluting the allowlist.

Also add an `adapters` option to `doctor()` in `src/doctor.mjs:18` so the full doctor can be tested with the fakes and its `ready_for_live_check` computed both ways.

#### S3. Policy validation has no direct test

**Evidence.** `src/contracts.mjs:58-72` is the sole enforcement of `allow_general_api_fallback === false`, `max_global_concurrency === 1`, UTC resets, the adapter allowlist, trigger names, and every numeric bound. Verified by probe that `{"allow_general_api_fallback":true}` and `--max-calls 5000` are refused. No test asserts any of it.

**Remediation.** Table-driven test over `validatePolicy`: each forbidden patch throws `invalid_input`; each bound's min-1 and max+1 throws; a valid patch round-trips through `room.setPolicy` and back through a fresh `Store`. Include `enabled_triggers: ['manual','disagreement','stuck','other']` and `allowed_adapters: ['x']`.

#### S4. Reservation atomicity is not tested across processes

**Evidence.** `tests/room.test.mjs:81-91` reserves sequentially in one process. The `BEGIN IMMEDIATE` at `src/store.mjs:56` is what prevents overbooking between processes; nothing exercises it under contention.

**Remediation.** Set `max_calls_per_day: 3`, spawn eight `ask` CLI processes with distinct keys simultaneously against the same store, and assert exactly three exit 0 with `status: queued`, five exit 3 with `budget_exhausted`, and `usage.reserved === 3`. Reuse the spawn pattern from `tests/room.test.mjs:23-33`.

#### S5. Process loss is simulated with SQL updates, not a killed worker

**Evidence.** `tests/worker.test.mjs:112-113` writes `status='running'` and inserts a claim by hand. That proves the recovery logic against a hand-made row, not that a real crash leaves the store in that shape.

**Remediation.** Add a child script inside the test that opens the store, builds a `Worker` with a fake adapter whose `run` writes a marker file then awaits forever, and calls `runOnce()`. The parent waits for the marker, sends `SIGKILL`, then asserts: `inspectRecovery` reports `owner_alive: false`; `claim()` from the parent returns `busy` with `recovery_required: true`; `recover` without `confirmStopped` is `invalid_input`; `recover --confirm-stopped` yields `interrupted_unknown` with the ledger `started`; `retry` then succeeds and reserves a new slot. Add the `preparing` variant with a blocking `prepare` for S1.

#### S6. Untested guards on documented behavior

- Stale-citation acceptance refusal at `src/room.mjs:198`: README promises it; no test. Test: succeed a job, post an operator correction so `stale_context=1`, then `decide` accepted citing the reply id, assert `conflict`.
- Capability expiry at `src/store.mjs:104`: no test. Test: `attachActor` with `lifetime_days: 1`, then `UPDATE actor_sessions SET expires_at='2000-01-01'` and assert `auth_required` on the next `Room` construction. Also assert the operator token works after restore issues a new one and the old one is refused.
- `ask` idempotency conflict: only `post` is tested (`tests/room.test.mjs:16`). Test the same key with different recipients returns `conflict` and reserves nothing.

#### S7. A deduplicated follow-up is dropped without a record

**Evidence.** `src/worker.mjs:192` `continue`s when a job with the same causal key exists. If two first-round answers both target the same participant, the second answer's follow-up question is discarded and no `job_events` row says so. Observability only; no allowance leaks.

**Remediation.** Emit `this.store.event(parent.id, 'follow_up_not_queued', { reason: 'duplicate_target', target })` before the `continue`. Test: two fake first-round answers both targeting astra; assert one round-1 job and one `follow_up_not_queued` event on the second parent.

**Approval required.** Worker path; additive event only.

### 3.3 Contract drift between README, help text and code

| ID | Claim | Reality | Fix |
|---|---|---|---|
| D1 | Help lists every command and flag | `bin/agent-room.mjs:12-48` omits `constraint list`, `source list`, `decision list --history`, `--reply-to`, `--sources`, `--optional`, `--revision`, `--citations`, `--expected-context-version`, `--label`, and `--limit` on `jobs`, `search`, `read` | Add each to the help block in the same commit as any parser change |
| D2 | README: "All command output is JSON" | `--json` at `bin/agent-room.mjs:49` is accepted and ignored | Remove the flag and the `Common:` mention. **Approval required** (flag removal). If kept, document it as accepted for compatibility and a no-op |
| D3 | README: "Use `--revision COMMIT` ... or `--working-tree`" | With neither, `src/sources.mjs:29` defaults to `HEAD` and requires git; in a non-git project the default fails with the opaque message in C3. Help shows only `--working-tree` | README: state that the default is the committed `HEAD` version and requires a Git repository; C3 gives the hint message |
| D4 | README: packets include "accepted decisions" | `src/context.mjs:21-25` includes every current-version decision of every status, excluding sibling proposals citing post-boundary consultant messages in an independent first round | README: "current decisions of every status, with rejected and superseded alternatives" |
| D5 | README: "The operator can lower these limits" | `src/contracts.mjs:66-70` allows raising per-thread to 100, per-day to 1000, packet to 128 KiB; timeout 600 s and output 2 MiB are true ceilings. `policy enable --max-calls` sets `max_calls_per_day`; the README never says which limit | README: give the exact bounds per field and say `--max-calls` is the UTC-day limit |
| D6 | README: Node "24.20+ within major 24, or major 26" | `src/doctor.mjs:16` prints `required_node: '24.20.x or 26.x'`; the guard at `:10` accepts 24.21 and later | Change the string to `>=24.20.0 <25 or >=26.0.0 <27` |
| D7 | "Every documented limit has a number" | Undocumented: message and question body 16,000 chars (`src/room.mjs:105`, `:224`); constraint 8,000; decision statement 2,000 and rationale 4,000; thread title 200; actor name and run id 100; CLI body 64 KiB (`bin:70`); JSON input 128 KiB (`bin:80`); HTTP body 128 KiB; search query 300 chars, 12 terms, 1 to 5 hits; `read` page 1 to 100; `jobs` limit 1 to 500; source read 1 to 8192 bytes; agent lifetime 1 to 30 days, settable only through `call --action actors.attach`; export includes at most 500 jobs (`src/room.mjs:273`) | Put the full table in `docs/reference.md` and link from README |
| D8 | README: CLI and browser use "the same command contracts" | HTTP status mapping at `web/server.mjs:13` is undocumented: 401, 403, 404, 409, 500 by code, everything else 400 | Document in `docs/reference.md` |
| D9 | Exit code table is a contract | Only 0, 2, 3 are exercised (`tests/surfaces.test.mjs:18-21`) | C1's table test covers 2, 3, 4, 5, 6, 7 |
| D10 | README: restore "marks restored in-flight work uncertain" | `src/store.mjs:181-183` does it; no test creates a `running` job before backup | Test: set a job `running`, back up, restore, assert `interrupted_unknown` and a `restored_uncertain` event |
| D11 | README: "The local operator capability lasts 365 days" | `src/store.mjs:97`. After expiry every command including `init` fails `auth_required` because `ensureOperator` at `:91-95` authenticates the file. No renewal is documented | Document: delete `operator.token` and run `init --operator` again, which issues a new operator; old messages keep their author id. Or add `actor renew --operator` later |
| D12 | README source denylist: "excluding sensitive paths" | `src/sources.mjs:6` also refuses any directory segment named `memory`, `secret`, `secrets`, `credential`, `credentials`, and any file name containing `credentials` or `sensitive`, `*.key`, `*.pem`. A project with `src/memory/` cannot capture from it | Document the exact list; consider narrowing `memory` to `agent-memory` |
| D13 | README agent list: "cannot accept decisions, alter execution policy, register projects, or run the worker" | Also true and untested through the CLI: attach, retry, backup, thread status, constraints, recover. Agents can cancel any job in their project (`src/room.mjs:242`), which releases a queued reservation; README does not say so | README: add cancel to what agents can do; test the forbidden matrix through the CLI |

### 3.4 Missing test coverage

Beyond S2 through S6 and D9, D10:

| ID | Gap | Test to add |
|---|---|---|
| T1 | Git `--revision` and default `HEAD` capture (`src/sources.mjs:28-33`) | Commit a file, capture at `HEAD` and at an explicit hash, assert `revision` is the 40-char commit and `working_tree` is 0 |
| T2 | 1 MiB cap in both modes | Part of C3 |
| T3 | `serve` CLI entrypoint (`bin/agent-room.mjs:101-106`) | Spawn `serve --operator --port 0`, parse the `listening` line, assert `url` starts with `http://127.0.0.1:`, wrong Host gets 403, `session_url` contains `#token=`, `SIGTERM` exits 0 |
| T4 | `AGENT_ROOM_TOKEN`, `--token-file`, `AGENT_ROOM_STATE_DIR`, `XDG_STATE_HOME` | CLI runs with each; `stateRoot(env)` unit test for the three-way precedence |
| T5 | Agent-forbidden matrix through the CLI | One test looping over `project register`, `actor attach`, `retry`, `backup`, `work --once`, `constraint set`, `thread status`, `recover`, asserting exit 3 `forbidden` |
| T6 | `decision reject` and `supersede`; `thread status resolved` gating (`src/room.mjs:74`); `project move` | Direct `Room` tests plus one CLI pass |
| T7 | `execute()` for `context.preview`, `event`, `jobs.inspect`, `jobs.recover`, `jobs.reconcile-capture`, `worker.once` | Drive through `execute()` with a mock worker in `services` |
| T8 | Worker timeout accounting | Fake adapter throws `RoomError('timeout', ..., { spawned: true })`; assert status `failed`, `error_code: timeout`, ledger `started`, `work --once` exit 6 |
| T9 | Full `doctor()` | Part of S2 |
| T10 | Non-UTF-8 and NUL-containing sources refused (`src/sources.mjs:35-36`) | Write `Buffer.from([0xff,0xfe])` and a file with a NUL; assert `invalid_input` |
| T11 | `runtimeReport` version logic | Extract `supportedRuntime(version, platform)` as a pure function and test 24.19.9, 24.20.0, 24.21.0, 25.0.0, 26.0.0, 27.0.0, and `linux` |
| T12 | `package.json` has no `dependencies` | One assertion in `portability.test.mjs` |

### 3.5 Structural problems

#### X1. Two formatting styles; the compressed one is unmaintainable

**Evidence.** `contracts.mjs`, `store.mjs`, `room.mjs`, `sources.mjs` use conventional spacing. `bin/agent-room.mjs`, `commands.mjs`, `context.mjs`, `worker.mjs`, `adapters/*`, `doctor.mjs`, `web/*` and every test are compressed with no spaces after commas or around operators and with statements chained on one line. Examples: `src/room.mjs:153` is a 330-character SQL template; `src/worker.mjs:93` is a 400-character object literal; `src/context.mjs:94` returns a 12-field object on one line; `src/worker.mjs:71-129` is the whole worker lifecycle in one 58-line try block with no blank lines. A second engineer will reformat before reading, and every later diff will then be unreviewable against history.

**Remediation.** Pick one style and apply it in a single behavior-preserving commit before any functional change, so later diffs are readable. Recommended: add `prettier` as a pinned devDependency with the stated reason "reproducible formatting; no runtime impact", a `.prettierrc` with `printWidth: 110, singleQuote: true`, scripts `format` and `format:check`, and run `format:check` at the start of `npm test`. Commit message: "style: format source tree with Prettier; no behavior change". Verify with the full suite and by confirming `git diff --stat` touches no test expectations. **Approval required** for the dependency. Fallback without a dependency: hand-format only files touched by functional commits, and add `.editorconfig`.

#### X2. Command metadata is duplicated between `bin` and `commands`

**Evidence.** `bin/agent-room.mjs:108` is a hand-written expression listing which commands and `call` actions do not need a project. `src/commands.mjs:22-76` is the dispatch. When an action is added to one, the other silently drifts; missing-thread handling is nowhere. See C2's `ACTIONS` table remediation, which fixes both.

#### X3. `workflowEvent` lives in the dispatch module

**Evidence.** `src/commands.mjs:5-21` is domain logic that opens a thread and asks; `commands.mjs` is otherwise pure routing. Move it to `src/triggers.mjs` and import it. Behavior-preserving.

#### X4. `Worker.runOnce` does eight things in one try block

**Evidence.** `src/worker.mjs:71-129`: claim, refresh sources, build packet, prepare, rebuild, write artifacts, launch transaction, heartbeat, run, cancel check, persist, follow-ups, failure accounting. It is correct today; it is hard to prove correct after a change. A split into `prepareJob`, `launch`, `runAdapter`, `recordFailure` is possible, but it is a worker-path refactor. Recommendation: defer until S1, S5 and T8 tests exist, then refactor under those tests with explicit approval.

#### X5. Dead fallbacks in the UI

**Evidence.** `web/app.js:69` reads `s.size_bytes ?? s.size`; the schema has only `size` (`migrations/001-initial.sql:11`). `web/app.js:138` reads `packet.bytes ?? packet.byte_length ?? ...`; `buildPacket` returns only `bytes` (`src/context.mjs:94`). Delete the fallbacks.

#### X6. The serve worker loop spins on `busy`

**Evidence.** `web/server.mjs:25` schedules the next tick at 25 ms for every result other than `idle`, including `busy` returned by `claim()` at `src/worker.mjs:46` when another process, possibly dead, holds the claim. That is about 40 SQLite reads per second until the operator recovers, with no signal in the UI beyond `last_result`.

**Remediation.** `const delay = { idle: 1000, busy: 1000 }[lastResult?.status] ?? 25;` and, when `busy` carries `recovery_required: true`, stop the loop and leave `last_result` visible so the UI can say recovery is needed. Test with an injected worker returning `busy` and a counter: assert at most a handful of calls per second.

#### X7. Unexpected server errors are invisible

See C2 step 3.

### 3.6 Developer-experience friction

| ID | Friction | Remediation |
|---|---|---|
| E1 | No debugging reference. The README is the only document and mixes install decisions with contract detail. The `call` action vocabulary exists only in `src/commands.mjs`; `job_events` names only in `src/worker.mjs`; job directory files only in `src/store.mjs:146`; state layout nowhere | Add `docs/reference.md`: state directory layout; job directory files and what writes them; `job_events` names; error code vocabulary with exit codes and HTTP statuses; every `call` action with required scope, role, and data keys; policy fields with bounds; every limit from D7; source denylist; capability lifetimes and renewal. Link from README "Development verification" |
| E2 | Test prerequisites are unstated: `git`, `npm`, `bash`, `ps` must be on PATH; `installation.test.mjs` runs `npm pack` and `npm install --offline` | One sentence in README and `docs/reference.md` |
| E3 | Git failures give no reason | C3 |
| E4 | No `.editorconfig` or formatter | X1 |
| E5 | Default `source add` requires git and fails opaquely | C3, D3 |
| E6 | `--lifetime-days` is not a CLI flag; the README's "seven days by default" implies a knob that only `call --action actors.attach --input-file` exposes | Either add `--lifetime-days` to `actor attach` (**approval required**, new flag) or document the `call` route |
| E7 | Cancelling a terminal job returns success and appends a `cancel_requested` event every time (`src/room.mjs:246-250`) | Return `conflict: Job is already finished` for statuses outside `queued`, `preparing`, `running`. **Approval required** (JSON behavior change) |
| E8 | Codex parser lets a second final `agent_message` in one turn overwrite the first (`src/adapters/codex.mjs:31-37`) | Option: fail `client_unsupported: Fresh consultation emitted more than one final assistant message`. The live pilot passed with the current behavior, so treat as an open question rather than a defect |

---

## 4. README cross-check summary

Every command, flag, default and exit code named in the README exists in code. Discrepancies are D1 through D13 above. Claims that exist in code but have no test: the client-version gates (S2), policy bounds (S3), stale-citation refusal and capability expiry (S6), `--revision` capture and the 1 MiB cap (T1, T2), `serve` from the CLI (T3), environment overrides (T4), the agent-forbidden matrix through the CLI (T5), `decision reject`/`supersede` (T6), restore marking in-flight work uncertain (D10), and exit codes 4 through 7 (D9).

---

## 5. Invariants that remediation must preserve

- No runtime npm dependencies. Dev dependencies need a stated reason.
- Runtime guard: Node 24.20+ within major 24, or major 26; built-in SQLite with FTS5 only.
- Server binds only `127.0.0.1`, validates Host and Origin, requires a capability on every API call, never opens a browser.
- Execution starts disabled. Only `ask` reserves; only an enabled allowance plus a started worker executes.
- Reservations are atomic. A launched invocation counts even when malformed or interrupted. Only a confirmed pre-spawn failure releases. S1 releases only rows still in `reserved`, which is the durable proof that launch never happened.
- No fallback model or billing route. Pinned client versions refuse otherwise. Adapters never receive general API key environment.
- Strict JSON envelope with packet citations; tool activity, unexpected native events, invalid terminal output and invented citations never become answers.
- Only an operator accepts, rejects or supersedes a decision. Agents cannot accept decisions, alter policy, register projects, or run the worker.
- Recovery never touches a live claim. Retry is explicit and never automatic.
- Source capture stays bounded: UTF-8, 1 MiB, inside the project, sensitive paths excluded, escaping symlinks rejected.
- Failures keep their original reason; exit codes follow the README table.
- Schema mismatches and malformed stores refuse; no empty fallback database.
- State, blobs, configuration, packets and capabilities live outside the package.
- Toolkit integration stays in small adapters.
- No test may spawn a real OpenCode or Codex process, read a real state directory, or consume model quota. Fake executables in S2 are scripts written by the test.

---

## 6. Items that need operator approval before implementation

| Item | Change | Blast radius | Migration |
|---|---|---|---|
| C1 | Leaked `ENOENT`-style codes become `invalid_input`, `not_found`, `auth_required`; exit 5 becomes 2 or 3 for those inputs | Scripts matching undocumented codes | None; documented table already promised these |
| C3 | Oversized committed file: exit 2 becomes 7 | None known | None |
| C4 | Consultant bad `source_id`: `error_code` `not_found` becomes `invalid_output` | Job records for this one failure | None |
| S1 | Confirmed-stopped recovery and restore release ledger rows still in `reserved` | Recovered `preparing` jobs stop consuming thread allowance | Run `recover --confirm-stopped` once per already-leaked job |
| S7 | New `follow_up_not_queued` event reason `duplicate_target` | Additive | None |
| D2 | Remove `--json` | Callers passing `--json` get `Unknown option` | Drop the flag from scripts; output was always JSON |
| E6 | Add `--lifetime-days` to `actor attach` | Additive | None |
| E7 | `cancel` on a finished job returns `conflict` | UI Cancel button already hides for finished jobs | None |
| X1 | Prettier devDependency and one formatting commit | Every file; no behavior | Rebase in-flight branches on the formatting commit |

---

## 7. Suggested order of work

1. Formatting decision and commit (X1), so every later diff is readable.
2. Error-code conformance and command metadata table (C1, C2, C6, X2, X7) with the exit-code table test.
3. Source capture (C3, T1, T2, T10).
4. Adapter strictness and inspect tests (C5, S2, T9).
5. Contract tests (S3, S4, S6, T3 to T8, T11, T12, D9, D10).
6. Worker and recovery (S5 kill harness; S1, C4, S7 after approval).
7. Serve loop backoff and UI dead code (X6, X5).
8. Documentation (D1, D3 to D8, D11 to D13, E1, E2, E6) and the doctor string (D6).
9. Structure (X3; X4 only under the new tests and with approval).

Rough effort: 1 is an hour; 2 through 4 about a day; 5 and 6 about a day; 7 through 9 half a day.
