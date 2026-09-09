# Wapentake

Wapentake is the project’s new name, starting with version 0.3.0.

A local conversation room for a human, active coding agents, GLM through OpenCode, and Astra through Codex. Messages, selected evidence and versioned decisions survive fresh agent sessions. The CLI and browser interface use the same command contracts.

**Status:** 0.3.0 standalone Mac development preview. Offline behavior and a six-call pilot through the existing plans are verified. The application has its own repository, installation and update path; toolkits connect through optional adapters. Actual workflow adoption remains separate. Codex does not report its resolved model identity. See [verification](docs/verification.md) for evidence and limits. Execution starts disabled.

## Runtime and installation

The supported platform is **macOS**. Node **24.20.0 on macOS arm64** and Node **26.0.0** are verified, including built-in SQLite and FTS5. The runtime guard accepts Node 24.20+ within major 24, or major 26. Linux and Windows are outside the current release scope.

There are no runtime npm dependencies. From this repository:

```sh
npm run install:local
~/.local/bin/wapentake --version
~/.local/bin/wapentake doctor --offline --runtime-only
```

This packs the source and installs an independent copy in `~/.local/share/wapentake/releases/`, then switches the `current` link after an offline runtime check. The shared command is `~/.local/bin/wapentake`. If that directory is already on your `PATH`, use `wapentake` directly; otherwise use the full path. The installer does not edit shell configuration.

For a 0.1 store, follow the [0.2 consumer upgrade](docs/consumer-upgrade.md): stop old processes and run the explicit backup-first migration before reopening it. Run the same installation command after updating this repository to apply an Wapentake update. Compatible toolkit adapters continue using the shared installation without a toolkit release. Running processes keep their existing release until restarted; the installer does not interrupt active consultations. See [installation and updates](docs/installation.md) for archive installs, retained versions and data handling.

For source development, run `node bin/wapentake.mjs` from this repository. The examples below use the installed `wapentake` command.

## Open a local room

Initialize explicitly as the human operator, using an existing project directory:

```sh
wapentake init --operator --project /absolute/path/to/project
wapentake serve --operator
```

Open the printed `session_url`. Its fragment carries the local operator capability; the page removes the fragment and keeps the capability in that tab's session storage. Treat this URL like the local operator token. The server binds only to `127.0.0.1`, checks Host and Origin, and requires a capability on every API call. It does not open a browser automatically.

State defaults to `$XDG_STATE_HOME/wapentake`, or `~/.local/state/wapentake`. Override it with `--state-dir` or `WAPENTAKE_STATE_DIR`. State, source blobs, configuration, job packets and capabilities live outside the installed package. They must not be copied into toolkit source or committed. The SQLite database requires a local filesystem; do not put the active store on a network drive or shared cloud-sync folder.

Opening the UI, posting, polling, searching, previewing context and exporting make no model calls. **Ask consultants** records an invitation and reserves allowance. Actual execution additionally requires an enabled allowance and a started worker. Stopping the worker stops new jobs; use Cancel to stop an active consultation.

## CLI conversation

Operational command output is JSON; `--help` prints usage text. `--json` remains accepted for compatibility and does not change the output. Supply `--project <id-or-path>` when the current directory does not identify one registered project. Copy returned IDs into subsequent commands; placeholder IDs below are not literal values.

```sh
wapentake thread open --operator --title 'Choose the failure contract' --mode independent
wapentake post --operator --thread THREAD_ID --body 'Preserve the original failure reason.'
wapentake constraint set --operator --thread THREAD_ID --body 'Use existing plan logins only.'
wapentake source add --operator --thread THREAD_ID --path docs/contract.md --working-tree
wapentake context preview --operator --thread THREAD_ID --for astra
wapentake ask --operator --thread THREAD_ID --to glm,astra --body-file question.txt --key question-1
wapentake read --operator --thread THREAD_ID
wapentake search --operator --query 'failure contract'
```

Use `--body-file` or `--body-stdin` for multiline content. `--key` makes a write idempotent; reusing a key with different input is an error. `post` treats quoted mentions as text. `ask` is the explicit invocation boundary. Independent mode gives first-round consultants the same question boundary and excludes each other's initial responses. New human instructions remain visible and can make an older response stale.

Source capture is explicit and bounded: selected UTF-8 files up to 1 MiB, inside the registered project, excluding sensitive paths and escaping symlinks. Capture defaults to committed `HEAD` and requires a Git repository. Use `--revision COMMIT` for a captured Git version, or `--working-tree` for current file content, including projects without Git. Both modes return `needs_scoping` when a file exceeds the limit. Working-tree captures are checked again before launch. Changed captures receive new identities; older evidence remains available for inspection.

