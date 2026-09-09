# Development and repository controls

Wapentake uses pull requests into `main`, manual squash merges, and checks bound to their publishing GitHub Apps. Administrators follow the same branch rules. Force pushes and deletion of `main` are blocked. There is one repository owner identity today: CODEOWNERS records responsibility, while required human approval remains zero until a separate reviewer is available.

## Local setup

Use a supported Mac and Node version, then run:

```sh
npm ci --ignore-scripts
npm run setup:hooks
python3 .github/scripts/tools.py actionlint shellcheck
npm run lint
npm run check:quality
npm test
npm run check:package
```

The installed Git hooks scan the exact staged snapshot before a commit and all history reachable from each pushed commit before a push. Gitleaks output is fully redacted; inline ignore comments and ignore files cannot suppress findings. The additional privacy check rejects room databases, capabilities, credential files, captured invocation output, local model settings, personal home paths and capability URLs. Example model settings are allowed at `examples/models.json`. Fix or remove a finding before committing; removing it only from the working tree does not clean the index, and deleting it later does not clean outgoing history. The push hook also refuses updates directly to an existing `main`.

Tools install under Git's private metadata directory after archive SHA-256 verification against `.github/tools.json`. This pins the scanner, workflow linter and shell linter separately from npm dependencies. Hooks are local configuration and must be installed in each clone. CI repeats the privacy and secret scans independently.

## Required checks

| Check | Evidence |
|---|---|
| Core Node 24 / Core Node 26 | The complete offline suite on macOS, including capabilities, worker accounting, recovery, migration, provenance and installation |
| Browser smoke | Disposable desktop/mobile Chromium; fake consultants; interaction, escaping, passive reads, cancellation, export and overflow checks |
| Package install | Explicit package allowlist, archive SHA-256, fresh offline shared installation and runtime doctor |
| Static quality | JavaScript correctness/security lint, syntax, JSON/YAML parsing, local documentation links, version/changelog consistency, ShellCheck, actionlint and privacy regression tests |
| Secrets and privacy | Gitleaks plus private-file/content rules over the checkout and Git history |
| Dependency security | Trivy checks the npm lockfile, including development dependencies, and blocks high/critical known vulnerabilities |
| CI required | Requires every listed CI job to succeed; skipped/cancelled/failed jobs cannot produce a passing aggregate |
| CodeRabbit | Native review status from the CodeRabbit App |
| Wapentake review gate | Confirms an actual CodeRabbit review completed at the current PR HEAD and checks every review thread and comment page |

CI uses no provider credentials and makes no real model calls. Node dependencies are development-only. Dependabot proposes weekly npm and GitHub Actions updates; updates still go through review and manual merge. Pinned standalone scanner versions in `.github/tools.json` need deliberate updates with verified release checksums.

Workflows use full commit pins, read-only permissions by default, bounded run times and cancellation of superseded CI. Only the review metadata job can write checks, and only the manually dispatched draft-release job can write releases. The review job checks out the default branch and never executes PR code with its write token.

## Review dispositions

CodeRabbit uses its commit-status interface (`review_progress: false`) so the completion gate can distinguish `Review completed` from a green `Review skipped` result. A pending, failed, skipped, missing, unknown or different-commit review cannot satisfy the gate. If a bot-authored update is skipped, request a CodeRabbit review and wait for actual completion; do not replace it with a manual approval override.

Before resolving each review thread, a repository collaborator must reply in that thread using one of these forms. Give a substantive explanation of at least 20 characters after the evidence reference:

- `Fixed: COMMIT_SHA — What changed and why it addresses the finding.` The SHA must be in the current PR history.
- `Deferred: ISSUE_URL — Why deferral is acceptable and what remains.` The link must identify an open issue in this repository.
- `Superseded: EVIDENCE_URL — Which later finding or change replaces this one.` Link to a commit or review comment in this repository.
- `Not applicable: EVIDENCE_URL — The concrete evidence that makes this finding inapplicable.` Link to a commit or review comment in this repository.

Resolve the thread after its disposition. Bot replies and a bare “fixed” do not count. Automatic thread resolution by CodeRabbit still needs the written collaborator reply. The gate validates linked evidence, but a reviewer must assess whether the explanation is sound.

The gate refreshes on PR updates, CodeRabbit statuses and PR conversation comments. After changing inline replies or resolving threads, manually run the **Review gate** workflow for immediate refresh, or wait for its twice-hourly reconciliation. GitHub also independently requires conversation resolution. Every new commit needs fresh CI and CodeRabbit completion.

## Draft releases

Run **Draft release** manually from `main` after its latest CI succeeds. The workflow verifies the exact commit, package version/changelog, secret history, package contents, SHA-256 and a fresh offline installation. It creates a draft `vVERSION` release containing the package and `SHA256SUMS`. It refuses duplicate versions; it does not update existing releases.

Inspect the draft and publish it manually. Immutable releases protect the published tag and assets. Repository tag rules also block updates and deletion of `v*` tags. Release notes may still be edited. There is no automatic merge, publication, npm publishing or application auto-update.

## Security coverage

Gitleaks, the privacy rules, Trivy and Dependabot form the baseline available to this private repository. GitHub's separately licensed native code/secret scanning is not assumed to be available. Review and tests still matter: these checks do not prove that all vulnerabilities or sensitive content are absent.
