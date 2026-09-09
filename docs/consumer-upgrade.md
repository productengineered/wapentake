# Wapentake 0.2.0 consumer contract

> This records the 0.2 consumer contract. Commands below use the Wapentake name introduced in 0.3.

This release implements named-job execution (R1), a scoped runner capability (R2), the distinct release (R3), and normalized export provenance (R4). It adds user-owned model profiles and a shared resolver. Codex resolved model identity remains an open limit (R5): the current verified client did not report it in the live pilot, so Astra remains advisory wherever a consumer requires independently verified identity.

The shared entry point is `~/.local/share/wapentake/current/node_modules/@productengineered/wapentake/bin/wapentake.mjs`. The launcher template is `integrations/wapentake.sh`. `--version` returns JSON containing `version: "0.3.0"`, `database_schema: 2`, `model_config_schema: 1`, and `export_schema: 2`. Consumers should inspect these contracts before adopting the new workflow.

## Upgrade an existing store

Finish or cancel active consultations, pause execution, and stop every old viewer, worker and other writer using that store. Old processes keep their installed release and must not remain connected during migration. Resolve any abandoned worker claim with the previous release's recovery commands after confirming the processes have stopped.

```sh
wapentake policy pause --operator --state-dir /absolute/path/to/state
# Stop the old viewer/worker processes, then install 0.2.0 from its repository.
npm run install:local
wapentake migrate --operator --state-dir /absolute/path/to/state \
  --backup-out /absolute/path/to/new-pre-0.2-backup
wapentake serve --operator --state-dir /absolute/path/to/state --port 8741
```

The migration requires paused execution and no active or unresolved preparing/running jobs. It creates a consistent backup before changing schema, checks again for active work and concurrent writes, and applies changes transactionally. The backup destination must be new and outside the active state. Refused or failed migrations preserve schema 1. Existing messages, sources, decisions, job IDs, allowance and capability tokens remain. Old jobs receive a frozen snapshot of their original requested model and Astra's original low effort. Existing agent capabilities gain no execution scope. Execution remains paused.

Ordinary 0.2 commands refuse schema 1 until migration; `policy pause`, `policy show`, `backup` and `migrate` remain available. Fresh stores start on schema 2. Never point 0.1 at a migrated database. To roll back, restore the pre-upgrade backup into a new state directory and select the matching old application archive. Restore revokes capabilities, creates a new operator token and disables execution. Keep both original directories until the restored history is inspected. A schema-1 backup restored using 0.2 reports `migration_required: true` and can be migrated with a second backup if staying on 0.2.

Create and select [model profiles](models.md) separately. Installation and migration never create or overwrite a user's model file, and changing a profile affects new invitations only.

## Autonomous coordinator execution

The operator issues a runner for one project and active run:

```sh
wapentake actor attach --operator --project PROJECT_ID \
  --name claude:coordinator --run-id EPIC_ID --role runner --lifetime-days 7
```

Give the coordinator only the returned `token_file`. It can perform ordinary agent actions and execute jobs created by its own invitations:

```sh
wapentake ask --token-file /path/to/runner.token --project PROJECT_ID \
  --thread THREAD_ID --to glm,astra --body-file question.txt --key review-1
# Run each returned job ID explicitly.
wapentake work --token-file /path/to/runner.token --project PROJECT_ID --job JOB_ID
```

The coordinator must check the process exit code, returned `job_id`, and `status`. Exit 0 means that exact job reached `succeeded`. Other terminal statuses return nonzero. A nonqueued job refuses with `conflict` (exit 4); a missing job returns `not_found` (exit 2), and a foreign project refuses authorization (exit 3). An occupied singleton worker returns `conflict`, including the requested `job_id` and `blocking_job_id`. The blocker is null when its project is outside the caller's scope. No other queued job is substituted. A disabled policy or exhausted allowance refuses execution; it does not become a successful empty result.

The library equivalent is `await new Worker(room).runJob(projectId, jobId)`. CLI `call --action worker.job --project PROJECT_ID --input-file job.json` reads `{"id":"JOB_ID"}` from the file. HTTP `/api/command` receives `{"action":"worker.job","project":"PROJECT_ID","data":{"id":"JOB_ID"}}`. HTTP uses the requesting capability's authority even when the server has an operator worker and wraps the result in its existing `{"result":...}` or `{"error":...}` envelope.

