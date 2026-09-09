# Changelog

## 0.3.0 -- Wapentake

- Rename the package to `@productengineered/wapentake`, command to `wapentake`, and browser interface to Wapentake.
- Use `WAPENTAKE_*` settings, Wapentake installation/configuration/state paths and the `/wapentake` integration template.
- Retain database schema 2, export schema 2 and model configuration schema 1. This is a flat rename with no legacy command or path aliases.
- Add Mac CI, local secret hooks, trusted repository and CodeRabbit review gates, dependency checks, and verified draft releases with protected version tags. Publication remains manual.

## 0.2.0 -- consumer execution and model profiles

- Add `work --job <id>` (R1): execute exactly one queued job, return its ID/status, and exit 0 only on success. Preserve operator FIFO `work --once` semantics.
- Add operator-issued project runner capabilities (R2), restricted to jobs from that actor's own invitations. Preserve operator-only policy, decisions, recovery and global worker controls; document expiry and revocation. Prevent HTTP requests from borrowing the server worker's operator authority.
- Add user-owned model defaults and consumer profiles, CLI initialization/validation/resolution and a `./models` library export. Freeze model/reasoning/profile settings when jobs are queued; preserve them for execution, retries and follow-ups. The opt-in example requests Astra high effort and `openai/gpt-5.6-sol` for external adjudicators.
- Export records schema 2 (R4) with per-message/job model identity, session, packet/configuration hashes, full recorded omissions and coverage. Include older thread jobs beyond the project listing limit; validate captures and report missing provenance explicitly.
- Upgrade database schema 1 to 2 only through explicit `migrate --operator --backup-out`: require stopped writers and paused execution, back up first, preserve legacy job settings and roll back failures. Ordinary operations refuse an unmigrated store. See `docs/consumer-upgrade.md`.
- Cut the distinct 0.2.0 release (R3). The shared installation entry point and `integrations/room.sh` remain unchanged. Model configuration schema is 1; database and export schemas are 2.
- Record a Codex thread event's model identity when present. The verified live client still left the resolved identity unknown (R5); parsing support does not establish a new live verification claim or formal adjudication authority.
- Release confirmed pre-launch reservations after stopped-worker recovery, including leaks left by an older release. Preserve charged launches and uncertainty inherited from backups.
- Preserve the launched inference charge when OpenCode's later metadata-export subprocess cannot start. Reject missing or malformed session IDs before export.
- Validate project, thread, message, source and job identifiers before SQLite access. Return documented CLI/HTTP input errors, authentication errors for missing capability files, and typed failures for malformed events and occupied ports; retain underlying system causes.
- Report oversized committed sources as `needs_scoping`, matching working-tree capture, and retain bounded Git failure diagnostics.
- Classify a consultant's request for an unknown source as `invalid_output` while retaining its launched charge.
- Add fake-client gate tests, policy-boundary tests, concurrent reservation checks, and worker crash/recovery regressions. Keep the compatible `--json` flag and document default Git capture and recovery behavior.

## 0.1.0 -- standalone Mac development preview

- Extract the package into its own repository, preserving its three development commits.
- Add a shared Mac installer with staged releases, archive hash checks and independent updates. Toolkit adapters use the shared installation and retain project-scoped history across updates.
- Add JSON version reporting, Mac platform constraints, working rules and independent release documentation.

- Add portable SQLite-backed projects, immutable messages, actor-scoped inboxes, explicit invitations, versioned human constraints and decisions.
- Capture selected evidence and build bounded, inspectable consultant packets with independent initial answers and changed-context tracking.
- Add strict OpenCode GLM Coding Plan and Codex ChatGPT adapter profiles, a single worker, local allowance reservations, cancellation and uncertain-run recovery.
- Add a loopback browser interface, CLI exports, verified backup/restore and opt-in advisory workflow events.
- Validate six plan-backed macOS calls; preserve known Codex startup diagnostics, verify GLM session model identity and recover truncated metadata exports without new inference.
- Preserve independent first-round boundaries across late human citations and explicit retries. Persist client exit receipts for auditable capture reconciliation.
- Correct omitted-history counts when focused threads cite messages from an earlier discussion.
- Mac is the supported platform. Real workflow adoption remains separate; Codex resolved model identity is unreported.
