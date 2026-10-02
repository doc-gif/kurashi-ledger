from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).parents[1]))
import guard
import changed_paths


class ChangedPathsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.repo = Path(self.temp.name)
        self.git("init", "-q")
        self.git("config", "user.name", "Synthetic Test")
        self.git("config", "user.email", "test@example.invalid")
        (self.repo / "initial.txt").write_text("base", encoding="utf-8")
        self.first = self.commit()

    def git(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], text=True).strip()

    def commit(self):
        self.git("add", "--all")
        self.git("-c", "commit.gpgsign=false", "commit", "-qm", "synthetic test")
        return self.git("rev-parse", "HEAD")

    def test_diverged_base_fails_then_merge_preserves_only_pr_paths(self):
        self.git("checkout", "-qb", "worker")
        (self.repo / "worker.txt").write_text("worker", encoding="utf-8")
        head = self.commit()
        self.git("checkout", "-qb", "other", self.first)
        (self.repo / "other.txt").write_text("other", encoding="utf-8")
        base = self.commit()
        with self.assertRaisesRegex(guard.Invalid, "incorporate base"):
            changed_paths.changed_paths(self.repo, base, head)
        self.git("checkout", "worker")
        self.git("-c", "commit.gpgsign=false", "merge", "--no-edit", "other")
        self.assertEqual(changed_paths.changed_paths(self.repo, base, self.git("rev-parse", "HEAD")), ["worker.txt"])

    def test_rename_lists_both_sides_and_unicode_is_preserved(self):
        self.git("mv", "initial.txt", "変更後.txt")
        head = self.commit()
        self.assertEqual(changed_paths.changed_paths(self.repo, self.first, head), ["initial.txt", "変更後.txt"])

    def test_unavailable_or_invalid_refs_fail_closed(self):
        with self.assertRaisesRegex(guard.Invalid, "ancestry is unavailable"):
            changed_paths.changed_paths(self.repo, "a" * 40, self.first)
        with self.assertRaisesRegex(guard.Invalid, "full SHAs"):
            changed_paths.changed_paths(self.repo, "--help", self.first)
