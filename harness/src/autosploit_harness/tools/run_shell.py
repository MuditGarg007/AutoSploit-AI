"""run_shell — sandboxed shell adapter (docs/harness.md §4).

    run_shell(cmd: str, timeout: int) -> ShellResult

Runs in the attacker container (kali-ish: nmap, curl, sqlmap, nikto, ffuf).
Returns stdout + stderr + exit code, FULL — truncation for the transcript happens
in the tool node so the ledger keeps the full output (§9 step 3, tools/truncate.py).
Network-scoped by the sandbox firewall, NOT by the interceptor (§3) — the
interceptor only budget-gates and logs it. Shell for breadth; the four typed tools
stay small on purpose (§4).

Skeleton (§9 step 1) runs the subprocess on the local dev host — there's no
attacker container yet. The adapter contract (args + ShellResult) is unchanged
when the sandbox lands, so nothing downstream reshapes.
"""

from __future__ import annotations

import subprocess

from autosploit_harness.contracts.results import ShellResult

DEFAULT_TIMEOUT = 120


def run_shell(cmd: str, timeout: int = DEFAULT_TIMEOUT) -> ShellResult:
    """Execute `cmd` via the system shell, capped timeout, FULL output.

    Pure adapter: no interception here — the interceptor node has already cleared
    this call by the time it runs (§3). Never raises on a non-zero exit or a
    timeout; both come back as a structured ShellResult the agent can read.
    Output is returned in full; the tool node spills it to the ledger and caps the
    transcript preview (§9 step 3).
    """
    try:
        # shell=True is the adapter's whole point (§4); network-scoped by the firewall.
        proc = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            check=False,  # a non-zero exit is a result the agent reads, not an error
        )
        return ShellResult(
            cmd=cmd,
            exit_code=proc.returncode,
            stdout=proc.stdout or "",
            stderr=proc.stderr or "",
        )
    except subprocess.TimeoutExpired as e:
        stdout = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        stderr = e.stderr.decode() if isinstance(e.stderr, bytes) else (e.stderr or "")
        return ShellResult(
            cmd=cmd,
            exit_code=124,  # conventional timeout exit code
            stdout=stdout,
            stderr=stderr or f"timed out after {timeout}s",
            timed_out=True,
        )
