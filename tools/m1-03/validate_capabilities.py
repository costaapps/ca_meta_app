#!/usr/bin/env python3
"""Offline compatibility check for proposed Meta flow configuration.

This experiment consumes synthetic profiles only. It has no HTTP client, does not
read environment variables, and never handles credentials.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

FIXTURE = Path(__file__).parent / "fixtures" / "capability-profiles.json"
WHATSAPP_FLOWS = {"WHATSAPP_EXCLUSIVE", "WHATSAPP_COEXISTENCE"}
FORBIDDEN_COEXISTENCE_OPERATIONS = {"PHONE_REGISTRATION_CONVENTIONAL"}
REQUIRED_KEYS = {
    "profile_id",
    "app_id",
    "environment",
    "graph_api_version",
    "flow",
    "auth_variant",
    "operation",
}
FORBIDDEN_SECRET_KEY_PARTS = ("token", "secret", "credential", "private_key")


class ConfigurationError(ValueError):
    """The requested app, environment, flow, version, or capability is invalid."""


def _contains_secret_key(value: Any, path: str = "fixture") -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            lowered = str(key).lower()
            if any(part in lowered for part in FORBIDDEN_SECRET_KEY_PARTS):
                raise ConfigurationError(f"secret-like field name is forbidden: {path}.{key}")
            _contains_secret_key(child, f"{path}.{key}")
    elif isinstance(value, list):
        for index, child in enumerate(value):
            _contains_secret_key(child, f"{path}[{index}]")


def resolve_capability(fixture: dict[str, Any], request: dict[str, Any]) -> dict[str, str]:
    missing = REQUIRED_KEYS.difference(request)
    if missing:
        raise ConfigurationError(f"missing request fields: {', '.join(sorted(missing))}")

    profile = fixture.get("profiles", {}).get(request["profile_id"])
    if profile is None:
        raise ConfigurationError("unknown app profile")
    for field in ("app_id", "environment", "graph_api_version"):
        if request[field] != profile.get(field):
            raise ConfigurationError(f"{field} does not match the selected app/environment profile")

    flow = request["flow"]
    flow_profile = profile.get("flows", {}).get(flow)
    if flow_profile is None:
        raise ConfigurationError("flow is not configured for this app/environment")

    if flow in WHATSAPP_FLOWS:
        configured = profile.get("embedded_signup_version")
        if not configured or request.get("embedded_signup_version") != configured:
            raise ConfigurationError("WhatsApp flow must select the configured Embedded Signup version")
    elif request.get("embedded_signup_version") is not None:
        raise ConfigurationError("Embedded Signup version is not part of this non-WhatsApp flow profile")

    if request["auth_variant"] not in flow_profile.get("auth_variants", []):
        raise ConfigurationError("auth variant is not allowed by this flow profile")

    operation = request["operation"]
    if flow == "WHATSAPP_COEXISTENCE" and operation in FORBIDDEN_COEXISTENCE_OPERATIONS:
        raise ConfigurationError("conventional phone registration is forbidden in the Coexistence adapter")
    if operation not in flow_profile.get("capabilities", []):
        raise ConfigurationError("operation is not present in the selected flow capability profile")

    selected = {
        "app_id": profile["app_id"],
        "environment": profile["environment"],
        "graph_api_version": profile["graph_api_version"],
        "flow": flow,
        "operation": operation,
    }
    if flow in WHATSAPP_FLOWS:
        selected["embedded_signup_version"] = profile["embedded_signup_version"]
    return selected


def run(fixture: dict[str, Any]) -> tuple[int, int]:
    _contains_secret_key(fixture)
    cases = fixture.get("cases", [])
    if not cases:
        raise ConfigurationError("fixture has no cases")

    passed = 0
    for case in cases:
        expected_accept = case["expect"] == "accept"
        try:
            selected = resolve_capability(fixture, case["request"])
            actual_accept = True
            if expected_accept and selected != case.get("selected"):
                raise AssertionError(f"{case['name']}: selected profile mismatch: {selected!r}")
        except ConfigurationError as exc:
            actual_accept = False
            if expected_accept:
                print(f"FAIL {case['name']}: unexpectedly rejected ({exc})")
                continue
        if actual_accept != expected_accept:
            print(f"FAIL {case['name']}: expected {case['expect']}, got {'accept' if actual_accept else 'reject'}")
            continue
        passed += 1
        print(f"PASS {case['name']}")
    print(f"\n{passed}/{len(cases)} compatibility cases passed; all profiles are synthetic and offline.")
    return passed, len(cases)


def main() -> int:
    try:
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        passed, total = run(fixture)
    except (OSError, json.JSONDecodeError, ConfigurationError) as exc:
        print(f"ERROR {exc}", file=sys.stderr)
        return 2
    return 0 if passed == total else 1


if __name__ == "__main__":
    raise SystemExit(main())