Packets include the direct question, relevant human messages, pinned constraints, accepted decisions, unresolved claims, selected sources and bounded retrieval results. The default full prompt limit is 32 KiB. If required material does not fit, the job stops with `needs_scoping`. The packet hash, selection, omissions, byte count and estimated token count are inspectable. Token counts are estimates, not a quota measurement.

## Consultant execution

Client contracts remain pinned. [User model configuration](docs/models.md) selects explicit models and reasoning effort through these existing authentication routes:

| Participant | Client | Authentication route | Model |
|---|---|---|---|
| `glm` | OpenCode 1.18.18 | Saved Z.AI Coding Plan credential | `zai-coding-plan/glm-5.3` |
| `astra` | Codex 0.153.4 | Saved ChatGPT login | `gpt-6-astra` |

Create `~/.config/wapentake/models.json` with `wapentake models init --operator`. The example selects Astra high effort and includes `toolkit` and `5wth-ops` profiles. Set `WAPENTAKE_MODEL_PROFILE` in each consumer's local environment, or pass `--model-profile` to an invitation. Validate with `wapentake models validate`. Model selections are frozen when jobs are queued; updates to the file affect new invitations. Existing installations without a model file keep compatibility defaults, including Astra low effort. The same resolver exposes the external adjudicator selection to consumers that adopt it; it does not add another room participant.

```sh
wapentake doctor --offline
wapentake policy enable --operator --max-calls 6
wapentake work --operator --once
wapentake work --operator --once
wapentake policy pause --operator
```

`doctor` inspects runtime, help, saved login type and the isolated OpenCode permission configuration. It makes no inference calls and cannot prove account model access. Codex uses `--ignore-user-config`, a fresh ephemeral session, read-only sandbox and disabled tool features. OpenCode uses an isolated configuration, `--pure`, the explicit plan provider and a deny-tools consultant profile. Neither adapter receives general API key environment overrides. Neither changes authentication or falls back to another model or billing route. Changed client versions refuse until their event/configuration contracts are verified.

The global worker runs one consultant process at a time. Defaults are six calls per thread, twenty per UTC day across the store, no automatic follow-up, a 600-second timeout and a 2 MiB native output limit. The operator can lower these limits. Reservations are atomic; a launched invocation counts even if its result is malformed or interrupted. A confirmed pre-spawn failure releases its reservation. Native usage is recorded when available; remaining provider quota is explicitly unknown.

CLI `work --job JOB_ID` runs exactly that queued job in the foreground and exits 0 only for its successful completion. It uses an operator capability or a runner capability belonging to the invitation owner. An occupied worker refuses with a conflict; another job is never substituted. CLI `work --once` retains its operator-only FIFO behavior and exits 0 on idle or busy. The 600-second timeout applies per provider subprocess; inspection and metadata capture add time. The UI Start worker control, or explicit `serve --worker`, processes the queue until stopped, disabled, blocked by allowance, or a consultation error occurs. Ordinary `serve` does not start it.

Consultant responses must be a strict JSON envelope with valid packet citations. Tool activity, unexpected native events, invalid terminal output and invented citations cannot become normal answers. Consultants may propose decisions or request bounded context. Only an operator can accept, reject or supersede a decision. Stale consultant citations refuse direct acceptance until the changed context is reviewed.

## Active coding agents

Register a capability for a specific active run as the operator:

```sh
wapentake actor attach --operator --name claude:developer --run-id RUN_ID
```

Give that run only the returned `token_file` path. It uses `--token-file` or `WAPENTAKE_TOKEN` and omits `--operator`:

```sh
wapentake inbox --token-file /path/to/agent.token
wapentake read --token-file /path/to/agent.token --thread THREAD_ID
wapentake post --token-file /path/to/agent.token --thread THREAD_ID --body-file reply.txt
wapentake ack --token-file /path/to/agent.token --thread THREAD_ID --through SEQUENCE
```

Agent capabilities are scoped to one project and expire after seven days by default. The local operator capability lasts 365 days. Agents can post, read, invite within policy, and propose decisions. They cannot accept decisions, alter execution policy, register projects, or run the worker. An operator can explicitly attach a `--role runner` capability to allow execution of only that actor's invited jobs through `work --job`; it cannot run the global worker. Revoke it with `actor revoke --operator --id ACTOR_ID`. See the [consumer contract](docs/consumer-upgrade.md) for ownership, expiry, revocation and result checks. The local user remains trusted: capabilities separate application roles, not hostile processes running as the same OS account.

