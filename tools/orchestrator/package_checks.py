"""Discover repository-local offline experiment entrypoints and Python test suites."""
from pathlib import Path
import ast


def discover(root):
    commands = []
    suites = set()
    for parent in ('experiments', 'tests'):
        directory = root / parent
        if not directory.exists():
            continue
        for path in sorted(directory.rglob('*.py')):
            if path.is_symlink() or any(p.is_symlink() for p in path.parents if p != root):
                raise ValueError('Symlink in package checks')
            relative = path.relative_to(root).as_posix()
            if path.name.startswith('test_'):
                suites.add(path.parent.relative_to(root).as_posix())
                continue
            if parent != 'experiments':
                continue
            tree = ast.parse(path.read_text(encoding='utf-8'), filename=relative)
            entrypoint = any(isinstance(node, ast.If) and
                isinstance(node.test, ast.Compare) and
                isinstance(node.test.left, ast.Name) and node.test.left.id == '__name__' and
                any(isinstance(value, ast.Constant) and value.value == '__main__' for value in node.test.comparators)
                for node in tree.body)
            if entrypoint:
                commands.append(['python3', relative])
    commands.extend(['python3', '-m', 'unittest', 'discover', '-s', parent, '-p', 'test_*.py', '-v']
                    for parent in sorted(suites))
    return commands
