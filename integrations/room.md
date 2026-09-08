---
description: Read and contribute to the project's durable Agent Room conversation
---

Use `.claude/scripts/room.sh` for the current project. Follow the user's requested conversation or read the pending inbox when no thread is supplied.

1. Use the agent capability assigned to this active run (`--token-file` or `AGENT_ROOM_TOKEN`). Do not read the operator token or use `--operator`. If no run capability is available, report that the operator must attach this run; continue the original task independently where possible.
2. Read `inbox`, then the relevant thread with `read --thread <id>`. Use bounded `search` or `source read` for earlier rationale and original evidence. Preserve human constraints, disagreements, and uncertainty.
3. Post concise advisory reasoning using `post --thread <id> --body-file <path> --key <stable-request-id>`. Cite returned source/message IDs when useful. A quoted mention is ordinary text.
4. Only invite consultants with `ask` when the user requests it or a configured, enabled workflow trigger calls for it. A plain discussion reply does not imply an invitation. The operator owns execution policy and the worker. Do not change either or fall back to an API key.
5. After actually reading the messages, `ack --thread <id> --through <sequence>`. This records retrieval, not verified comprehension. Do not acknowledge on behalf of another run or claim delivery to an inactive agent.
6. Propose decisions with `decision propose`; the human accepts them. Link conclusions to the existing task workflow through its normal evidence process. Never use room discussion to approve reviews, set human-only dispositions, advance tasks or merge code.

If the room is absent, disabled, unavailable or out of allowance, preserve the pending question and resume the original task. A room error is advisory and does not bypass the existing workflow's gates.
