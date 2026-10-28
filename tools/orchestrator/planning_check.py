"""Run the existing planning validator without writing its generated artifacts."""
from __future__ import annotations

import runpy
import sys
from pathlib import Path
from unittest.mock import patch

GENERATED = {'.planning/dependency-waves.json', '.planning/validation-report.json',
             'docs/meta-v2/work-packages.md', 'docs/meta-v2/acceptance-matrix.csv'}


def check(root):
    root = root.resolve()
    def verify(path, text, *args, **kwargs):
        relative = path.resolve().relative_to(root).as_posix()
        if relative not in GENERATED:
            raise ValueError('Unexpected write by planning validator: ' + relative)
        actual = path.read_text(encoding='utf-8')
        if actual != text.replace('\r\n', '\n'):
            raise ValueError('Generated planning artifact is stale: ' + relative)
        return len(text)
    sys.path.insert(0, str(root / '.planning'))
    try:
        with patch.object(Path, 'write_text', verify):
            runpy.run_path(str(root / '.planning/validate.py'), run_name='__main__')
    finally:
        sys.path.pop(0)


if __name__ == '__main__':
    check(Path.cwd())
