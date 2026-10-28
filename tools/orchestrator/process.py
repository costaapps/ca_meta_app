"""Bounded processes. Repository strings are never interpolated into a shell."""
from __future__ import annotations

import os
import signal
import subprocess
from pathlib import Path


class ProcessError(RuntimeError):
    def __init__(self, message, output="", stderr=""):
        super().__init__(message)
        self.output = output
        self.stderr = stderr


class ProcessTimeout(ProcessError, TimeoutError):
    pass


def clean_environment() -> dict[str, str]:
    # This reduces accidental inheritance; it is NOT an OS credential boundary.
    blocked = ("GH_", "GITHUB_", "AWS_", "AZURE_", "DOCKER_", "DATABASE_", "META_")
    return {k: v for k, v in os.environ.items()
            if not k.startswith(blocked) and k not in {"OPENAI_API_KEY", "CODEX_API_KEY"}}


def command(argv: list[str], cwd: Path, timeout=300, *, stdin=None, sanitized=False) -> str:
    if not argv or not all(isinstance(x, str) and "\x00" not in x for x in argv):
        raise ValueError("Invalid command argv")
    proc = subprocess.Popen(argv, cwd=cwd, stdin=subprocess.PIPE if stdin is not None else subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            env=clean_environment() if sanitized else None, start_new_session=True)
    try:
        stdout, stderr = proc.communicate(stdin, timeout=timeout)
    except (subprocess.TimeoutExpired, KeyboardInterrupt):
        os.killpg(proc.pid, signal.SIGTERM)
        try:
            stdout, _ = proc.communicate(timeout=3)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            stdout, _ = proc.communicate()
        raise ProcessTimeout(f"Process interrupted or timed out: {argv[0]}", stdout) from None
    if proc.returncode:
        # Do not echo arbitrary command output; it can contain credentials.
        raise ProcessError(f"Process failed ({proc.returncode}): {argv[0]}; inspect local environment", stdout, stderr)
    return stdout


def git(cwd: Path, *args: str) -> str:
    return command(["git", *args], cwd).strip()
