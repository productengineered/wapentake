# Repository provenance

On 2026-09-08, Brandon chose to ship Agent Room independently so one Mac installation could serve multiple toolkits without requiring toolkit releases for application changes.

The repository was extracted from `packages/agent-room/` on the `codex/agent-room` development branch of `claude-code-fullstack-webapp-toolkit`. Git subtree extraction retained only this package and its three development commits, with the package at the new repository root.

| Original toolkit commit | Standalone commit | Change |
|---|---|---|
| `c656943` | `ada191d` | Portable room development preview |
| `cae9462` | `4adf3da` | Live plan-client validation and captured-result preservation |
| `3a5e0db` | `f04e2b2` | Correct omitted-history counts across threads |

The [archived design](design.md) records the initial proposal. [Live pilot](live-pilot.md) and [verification](verification.md) distinguish real model calls from offline fixtures. Mac is the current support scope; the archived design's Linux verification proposal is no longer a release requirement.

Conversation databases, capabilities and native client traces were not imported into Git. Existing pilot data remains outside both repositories. Its captured evidence retains the original source paths and hashes. The original toolkit branch remains a historical record; ongoing Agent Room changes belong here.

Toolkit integration means maintaining a small adapter to the installed command and the toolkit's workflow instructions. The core does not depend on a toolkit's repository, release version, task database or `.claude` tree.