The inbox stays pending until that actor acknowledges it. Acknowledgment is not proof of comprehension. The room does not wake an inactive Claude session. The UI acknowledges only its own visible messages and never claims an agent has read them.

## Decisions, recovery and backup

```sh
wapentake decision propose --thread THREAD_ID --statement 'Return a typed failure' --rationale 'Keep the original reason visible'
wapentake decision accept --operator --thread THREAD_ID --stable-id DECISION_ID --statement 'Return a typed failure' --rationale 'Verified against the caller contract' --citations MESSAGE_ID
wapentake jobs --operator
wapentake cancel --operator --job JOB_ID
wapentake recover --operator --job JOB_ID --inspect
wapentake recover --operator --job JOB_ID --confirm-stopped
wapentake retry --operator --job JOB_ID --key retry-1
wapentake export --operator --thread THREAD_ID --out /new/export-directory
wapentake backup --operator --out /new/backup-directory
wapentake restore --operator --from /backup-directory --out /new/state-directory
```

A completed OpenCode response whose session metadata export failed can be reconciled without another model call: write `{"id":"JOB_ID"}` to a JSON file and run `wapentake call --operator --action jobs.reconcile-capture --input-file capture.json`. This narrow operation requires the original successful exit receipt and matching packet, revalidates native output and saved session metadata, retains the original failure event and charged allowance, and never queues a follow-up. Missing receipts or other failures refuse.

Never recover a live worker claim. Inspect the stored process identity and establish that the original worker and child have stopped before `--confirm-stopped`. Recovery retains `interrupted_unknown`. In the original store, a reservation still awaiting launch is released after that confirmation; a recorded launch stays charged. This also repairs preparation reservations left by an older release: run `recover --confirm-stopped` again for the affected job after verifying its processes are stopped. Jobs marked uncertain during restore retain their reservations, because an older backup cannot prove that the original worker never launched. Retrying is a new invitation and is never automatic for a lost process. Local cancellation cannot prove a remote service stopped processing.

Export includes Markdown, schema-2 JSON records and captured source blobs. Each consultant message and job carries normalized model/session/packet provenance, recorded omissions and metadata completeness; corrupt captures refuse. Unknown Codex model identity remains explicit. See the [export contract](docs/consumer-upgrade.md#export-and-receipt-integration) before building a receipt bridge. Backup uses SQLite's consistent backup facility and a manifest of referenced file hashes. Restore verifies the manifest into a new directory, revokes old capabilities, issues a new operator token, disables execution and marks restored in-flight work uncertain. Keep the original state until the restored store is inspected. Back up before upgrading. Newer database/configuration schemas and malformed stores refuse explicitly; there is no empty fallback database.

## Optional toolkit integration

The core does not require a `.claude` tree, task store or sibling consumer. [Integration instructions](integrations/README.md) provide a small launcher and `/wapentake` command. Only those small adapters belong in an adopting toolkit. The application and its updates stay in this repository and shared installation.

Disagreement and stuck-work triggers default off. Enable them explicitly with `call --action policy.update --input-file policy-patch.json` as an operator, adding them to `enabled_triggers`. A disagreement event needs both review references. A stuck event needs two distinct attempted fixes and the failure signature. Events have causal keys, reserve bounded invitations, and never change task state. Example payloads are in [examples](examples/README.md).

Automatic follow-up can be set to at most one round. It waits for initial answers to finish, only targets participants already in that discussion, and obeys the same thread/global allowance. Leave it off until the live pilot establishes useful behavior.

## Development verification

```sh
npm test
```

Tests create temporary stores/projects and use fake providers. They do not read real task databases or consume model quota. The optional `tests/browser-smoke.mjs` uses an explicitly supplied Playwright installation and a disposable browser context. The operator-authorized [live pilot](docs/live-pilot.md) records the observed native client compatibility and its limits.

Exit codes: `0` success, `2` invalid input/not found, `3` authentication/authorization/disabled/unsupported/allowance, `4` conflict, `5` storage failure, `6` provider/cancel/invalid-output failure, `7` context needs scoping. The JSON error code carries the precise reason. CLI file and startup errors retain the underlying system code in `error.details.cause`; missing capability files return `auth_required`. Missing project, thread or object IDs return `invalid_input` (HTTP 400), and Git capture failures include a bounded diagnostic in `error.details.git` on the CLI.
