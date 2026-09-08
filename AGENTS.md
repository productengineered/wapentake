# Agent Room working rules

Agent Room is a standalone Mac utility. Read `README.md` and `docs/implementation-status.md` for setup, scope and current evidence.

- Keep the core independent of toolkit repositories and task stores. Toolkit-specific workflow instructions belong in optional `integrations/` adapters.
- Keep conversation databases, credentials, captured client output and local settings outside the repository and release archives.
- Model calls require the operator's explicit bounded allowance. Count launched failures and retries; do not infer a new allowance from development or test requests.
- Use existing plan logins without a fallback model or general API route. Consultant proposals remain advisory until a human accepts them.
- Run `npm test` for core or integration changes. For browser changes, also run `tests/browser-smoke.mjs` with an explicitly supplied Playwright installation and Chrome; it uses fake providers.
- Preserve supported command and response contracts across compatible releases. Back up persistent state before schema migrations, and refuse unknown schemas without replacing data.
- Mac is the current supported platform. Linux and Windows are outside this release's scope.
