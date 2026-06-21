import json, os, tempfile
from prd_mcp.web.manifests import write_index_manifest


def test_write_index_manifest_healthy():
    with tempfile.TemporaryDirectory() as vault:
        path = write_index_manifest(
            vault, "r1", "a", "b",
            {"indexed": 5, "skipped": 282, "removed": 0, "errors": 0}, index_nonempty=True)
        assert path.endswith(os.path.join(".runs", "r1", "index.json"))
        m = json.load(open(path))
        assert m["stage"] == "index"
        assert m["counts"] == {"processed": 5, "succeeded": 5, "failed": 0, "skipped": 282}
        assert m["ok"] is True
        assert m["exit_code"] == 0


def test_write_index_manifest_with_errors():
    with tempfile.TemporaryDirectory() as vault:
        path = write_index_manifest(
            vault, "r1", "a", "b",
            {"indexed": 3, "skipped": 1, "removed": 0, "errors": 2}, index_nonempty=True)
        m = json.load(open(path))
        assert m["counts"]["failed"] == 2
        assert m["ok"] is False
        assert m["exit_code"] == 1


def test_write_index_manifest_empty_index_is_failure():
    # Codex #4: a clean run (0 errors) that leaves an EMPTY index must NOT be exit 0.
    with tempfile.TemporaryDirectory() as vault:
        path = write_index_manifest(
            vault, "r1", "a", "b",
            {"indexed": 0, "skipped": 0, "removed": 0, "errors": 0}, index_nonempty=False)
        m = json.load(open(path))
        assert m["ok"] is False
        assert m["exit_code"] == 1
        assert m["extra"]["index_nonempty"] is False
