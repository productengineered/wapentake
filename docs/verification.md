# Verification record

Development preview, 2026-09-08. The operator-approved macOS pilot used exactly six launched calls: five validated responses and one retained importer failure. Execution is paused.

| Surface | Result | Evidence / limit |
|---|---|---|
| Node 26.0.0, macOS arm64 | 39 tests passed | `npm test`, including package/install fixture and conservative recovery/native-terminal cases |
| Node 24.20.0, macOS arm64 | 39 tests passed | Official archive SHA-256 verified; same final test set |
| SQLite | 3.53.4, FTS5 available | Runtime doctor on both runtimes |
| Codex 0.153.4 | Live calls completed | Live requested `gpt-6-astra` through ChatGPT login; two validated replies after one startup-notice rejection; resolved identity unreported |
| OpenCode 1.18.18 | Three live replies validated | Saved Coding Plan route; exported session metadata confirms `zai-coding-plan/glm-5.3`; zero tool activity |
| Browser | Passed | Disposable Chrome, Playwright 1.58.1, synthetic data, three fake calls, zero real calls |
| Package portability | Passed | Pack, offline install, fresh-process post/read/decision/queue/export, second-project isolation, thin launcher |
| Linux | Pending | Existing Podman machine failed to start: gvproxy socket unavailable; confirmed stopped afterward |
| Toolkit regression suite | 25 suites passed | Isolated worktree baseline d0d04a1; includes instruction lint. Concurrent main cleanup changes are outside this result |
| Local live pilot | Completed within six calls | Fresh agent process and fresh GLM session retrieved an accepted operational decision; [trace](live-pilot.md) |
| Actual consumer adoption | Pending coordinated boundary | Portable install fixture passed; no real consumer modified |

The browser walkthrough covered literal HTML rendering, posting, invitations, cancellation, worker start/stop, source capture, human constraints, context preview, decision acceptance, export and reload. Screenshots were inspected at 1440px desktop and 390px mobile; neither had horizontal overflow. Passive reads launched no consultants. The in-app Browser could not start because the existing user Codex configuration contained an invalid feature type; that configuration was not modified.

## Acceptance mapping

| Design case | Offline evidence |
|---|---|
| A01 | `room.test.mjs`: twenty simultaneous processes, duplicate delivery, immutable ordered messages |
| A02 | `room.test.mjs`, `portability.test.mjs`: cross-project reads, searches and reference rejection |
| A03 | `room.test.mjs`, `portability.test.mjs`: fresh processes retain messages, accepted decision and queue |
| A04 | `room.test.mjs`, `surfaces.test.mjs`: impersonation refused; agents cannot accept decisions/change policy |
| A05 | `context.test.mjs`: old decision retrieved among 10,000 unrelated peer messages |
| A06 | `context.test.mjs`, `room.test.mjs`: latest exact human instruction and append-only versions |
| A07 | `context.test.mjs`: conflicting claims and unresolved objections retained |
| A08 | `context.test.mjs`: oversized required evidence refuses before launch |
| A09 | `context.test.mjs`: deterministic selection and packet hash |
| A10 | `worker.test.mjs`: queued source recapture and human change during a running consultation |
| A11 | `adapters.test.mjs`: final-channel contract and malformed/unknown terminal output refusal |
| A12 | `worker.test.mjs`, `adapters.test.mjs`: auth failure and pinned-model/no-API-fallback behavior; live route evidence in the pilot record |
| A13 | `worker.test.mjs`: two store connections cannot own one active worker claim |
| A14 | `surfaces.test.mjs`, `worker.test.mjs`: causal trigger idempotency and one follow-up round |
| A15 | `worker.test.mjs`: live owner not stolen; stopped recovery retains uncertain consumption without retry |
| A16 | `room.test.mjs`: atomic reservation/refusal with readable history |
| A17 | Room/surface tests and browser: mentions, inbox, polling and export cause no calls |
| A18 | `room.test.mjs`: escaping paths/symlinks and sensitive source paths refused |
| A19 | `adapters.test.mjs`: timeout, output cap, bounded diagnostics and split UTF-8 |
| A20 | `storage-safety.test.mjs`: malformed policy/DB, future schema and nonempty unversioned DB preserve data |
| A21 | `storage-safety.test.mjs`: backup during writes restores a consistent prefix and verifies source hashes |
| A22 | `surfaces.test.mjs`: opt-in advisory triggers; no task mutation interface |
| A23 | `portability.test.mjs`: archive excludes synthetic history/config/credentials; standalone and second-project operation |
| A24 | `surfaces.test.mjs`: operator acknowledgment leaves another actor's inbox pending |
| A25 | `worker.test.mjs`: independent initial packets exclude each other's first answer/proposal |
| A26 | `adapters.test.mjs`: tool activity and changed event types refuse |
| A27 | Room/adapter tests: unknown citations, role fields and contradictory response shapes refused |

The live trace records requested/observed identity, auth route, packet/configuration hashes, usage and latency. GLM session metadata proves its exact provider/model; Codex's native stream leaves resolved model identity unknown. The accepted decision records the operator's existing six-call approval; all three consultant design proposals remain proposed. A fresh registered agent process retrieved this decision, and a fresh GLM invocation reproduced its exact fields.

The original discussion needed 37,839 bytes of required material and refused before launch at the 32,768-byte limit. A focused thread carried the approved decision and original approval message in 6,780 bytes. This is evidence for explicit scoping and persistence, not automatic summarization of arbitrary history. The 10,000-message retention case remains an offline fixture.

Open limits: nested decision references and source bytes are not automatically expanded just because a decision cites them; attach/read required evidence explicitly. The stale-citation acceptance guard checks direct consultation message references, not transitive chains. The local OS user remains trusted; application capabilities do not isolate hostile processes under that same account. Linux and actual toolkit/consumer adoption remain unverified.
