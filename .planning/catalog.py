"""Planning source, rendered into GitHub issues. No operational credentials."""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parent
BASELINE = "7062247a15d15b1b1a5213353517bdc1596a1d38"
BRANCH = "plan/meta-platform-v2-20261028"
REPO = "costaapps/ca_meta_app"
TASKS = []


def task(key, title, area, priority, effort, deps, goal, steps, contract, acceptance, tests, risk, refs=(), external=False):
    TASKS.append(dict(key=key, title=title, area=area, priority=priority, effort=effort,
                      deps=deps.split() if deps else [], goal=goal, steps=steps,
                      contract=contract, acceptance=acceptance, tests=tests, risk=risk,
                      refs=list(refs), external=external, milestone=key[:2]))


def load_catalog():
    if TASKS:
        return TASKS
    for name in ("m1", "m2", "m3", "m4", "m5", "m6"):
        exec(compile((ROOT / (name + ".py")).read_text(encoding="utf-8"), name, "exec"), globals())
    return TASKS
