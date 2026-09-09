#!/usr/bin/env python3
"""Install review-pinned tools from hash-verified release archives."""
import hashlib
import io
import json
import os
import platform
import subprocess
import sys
import tarfile
import urllib.request
from pathlib import Path


def main():
    config = json.loads(Path(__file__).resolve().parents[1].joinpath("tools.json").read_text())
    machine = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x64"}[platform.machine()]
    target = f"{platform.system().lower()}-{machine}"
    destination = Path(subprocess.check_output(["git", "rev-parse", "--git-path", "wapentake-tools"], text=True).strip()).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    for name in sys.argv[1:]:
        tool = config[name]
        filename, expected = tool["assets"][target]
        url = f'https://github.com/{tool["repo"]}/releases/download/v{tool["version"]}/{filename}'
        with urllib.request.urlopen(url, timeout=60) as response:
            archive = response.read()
        if hashlib.sha256(archive).hexdigest() != expected:
            raise ValueError(f"{name}: release archive SHA-256 mismatch")
        with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as bundle:
            matches = [member for member in bundle.getmembers() if member.isfile() and Path(member.name).name == name]
            if len(matches) != 1:
                raise ValueError(f"{name}: ambiguous archive")
            binary = bundle.extractfile(matches[0]).read()
        path = destination / name
        path.write_bytes(binary)
        path.chmod(0o755)
        print(f"Installed {name} {tool['version']} (verified SHA-256)")
    if os.environ.get("GITHUB_PATH"):
        with open(os.environ["GITHUB_PATH"], "a") as output:
            output.write(str(destination) + "\n")
    print(f"Tool directory: {destination}")


if __name__ == "__main__":
    main()
