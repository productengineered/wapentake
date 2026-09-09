#!/usr/bin/env python3
"""Scan exactly staged content or all history being pushed, with redacted output."""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from privacy import check, git, history_entries, index_entries


def run(args):
    env = os.environ.copy()
    env.pop("GITLEAKS_CONFIG", None)
    env.pop("GITLEAKS_CONFIG_TOML", None)
    subprocess.run(args, check=True, env=env)


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--staged", action="store_true")
    mode.add_argument("--history", action="store_true")
    mode.add_argument("--pre-push", action="store_true")
    args = parser.parse_args()
    root = Path(git("rev-parse", "--show-toplevel").decode().strip())
    os.chdir(root)
    revisions = []
    if args.pre_push:
        for line in sys.stdin:
            local_ref, local_oid, remote_ref, remote_oid = line.split()
            if remote_ref == "refs/heads/main" and remote_oid != "0" * 40:
                raise ValueError("Update main through a reviewed pull request")
            if local_oid != "0" * 40:
                revisions.append(local_oid)
    elif args.history:
        revisions = ["--all"]
    binary = Path(git("rev-parse", "--git-path", "wapentake-tools/gitleaks").decode().strip()).resolve()
    if not binary.is_file():
        found = shutil.which("gitleaks")
        if not found:
            raise ValueError("Run python3 .github/scripts/tools.py gitleaks before committing or pushing")
        binary = Path(found)
    with tempfile.TemporaryDirectory(prefix="wapentake-secret-check-") as temporary:
        scratch = Path(temporary)
        # Use the reviewed configuration and disable inline suppressions and ignore files.
        config = scratch / "gitleaks.toml"
        config.write_bytes(git("show", ":.gitleaks.toml") if args.staged else (root / ".gitleaks.toml").read_bytes())
        ignore = scratch / "empty-ignore"
        ignore.touch()
        common = ["--config", str(config), "--redact=100", "--ignore-gitleaks-allow", "--gitleaks-ignore-path", str(ignore), "--no-banner", "--no-color", "--timeout", "60"]
        if args.staged:
            entries = list(index_entries())
            check(entries)
            snapshot = scratch / "staged"
            snapshot.mkdir()
            for path, oid in entries:
                target = snapshot / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(git("cat-file", "blob", oid))
            run([str(binary), "dir", str(snapshot), *common])
        for revision in sorted(set(revisions)):
            check(history_entries(revision))
            run([str(binary), "git", str(root), f"--log-opts={revision}", *common])
    print("Secret and private-file checks passed")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, subprocess.CalledProcessError) as error:
        print(f"Secret check refused: {error}", file=sys.stderr)
        sys.exit(1)
