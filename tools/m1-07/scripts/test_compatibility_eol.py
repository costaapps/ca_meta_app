"""Exercise the compatibility generator's stale check with CRLF and semantic drift."""

from pathlib import Path
import subprocess
import sys
import tempfile

SCRIPT = Path(__file__).with_name("generate-compatibility.py")


def run_generator(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPT), *arguments],
        capture_output=True,
        check=False,
        text=True,
    )


with tempfile.TemporaryDirectory(prefix="m1-07-compatibility-eol-") as temp_root:
    output = Path(temp_root) / "compatibility-matrix.csv"
    generated = run_generator(f"--output={output}")
    assert generated.returncode == 0, generated.stderr or generated.stdout

    with output.open("r", encoding="utf-8", newline="") as handle:
        lf_text = handle.read()
    crlf_text = lf_text.replace("\n", "\r\n")
    with output.open("w", encoding="utf-8", newline="") as handle:
        handle.write(crlf_text)

    crlf_check = run_generator("--check", f"--output={output}")
    assert crlf_check.returncode == 0, crlf_check.stderr or crlf_check.stdout

    semantic_change = crlf_text.replace("matrix_row", "matrix-row", 1)
    assert semantic_change != crlf_text, "semantic-mutation probe did not alter the generated CSV"
    with output.open("w", encoding="utf-8", newline="") as handle:
        handle.write(semantic_change)

    stale_check = run_generator("--check", f"--output={output}")
    assert stale_check.returncode != 0, "compatibility check must reject semantic changes"
    assert "Generated compatibility matrix is stale" in stale_check.stderr, stale_check.stderr

print("Compatibility generation accepts CRLF and rejects semantic changes.")
