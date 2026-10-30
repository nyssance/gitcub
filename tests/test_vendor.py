import tempfile
import unittest
from pathlib import Path

from scripts import upstream as vendor


class VendorTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.remote = self.root / "remote"
        self.remote.mkdir()
        vendor.git(self.remote, "init", "-b", "main")
        vendor.git(self.remote, "config", "user.email", "test@example.invalid")
        vendor.git(self.remote, "config", "user.name", "Test")
        self.commit("initial")
        self.url = self.remote.as_uri()
        self.checkout = self.root / "checkout"

    def commit(self, content):
        (self.remote / "file").write_text(content)
        vendor.git(self.remote, "add", "file")
        vendor.git(self.remote, "-c", "commit.gpgsign=false", "commit", "-m", content)

    def test_missing_files_and_changed_files_are_distinguished(self):
        destination = self.root / "destination"
        destination.mkdir()
        (self.remote / "changed").write_text("upstream")
        (destination / "changed").write_text("local")
        result = vendor.file_status(self.remote, destination, ["file", "changed", "gone"])
        self.assertEqual(result, {"changed": ["changed"], "missing_source": ["gone"], "missing_local": ["file"]})



if __name__ == "__main__":
    unittest.main()
