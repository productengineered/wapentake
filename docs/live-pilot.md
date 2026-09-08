# Live pilot record

Status: completed on 2026-09-08 within the operator's six-call allowance. Five responses were validated into the room; one earlier Astra importer failure remains recorded and charged. Execution is paused, automatic follow-up is off, and no allowance remains. The operator's existing pilot approval was recorded as an accepted operational decision; all three consultant design proposals remain proposed.

This was a local macOS pilot through saved GLM Coding Plan and ChatGPT logins. It verifies the observed client paths and explicit fresh-session retrieval. It does not establish production deployment, Linux support, actual consumer adoption or automatic inclusion of every nested reference/source byte.

## Approved allowance

- Maximum **six launched calls total** in a dedicated pilot store, across both participants and any explicitly requested follow-up/retry.
- GLM: OpenCode 1.18.18, `zai-coding-plan/glm-5.3`, saved Z.AI Coding Plan credential.
- Astra: Codex 0.153.4, `gpt-6-astra`, saved ChatGPT login.
- One process at a time, five-minute timeout, 32 KiB packet ceiling, 2 MiB native output ceiling.
- Automatic follow-up off. Inspect an error, unsupported model, unexpected tool event or ambiguous run before another invocation.
- No task-store operation, consumer implementation change, authentication change, general API key use or fallback model.

## First question

> Can the current packet and worker design retain decision rationale across fresh sessions without replaying all history? Use the delivered code only. Identify one behavior the implementation supports, one unverified assumption, and the smallest next validation. Address independent first responses, changed evidence, and human-only decision acceptance. Cite supplied evidence. Request bounded context for missing implementation details rather than guessing.

Initial evidence: `src/context.mjs` (required), `src/worker.mjs` (optional bounded excerpt), and this pilot record. Both first invitations share one question boundary. The design requirements are plan-only execution, explicit invitations, bounded context, and human acceptance of decisions. These are requirements to verify, not proof of correctness.

## Repeatable procedure (requires its own allowance)

1. Review both packet previews and the offline doctor. Enable only the approved six-call allowance in the dedicated pilot store.
2. Run one initial job per participant, inspecting native completion and the resulting response after each call. Stop on a model/auth/configuration mismatch. Record requested and observed identity separately; an unreported resolved identity stays unknown.
3. Read both replies. Fulfill a concrete evidence request through bounded retrieval, then invite a focused follow-up from each available participant within the total allowance. Do not repair malformed output into an answer or retry ambiguous runs automatically.
4. Present any decision proposal to the human. Record acceptance only after the human chooses it; a consultant proposal is not acceptance.
5. Attach a new agent capability and use fresh CLI processes to retrieve the retained decision, rationale, constraints and original evidence. Its acknowledgment must not alter another actor's inbox.
6. Pause execution, export and back up the trace. Record useful/unused contributions, native usage when present, calls, latency, packet bytes, stale-context results, uncertainty and the human-linked outcome.

`examples/prepare-pilot.mjs` creates an inspectable state and packets without inference and prints only paths/IDs/hashes. Preparation does not authorize execution. Real consumer adoption through the thin integration remains a coordinated boundary with the toolkit cleanup.


## Observed calls

| Call | Client | Result | Elapsed to first local terminal | Packet bytes |
|---|---|---|---:|---:|
| 1 | GLM | Validated first assessment | 70.368 s | 28,181 |
| 2 | Astra | Native answer captured; importer rejected startup notices; remains failed | 33.574 s | 28,171 |
| 3 | Astra | Explicit retry validated after parser fix | 29.272 s | 28,166 |
| 4 | GLM | Answer completed; metadata export initially truncated; reconciled from saved successful capture | 89.295 s | 30,137 |
| 5 | Astra | Evidence follow-up validated | 32.134 s | 30,127 |
| 6 | GLM | Fresh-session operational decision retrieval validated | 31.230 s | 6,780 |

Call 4's reconciliation read local client session metadata and made zero inference calls. The original failure event and charged launch remain. The first two calls predate persisted exit receipts; call 2 was not retroactively promoted without one. Reported usage exists for all six native turns, with call 2 retained only as unpromoted terminal data. GLM's client reports cost zero; this does not mean the subscription has no cost or establish remaining provider quota.

The initial client fixes retain only exact known Codex pre-turn notices while refusing arbitrary errors or tool events, and capture OpenCode's session export to a new private regular file to avoid the observed 64 KiB pipe truncation. The exporter is bounded and strict JSON remains required. Exact `zai-coding-plan/glm-5.3` identity was verified from each GLM session; the Codex request is `gpt-6-astra`, but its resolved identity is absent from native output and stays unknown.

## Human-linked outcome and limits

A fresh registered agent process retrieved the accepted six-call approval, including its exact statement, rationale, status and citations. The full discussion then required 37,839 bytes and refused before launch at the 32,768-byte cap. A focused thread carried the approval and original human authorization message in 6,780 bytes. The sixth call used a fresh GLM client session and reproduced the accepted fields exactly. It also identified missing nested-reference/source content; the coordinator corrected its mistaken description of one cross-thread decision ID as a message. The full original history remains available.

The substantive consultant contributions were a bounded worker-tail/acceptance-path evidence request, a distinction between inspected code and reported test results, and the recommendation to validate retained decisions through a fresh client. Source-byte inclusion and transitive stale-reference handling remain explicit limitations. No consultant design proposal was accepted, and this operational approval does not accept risks or findings.

Thirty-nine offline tests pass on Node 24.20.0 and 26.0.0 on macOS, including large-history retrieval, independent retry boundaries, private-file capture limits and metadata-only reconciliation. The browser walkthrough also passes with fake providers. These fixture results are separate from the six real calls above.

The focused live packet exposed a coverage-counter bug: its cross-thread message was subtracted from the local thread history count, yielding `-1`. The subsequent fix counts only omitted messages belonging to the current thread. A regression fixture and local packet rebuild verify `0`; the original packet/hash remain untouched and no seventh call was made.
