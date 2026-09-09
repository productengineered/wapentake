import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from privacy import check, git, history_entries, index_entries, inspect, private_path


class PrivacyTests(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory(prefix="wapentake-privacy-test-")
        self.previous = os.getcwd()
        os.chdir(self.scratch.name)
        self.environment = patch.dict(os.environ, {"GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull})
        self.environment.start()
        git("init", "-q")
        git("config", "user.name", "Fixture")
        git("config", "user.email", "fixture@example.invalid")
        git("config", "commit.gpgsign", "false")

    def tearDown(self):
        os.chdir(self.previous)
        self.environment.stop()
        self.scratch.cleanup()

    def test_staged_snapshot_not_working_tree(self):
        path = Path("notes.md")
        path.write_text("#token=" + "z" * 48)
        git("add", "notes.md")
        path.write_text("Working tree is clean, but the index still leaks")
        with self.assertRaisesRegex(ValueError, "capability URL"):
            check(index_entries())
        git("add", "notes.md")
        check(index_entries())

    def test_deleted_private_files_remain_in_history(self):
        Path("credentials.json").write_text("{}")
        git("add", ".")
        git("commit", "-qm", "fixture")
        git("rm", "credentials.json")
        git("commit", "-qm", "remove fixture")
        with self.assertRaisesRegex(ValueError, "private runtime file"):
            check(history_entries(git("rev-parse", "HEAD").decode().strip()))
        check(index_entries())

    def test_symlink_and_untrusted_revision_refuse(self):
        Path("link").symlink_to("missing")
        git("add", "link")
        with self.assertRaisesRegex(ValueError, "non-regular"):
            list(index_entries())
        with self.assertRaises(ValueError):
            list(history_entries("--output=unexpected"))

    def test_private_patterns_and_safe_example(self):
        for path in ["state/db.sqlite", "state/db.sqlite-wal", ".env.local", "credentials.json", "packet.json", "viewer-output.log", "settings/models.json"]:
            self.assertTrue(private_path(path), path)
        self.assertFalse(private_path("examples/models.json"))
        home = b"/" + b"Users" + b"/person/project"
        self.assertTrue(inspect("readme.md", home))

    def test_pre_push_rejects_main_update_before_scanning(self):
        script = Path(__file__).resolve().with_name("secrets.py")
        result = subprocess.run(["python3", str(script), "--pre-push"], input="refs/heads/main " + "a" * 40 + " refs/heads/main " + "b" * 40 + "\n", text=True, capture_output=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Update main through a reviewed pull request", result.stderr)


if __name__ == "__main__":
    unittest.main()
