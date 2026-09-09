# Toolkit adapters

The application is installed and versioned independently. A toolkit contributes only its workflow instructions and a small command adapter. Neither the core source nor a copy of its installed package is synced into toolkits.

1. Install Wapentake once on the Mac with `npm run install:local` from the Wapentake repository. Archive installations are described in [installation and updates](../docs/installation.md).
2. Through the adopting toolkit's normal change process, copy `wapentake.sh` to `.claude/scripts/wapentake.sh` and `wapentake.md` to `.claude/commands/wapentake.md`; make the shell file executable. These are optional templates, and this repository does not install them into existing toolkits automatically.
3. The adapter uses `~/.local/share/wapentake/current/`. `WAPENTAKE_INSTALL_ROOT` selects another shared installation, `WAPENTAKE_CLI` selects an explicit JavaScript CLI entry point, and `WAPENTAKE_NODE` selects a Node runtime. It runs in the adopting project root and forwards arguments without shell evaluation.
4. Run `.claude/scripts/wapentake.sh --version` and `doctor --offline --runtime-only`. Initialize or register the project explicitly as the operator, keeping room state outside the project. Run the full offline doctor separately to inspect local plan clients.
5. Assign each active agent run a project-scoped capability. Add inbox checks or invitation triggers at deliberate workflow boundaries. The operator owns execution policy and budgets; the adapter injects neither an operator identity nor an allowance.

Updating the shared installation updates both toolkit adapters without changing their files. The integration test verifies this using two disposable toolkits and retained conversation data. Change an adapter when its workflow behavior changes or when adopting a breaking command contract; preserve existing commands for compatible Wapentake releases. `--version` reports the active package version as JSON.

For 0.2.0, follow the [consumer upgrade contract](../docs/consumer-upgrade.md) before opening an existing store. It covers the backup-first schema migration, `runner` capability, exact `work --job` result checks, revocation and export schema 2. The instruction template now permits a properly authorized runner to execute its own invitations; consumers can merge that addition with their own evidence rules.

Keep model choices in the user's [model configuration](../docs/models.md), using `WAPENTAKE_MODEL_PROFILE` in each consumer's local environment. Application updates preserve this file. External adjudicator runners must explicitly adopt `models resolve --for adjudicator`; room configuration cannot change a consumer's hardcoded invocation by itself.

For disagreement or stuck-work integration, capture the actual review evidence and send `event --input-file <event.json>` with a stable event key. The result is advisory and does not change task state. The room being absent, paused or unavailable must not bypass existing task/review checks.

Other toolkits can use the same CLI and project capabilities without a `.claude` directory. [Implementation status](../docs/implementation-status.md) records completed and pending work.
