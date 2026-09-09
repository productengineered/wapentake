# Wapentake implementation

Wapentake 0.3.0 is a standalone repository on `main`. It owns its releases and shared Mac installation; toolkit adapters remain optional. The extracted development history is documented in [provenance](provenance.md).

| Work package | Status | Evidence |
|---|---|---|
| ROOM-01 contracts/runtime | Offline implemented | Strict contracts, runtime doctor, Node 24.20.0 and 26.0.0 macOS verified; Mac is the supported scope |
| ROOM-02 durable CLI | Offline implemented | Immutable messages, project/actor scope, versioned decisions, restart/export/backup |
| ROOM-03 context/retrieval | Offline implemented | Bounded packets, old rationale retrieval, human constraints, freshness/stale answers |
| ROOM-04 provider adapters | macOS live pilot verified with limits | GLM exact session route verified; requested Astra replies validated; Codex resolved identity unreported |
| ROOM-05 worker/recovery | Offline implemented | Single claim, allowance, timeout/output cap, cancellation, killed-worker recovery and backup uncertainty; launched inference remains charged when metadata capture fails |
| ROOM-06 live discussion/inbox | Local live trace complete | Six launches, five validated replies, one retained failure; fresh-session retrieval; inactive sessions are not woken |
| ROOM-07 local interface | Browser verified with fake providers | Post/invite/context/source/decision/cancel/export/reload; desktop/mobile inspected |
| ROOM-08 bounded triggers | Offline implemented; opt-in remains off | Idempotent advisory events and at most one follow-up round |
| ROOM-09 portability/pilot | Standalone packaging, shared updates and local live pilot implemented | Two toolkit adapters use one installation; updates preserve history; real workflow adoption remains optional follow-up |

The [verification record](verification.md) maps acceptance cases to evidence and limitations. The [live pilot](live-pilot.md) used exactly six approved calls through existing plans; execution is now paused. Consultant design proposals remain for human review.

The [archived design](design.md) preserves the initial requirements. This is a usable Mac development preview with a local repository, installer and package archives. The private `productengineered/wapentake` repository is connected as `origin`. The first push and a published release remain pending. Existing toolkit workflow files, release versions and consumer task stores remain unchanged. Linux and Windows are outside the current scope.

The 0.2.0 [consumer contract](consumer-upgrade.md) adds named-job execution, scoped runners, normalized export provenance and an explicit backup-first database migration. [Model profiles](models.md) keep user defaults and per-consumer choices outside repositories and freeze settings per job. External adjudicator resolver adoption and formal receipt bridges remain consumer work; Codex resolved identity remains unverified.

Version 0.3.0 adopts Wapentake as a flat rename for the package, CLI, browser, launcher and default paths. Database and export schemas remain at 2; model configuration remains at schema 1.
