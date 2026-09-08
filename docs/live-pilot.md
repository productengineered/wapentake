# Proposed live pilot

Status: prepared for operator review; no live consultant calls have run. Offline tests use fake providers. This pilot checks actual account/model access, native event compatibility, useful responses and fresh-session retrieval through saved GLM Coding Plan and ChatGPT logins.

## Proposed allowance

- Maximum **six launched calls total** in a dedicated pilot store, across both participants and any explicitly requested follow-up/retry.
- GLM: OpenCode 1.18.18, `zai-coding-plan/glm-5.3`, saved Z.AI Coding Plan credential.
- Astra: Codex 0.153.4, `gpt-6-astra`, saved ChatGPT login.
- One process at a time, five-minute timeout, 32 KiB packet ceiling, 2 MiB native output ceiling.
- Automatic follow-up off. Inspect an error, unsupported model, unexpected tool event or ambiguous run before another invocation.
- No task-store operation, consumer implementation change, authentication change, general API key use or fallback model.

## First question

> Can the current packet and worker design retain decision rationale across fresh sessions without replaying all history? Use the delivered code only. Identify one behavior the implementation supports, one unverified assumption, and the smallest next validation. Address independent first responses, changed evidence, and human-only decision acceptance. Cite supplied evidence. Request bounded context for missing implementation details rather than guessing.

Initial evidence: `src/context.mjs` (required), `src/worker.mjs` (optional bounded excerpt), and this pilot record. Both first invitations share one question boundary. The design requirements are plan-only execution, explicit invitations, bounded context, and human acceptance of decisions. These are requirements to verify, not proof of correctness.

## Trace after authorization

1. Review both packet previews and the offline doctor. Enable only the approved six-call allowance in the dedicated pilot store.
2. Run one initial job per participant, inspecting native completion and the resulting response after each call. Stop on a model/auth/configuration mismatch. Record requested and observed identity separately; an unreported resolved identity stays unknown.
3. Read both replies. Fulfill a concrete evidence request through bounded retrieval, then invite a focused follow-up from each available participant within the total allowance. Do not repair malformed output into an answer or retry ambiguous runs automatically.
4. Present any decision proposal to the human. Record acceptance only after the human chooses it; a consultant proposal is not acceptance.
5. Attach a new agent capability and use fresh CLI processes to retrieve the retained decision, rationale, constraints and original evidence. Its acknowledgment must not alter another actor's inbox.
6. Pause execution, export and back up the trace. Record useful/unused contributions, native usage when present, calls, latency, packet bytes, stale-context results, uncertainty and the human-linked outcome.

`examples/prepare-pilot.mjs` creates an inspectable state and packets without inference and prints only paths/IDs/hashes. Preparation does not authorize execution. Real consumer adoption through the thin integration remains a coordinated boundary with the toolkit cleanup.
