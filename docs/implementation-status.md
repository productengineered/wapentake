# Agent Room implementation

Development branch: `codex/agent-room`. Source lives under `packages/agent-room/` in an isolated worktree of the toolkit. The active cleanup owns shared workflow/tracker/release files until the coordinated integration boundary.

| Work package | Status | Evidence |
|---|---|---|
| ROOM-01 contracts/runtime | Offline implemented | Strict contracts, runtime doctor, Node 24.20.0 macOS verified; Linux pending |
| ROOM-02 durable CLI | Offline implemented | Immutable messages, project/actor scope, versioned decisions, restart/export/backup |
| ROOM-03 context/retrieval | Offline implemented | Bounded packets, old rationale retrieval, human constraints, freshness/stale answers |
| ROOM-04 provider adapters | macOS live pilot verified with limits | GLM exact session route verified; requested Astra replies validated; Codex resolved identity unreported |
| ROOM-05 worker/recovery | Offline implemented | Single claim, allowance, timeout/output cap, cancellation and uncertain recovery fixtures |
| ROOM-06 live discussion/inbox | Local live trace complete | Six launches, five validated replies, one retained failure; fresh-session retrieval; inactive sessions are not woken |
| ROOM-07 local interface | Browser verified with fake providers | Post/invite/context/source/decision/cancel/export/reload; desktop/mobile inspected |
| ROOM-08 bounded triggers | Offline implemented; opt-in remains off | Idempotent advisory events and at most one follow-up round |
| ROOM-09 portability/pilot | Archive fixture and local live pilot passed; actual adoption pending | Clean install, project separation, fresh processes, thin launcher |

The [verification record](verification.md) maps acceptance cases to evidence and limitations. The [live pilot](live-pilot.md) used exactly six approved calls through existing plans; execution is now paused. Consultant design proposals remain for human review.

The source design is `internal-planning/codex/persistent-agent-room-design-2026-09-07.md` in the parent checkout. No shared toolkit command, tracker entry, sync script, root version, consumer implementation or task store has been changed by this package build. This is a reviewable development preview, not a completed supported release.
