# Event examples

Replace example source IDs with captured source/message IDs in the current project. Store event bodies in UTF-8 JSON files and invoke `wapentake event --input-file event.json` with the run's agent capability. The triggers must be explicitly enabled in policy first. No example executes a consultant by itself.

Disagreement:

```json
{
  "kind": "disagreement",
  "task_id": "TASK-42",
  "body": "The two reviews disagree on how this caller should represent failure. Identify the evidence that would settle it.",
  "source_ids": ["REVIEW_ONE_SOURCE_ID", "REVIEW_TWO_SOURCE_ID"],
  "to": ["glm", "astra"],
  "key": "TASK-42:review-attempt-2:failure-contract"
}
```

Stuck work:

```json
{
  "kind": "stuck",
  "task_id": "TASK-43",
  "body": "Two targeted fixes preserved the same failure. Suggest a new testable hypothesis based on the attached evidence.",
  "source_ids": ["FAILING_TEST_SOURCE_ID", "IMPLEMENTATION_SOURCE_ID"],
  "attempts": ["Preserved the original error cause", "Moved cleanup after transaction commit"],
  "failure_signature": "caller-contract: expected typed failure, received null",
  "to": ["astra"],
  "key": "TASK-43:stuck:attempt-3"
}
```

An operator may apply a policy patch such as `{"enabled_triggers":["manual","disagreement"]}` using `call --action policy.update --input-file policy-patch.json --operator`. This enables the trigger's invitation routing; it does not enable execution or start the worker.