`work --once` retains its operator-only FIFO behavior, including exit 0 for idle/busy. A runner cannot use it, start the server worker, accept decisions, change policy, register projects, recover claims or grant capabilities. Runner ownership is persisted with each job, rather than inferred from a mutable client-supplied key. Retries and follow-ups retain the original invitation owner. The operator can run any authorized project's named job. Capabilities expire after seven days by default; `--lifetime-days` accepts 1-30 days. Issue a new capability for a new active run; it does not acquire the old run's jobs.

Revoke a runner as the operator:

```sh
wapentake actor revoke --operator --project PROJECT_ID --id ACTOR_ID
```

Authorization is rechecked at claim, before launch, during execution and before accepting output. Revocation before launch releases a confirmed unused reservation; revocation after launch retains the charge and prevents normal answer promotion. Revocation does not delete the conversation.

The operator must supply an explicit bounded allowance for real model calls. An already attached runner does not enable execution. The default 600-second limit applies to each provider subprocess; client inspection and OpenCode metadata capture add time. A synchronous consumer must allow that overhead and handle uncertain termination using the existing recovery rules. It must not treat 600 seconds as an end-to-end guarantee or automatically retry a lost result.

For a four-call peer engagement, set `max_calls_per_thread: 4` through the operator's `policy.update` action and use a dedicated thread. `policy enable --max-calls 4` sets the store's UTC-day allowance; it is not a four-call lifetime grant. A consumer must close a finished engagement and track any separate pilot-wide ceiling. Leave `automatic_follow_up_rounds` at 0 and `enabled_triggers` empty until explicitly authorized. Do not pass `WAPENTAKE_TOKEN` for an agent alongside `--operator`; use the operator's own terminal environment.

## Export and receipt integration

`export --out /new/directory` writes `records.json`, Markdown and captured sources. Records use schema 2. Each consultant message carries `provenance`; `records.jobs[*].provenance` carries the same record, including failed or unfinished jobs with no message. All jobs in the selected thread are included even when more than 500 newer jobs exist elsewhere in the project.

| Field | Meaning |
|---|---|
| `job_id`, `message_id`, `owner_actor_id` | Stable job/message linkage and invitation owner |
| `requested_model`, `observed_model` | Requested model and client-reported identity, or null when unreported |
| `model_identity_verified`, `model_identity_source`, `session_id` | Identity evidence and native session identifier; unknown remains explicit |
| `reasoning_effort`, `model_selection`, `model_selection_hash` | Frozen role/profile/model settings and their fingerprint |
| `packet_hash`, `configuration_hash` | Exact dispatched prompt and packet construction configuration hashes |
| `omissions`, `coverage`, `source_manifest` | Full recorded omissions, coverage summary and selected source byte ranges/hashes |
| `adapter`, `client_version` | Execution route and captured client version |
| `packet_metadata_hash`, `output_metadata_hash`, `session_verification_metadata_hash` | Hashes of saved metadata files |
| `metadata_status`, `missing_captures` | `captured`, `not_prepared` or `incomplete`; missing legacy captures are not invented |
| `consultation_status`, `response_kind`, `stale_context` | Execution outcome, response type and changed-context indicator |

Export verifies saved packet hashes, reported model consistency and the response's link to its immutable message. Early GLM replies with identity saved in a separate session verification file can use that evidence only after matching the same requested model, provider, session and tool-free completion. Corrupted captures refuse. Missing captures are explicit and must fail any consumer gate that requires them. Native event streams, operator capabilities and client inspection details are not copied into normalized provenance. The regular export still contains the selected conversation and sources; use the consumer's normal artifact handling rules.

A `succeeded` consultation may contain `needs_context` or `abstain`. Neither success, agreement nor a proposed decision is a passing review or a human disposition. A receipt bridge must also check response kind, staleness, required provenance, exact evidence coverage, independent reviewer identity and the consumer's receipt schema. Codex `observed_model` remains null unless the client actually supplies a model in its supported thread event. Parsing support for such an event is not evidence that the current client emits one. Existing GLM session verification remains enforced.

## Consumer-owned follow-up

Consumers can now add named-job result checking and the runner flow to their workflow documentation and adapter tests. A formal receipt bridge and adoption of the adjudicator model resolver still require changes in the consumer. Wapentake does not write task stores or bypass existing gates. The launcher contract is unchanged; the optional `/room` instruction template documents the new scoped execution path.
