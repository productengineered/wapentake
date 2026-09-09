# User-owned model configuration

Wapentake 0.3.0 reads model choices from a user file, outside consumer repositories. One installation can serve several consumers with different named profiles. Updating the application never overwrites this file.

## Create and inspect the file

```sh
wapentake models init --operator
wapentake models validate
wapentake models resolve --model-profile toolkit --for glm,astra,adjudicator
```

`init` creates a private file and refuses to overwrite an existing one. These commands require no room database and make no model calls. Validation checks configuration syntax and allowed routes; it does not establish model availability for your account. `doctor --offline --model-profile toolkit` additionally inspects the installed clients and saved authentication without inference.

The path is `~/.config/wapentake/models.json`, or `$XDG_CONFIG_HOME/wapentake/models.json`. `WAPENTAKE_MODELS_FILE` overrides that path; `--models-file /absolute/path/models.json` takes precedence over the environment. Keep it outside all registered project directories. Do not put credentials, executable arguments or provider overrides in this file.

The [initial example](../examples/models.json) selects:

```json
{
  "schema_version": 1,
  "defaults": {
    "glm": { "model": "zai-coding-plan/glm-5.3" },
    "astra": { "model": "gpt-6-astra", "reasoning_effort": "high" },
    "adjudicator": { "model": "openai/gpt-5.6-sol" }
  },
  "profiles": {
    "toolkit": {},
    "5wth-ops": {}
  }
}
```

Profiles inherit the defaults by role and field. For example, setting `profiles.toolkit.astra` to `{"reasoning_effort":"medium"}` changes only that profile's Astra effort. Edit defaults to change all inheriting consumers, or edit one profile to change only that consumer. The reserved profile `default` selects defaults directly and must not be defined in `profiles`.

## Select a consumer profile

Merge this into the consumer's existing, untracked `.claude/settings.local.json`; retain its other settings:

```json
{
  "env": {
    "WAPENTAKE_MODEL_PROFILE": "5wth-ops"
  }
}
```

Use `toolkit` in the toolkit's own local settings. A new consumer process inherits the selection; restart an existing coordinator or viewer after changing its environment. The thin `wapentake.sh` launcher forwards the environment and needs no changes. Other consumers can set the environment in their launcher without using Claude settings.

Selection precedence is explicit `--model-profile`, then the `Room` instance's `modelProfile` option, then `WAPENTAKE_MODEL_PROFILE`, then `default`. For the CLI, the explicit flag supplies that instance option. JSON `ask`/`context.preview` requests may include `model_profile` to override the server's default:

```sh
wapentake ask --token-file /path/to/run.token --project PROJECT_ID \
  --thread THREAD_ID --to glm,astra --body-file question.txt \
  --model-profile 5wth-ops --key review-1
```

An unknown profile, malformed file, unsupported schema or missing explicitly selected file refuses. No general API route or alternate model is selected on failure. If no user file and no named profile exist, 0.1 compatibility defaults remain available: GLM 5.3, Astra 6 with low effort, and the external adjudicator's `openai/gpt-5.5`. Use `models init --operator` to opt into the example above. Within an existing configuration file, a requested role must resolve to a model; missing roles do not fall back to compatibility defaults.

## What a queued job preserves

`ask` resolves all recipients once and saves each selection in the same transaction as the job and allowance reservation. The saved selection includes model, adapter, reasoning effort, profile, configuration source/file/hash and its own selection hash. Job selections are immutable.

`work --job` uses those saved settings even if the file later changes, disappears or becomes invalid. A duplicate `ask` with the same key and input returns the original jobs. Explicit retries preserve the original selection; automatic follow-ups preserve the target reviewer's original selection. A new invitation is required to use new model settings. Context preview resolves the current configuration; it is not a replacement for an older job's captured packet.

The GLM role remains on the saved Z.AI Coding Plan route through OpenCode. Astra remains on the saved ChatGPT route through Codex. Explicit model IDs are allowed only within those routes; `latest` aliases and arbitrary client flags refuse. Astra effort supports `low`, `medium`, `high` and `xhigh`. Client versions, authentication isolation, tool restrictions and allowance remain separately enforced. The example's high effort and new adjudicator selection have offline contract coverage, with no additional live inference validation in this release.

## External adjudicators and library consumers

`adjudicator` is configuration for a consumer's existing OpenCode OpenAI runner. It is not a third Wapentake consultant; `ask --to adjudicator` is unsupported. Consumers must explicitly adopt the resolver and preserve their own authentication, independence, session-identity verification, receipt checks and human disposition rules. Merely setting the environment does not change a consumer's hardcoded runner.

Use the shared CLI without opening state or obtaining an operator capability:

```sh
wapentake models resolve --for adjudicator --model-profile toolkit
```

Read `models.adjudicator.model` from its JSON output. The same resolver is exported for JavaScript consumers:

```js
import { resolveModels } from '@productengineered/wapentake/models';

const result = resolveModels({ roles: ['adjudicator'], profile: 'toolkit' });
const model = result.models.adjudicator.model;
```

Pass the resolved model as an argument to the existing client invocation without shell evaluation. Preserve the returned profile and configuration hash in the consumer's receipt alongside the requested and independently observed model. Fail on resolver or identity errors. Wapentake exports do not turn an advisory response into a formal review receipt.
