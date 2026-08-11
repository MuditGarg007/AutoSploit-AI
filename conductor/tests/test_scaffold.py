"""C0 gate test — proves both path deps resolve from inside the conductor (docs/conductor.md C0)."""

from autosploit_harness.driver.config import load_scope
from autosploit_provisioner.teardown import register, teardown


def test_path_deps_import() -> None:
    assert callable(teardown)
    assert callable(register)
    assert callable(load_scope)
