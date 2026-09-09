# Installation and independent updates

Install once per Mac from the Wapentake repository:

```sh
npm run install:local
~/.local/bin/wapentake --version
```

The application has no runtime npm dependencies. Installation packs the checked-out source, installs the archive offline with package scripts disabled, checks the installed runtime, and switches the shared command to that release. It makes no model calls and does not register projects, change room data or alter a toolkit.

| Path | Purpose |
|---|---|
| `~/.local/bin/wapentake` | Stable command symlink |
| `~/.local/share/wapentake/current` | Active release symlink |
| `~/.local/share/wapentake/releases/VERSION-HASH/` | Retained installed release and archive hash record |
| `~/.config/wapentake/models.json` | User-owned model defaults and consumer profiles, preserved on update |
| `~/.local/state/wapentake/` | Default conversation state, separate from installed code |

`--state-dir` and `WAPENTAKE_STATE_DIR` may select a different room state, including the existing pilot. `--install-root` and `--bin-dir` select custom installation paths. The Wapentake launcher uses `WAPENTAKE_INSTALL_ROOT` when the default installation root differs. The installer refuses to overwrite an unrelated command or current link.

## Update from source or an archive

After checking out the intended Wapentake revision, rerun `npm run install:local`. To install a reviewed release archive instead:

```sh
npm run install:local -- --from /absolute/path/productengineered-wapentake-0.3.0.tgz --sha256 EXPECTED_SHA256
```

Replace the archive path and digest with the actual release values. A mismatched digest, invalid archive or failed runtime check leaves the current release selected. Concurrent installers refuse a second lock owner. If an interrupted installer leaves `.install-lock`, inspect its recorded PID before removing that stale lock directory.

New CLI invocations use the newly selected release. Existing viewers and workers continue running their previous version. Finish or cancel active jobs through the room, stop the old viewer/worker process, then restart the viewer using the shared command and the same `--state-dir`. This preserves the room URL when the same port and operator capability are used. Installation never restarts active work automatically.

Older installed releases are retained. Reinstalling an earlier Wapentake archive reselects its release without a new toolkit update. This changes application code only; it is not a database downgrade. Back up state before a release that migrates its schema and follow that release's restore instructions. Unknown newer schemas refuse rather than starting an empty store.

Version 0.3.0 retains database schema 2 from 0.2.0; the rename needs no schema migration. Existing schema-1 stores require an explicit backup-first migration after stopping old processes; installation does not migrate stores automatically. Follow the [consumer upgrade runbook](consumer-upgrade.md). Configure [model profiles](models.md) separately.

## Build a release package

From a clean, tested checkout:

```sh
npm test
mkdir -p dist
npm pack --offline --ignore-scripts --pack-destination dist
shasum -a 256 dist/productengineered-wapentake-0.3.0.tgz
```

The archive and hash can be distributed as their own release assets. A remote repository or public npm publication is not required for a local archive install; `private: true` currently prevents npm publication. The private `productengineered/wapentake` repository is connected separately; a local installation does not push code or publish a release.

Runtime state and credentials stay outside release archives. The archive allowlist contains application code, installer, integration templates and documentation. Tests verify portability and updates without reading real task stores or consuming model quota.
