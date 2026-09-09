#!/usr/bin/env python3
"""Inspect Git objects, never printing candidate secret contents."""
import re
import subprocess
from pathlib import PurePosixPath


def git(*args):
    return subprocess.check_output(["git", *args])


def private_path(path):
    parts = PurePosixPath(path).parts
    name = parts[-1]
    if any(p in {"runtime-state", "local-state", "capabilities", ".config"} for p in parts):
        return True
    if name.startswith(".env") or re.search(r"\.(?:sqlite(?:-.*)?|token|pem|p12|pfx|tgz)$", name):
        return True
    if name in {"auth.json", "credentials.json", "packet.json", "output.json", "native-events.jsonl", "invocation.json"}:
        return True
    if re.fullmatch(r"viewer(?:-[\w.-]+)?\.log", name):
        return True
    return name == "models.json" and path != "examples/models.json"


def inspect(path, data):
    errors = []
    if private_path(path):
        errors.append(f"{path}: private runtime file")
    if re.search(rb"#token=[A-Za-z0-9_-]{30,200}", data):
        errors.append(f"{path}: capability URL")
    if re.search(rb"(?:/Users/|/home/)[A-Za-z0-9_.-]+(?=/|\s|[\"']|$)", data):
        errors.append(f"{path}: personal home path")
    return errors


def index_entries():
    for record in git("ls-files", "--stage", "-z").split(b"\0"):
        if not record:
            continue
        meta, path = record.split(b"\t", 1)
        mode, oid, stage = meta.decode().split()
        if stage != "0" or mode not in {"100644", "100755"}:
            raise ValueError("Unmerged or non-regular file in index")
        yield path.decode(), oid


def history_entries(revision):
    if revision != "--all" and not re.fullmatch(r"[a-f0-9]{40}(?:\.\.[a-f0-9]{40})?", revision):
        raise ValueError("History selection must be a commit, commit range, or --all")
    seen = set()
    for commit in git("rev-list", revision).decode().splitlines():
        for record in git("ls-tree", "-r", "-z", commit).split(b"\0"):
            if not record:
                continue
            meta, path = record.split(b"\t", 1)
            mode, kind, oid = meta.decode().split()
            if kind != "blob" or mode not in {"100644", "100755"}:
                raise ValueError("Non-regular file in outgoing history")
            key = (path.decode(), oid)
            if key not in seen:
                seen.add(key)
                yield key


def check(entries):
    errors = []
    for path, oid in entries:
        errors.extend(inspect(path, git("cat-file", "blob", oid)))
    if errors:
        raise ValueError("\n".join(sorted(set(errors))))
