#!/usr/bin/env python3
"""Offline source trace for the versioned Angular/PHP baseline.

This harness reads repository source and synthetic route fixtures only. It never
starts PHP, makes HTTP/Meta requests, or opens a database connection.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
PHP_FILES = (
    "backend/connect_whatsapp.php",
    "backend/connect_facebook.php",
    "backend/connect_instagram.php",
    "backend/meta_auth_helper.php",
)


def read_text(relative_path: str) -> str:
    return (ROOT / relative_path).read_text(encoding="utf-8")


def discover_php_functions() -> set[tuple[str, str]]:
    found: set[tuple[str, str]] = set()
    declaration = re.compile(r"\bfunction\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(")
    for relative_path in PHP_FILES:
        for match in declaration.finditer(read_text(relative_path)):
            found.add((relative_path, match.group(1)))
    return found


def discover_whatsapp_routes() -> list[tuple[str, str, str]]:
    source = read_text("backend/connect_whatsapp.php")
    try:
        router = source.split("// ============ ROTEAMENTO ============", 1)[1].split(
            "// ============ FUNÇÕES HANDLERS ============", 1
        )[0]
    except IndexError as error:
        raise AssertionError("Could not locate the versioned WhatsApp router block") from error

    route_pattern = re.compile(
        r"(?:if|elseif)\s*\(\s*\$method\s*===\s*['\"](?P<method>GET|POST)['\"]"
        r"\s*&&\s*strpos\(\$path,\s*['\"](?P<path>[^'\"]+)['\"]\)\s*!==\s*false\s*\)"
        r"\s*\{\s*(?P<handler>[A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)",
        re.MULTILINE,
    )
    return [
        (match.group("method"), match.group("path"), match.group("handler"))
        for match in route_pattern.finditer(router)
    ]


def discover_whatsapp_preflight_status() -> int | None:
    source = read_text("backend/connect_whatsapp.php")
    try:
        header_block = source.split("// ============ HEADERS & CORS ============", 1)[1].split(
            "// ============ ROTEAMENTO ============", 1
        )[0]
    except IndexError as error:
        raise AssertionError("Could not locate the WhatsApp preflight/header block") from error

    preflight_pattern = re.compile(
        r"if\s*\(\s*\$_SERVER\[['\"]REQUEST_METHOD['\"]\]\s*===\s*['\"]OPTIONS['\"]\s*\)"
        r"\s*\{\s*http_response_code\((?P<status>\d+)\);\s*exit;",
        re.MULTILINE,
    )
    match = preflight_pattern.search(header_block)
    return int(match.group("status")) if match else None


def load_matrix(path: Path) -> list[dict[str, str]]:
    with path.open(encoding="utf-8-sig", newline="") as matrix_file:
        return list(csv.DictReader(matrix_file))


def route_match(method: str, request_path: str, routes: list[tuple[str, str, str]]) -> str | None:
    for route_method, path_suffix, handler in routes:
        if route_method == method and path_suffix in request_path:
            return handler
    return None


def assert_frontend_request(row: dict[str, str]) -> None:
    source = read_text(row["source_file"])
    indexes = [match.start() for match in re.finditer(re.escape(row["path_or_symbol"]), source)]
    if not indexes:
        raise AssertionError(
            f"Frontend request path {row['path_or_symbol']} missing from {row['source_file']}"
        )

    method_pattern = re.compile(r"\.(get|post)\s*(?:<[^>]*>)?\s*\(", re.IGNORECASE)
    for path_index in indexes:
        nearby = source[max(0, path_index - 500) : path_index]
        method_calls = list(method_pattern.finditer(nearby))
        if method_calls and method_calls[-1].group(1).upper() == row["method"]:
            return
    raise AssertionError(
        f"Expected {row['method']} request for {row['path_or_symbol']} in {row['source_file']}"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--fixture",
        type=Path,
        default=ROOT / "docs/baseline/fixtures/routes.json",
        help="Synthetic routes fixture (default: docs/baseline/fixtures/routes.json)",
    )
    parser.add_argument(
        "--matrix",
        type=Path,
        default=ROOT / "docs/baseline/endpoint-matrix.csv",
        help="Endpoint matrix used for function and route coverage",
    )
    args = parser.parse_args()

    fixture = json.loads(args.fixture.read_text(encoding="utf-8"))
    matrix = load_matrix(args.matrix)

    actual_functions = discover_php_functions()
    documented_functions = {
        (row["source_file"], row["source_symbol"])
        for row in matrix
        if row["kind"] == "php_function"
    }
    missing_functions = actual_functions - documented_functions
    stale_functions = documented_functions - actual_functions
    if missing_functions or stale_functions:
        raise AssertionError(
            f"PHP function inventory mismatch; missing={sorted(missing_functions)}; "
            f"stale={sorted(stale_functions)}"
        )

    actual_routes_list = discover_whatsapp_routes()
    actual_routes = set(actual_routes_list)
    matrix_routes = {
        (row["method"], row["path_or_symbol"], row["source_symbol"])
        for row in matrix
        if row["kind"] == "php_route" and row["method"] in {"GET", "POST"}
    }
    if actual_routes != matrix_routes:
        raise AssertionError(
            f"WhatsApp router matrix mismatch; source={sorted(actual_routes)}; "
            f"matrix={sorted(matrix_routes)}"
        )

    preflight_rows = [
        row
        for row in matrix
        if row["kind"] == "php_route" and row["method"] == "OPTIONS"
    ]
    preflight_status = discover_whatsapp_preflight_status()
    if (
        len(preflight_rows) != 1
        or preflight_rows[0]["source_symbol"] != "preflight"
        or preflight_status is None
    ):
        raise AssertionError(
            f"Expected one documented OPTIONS preflight branch; rows={len(preflight_rows)}; "
            f"source status={preflight_status}"
        )

    angular_source = read_text("src/app/app.routes.ts")
    actual_angular_routes = set(re.findall(r"\bpath\s*:\s*'([^']*)'", angular_source))

    def angular_route_key(value: str) -> str:
        if value == "empty path -> /setup":
            return ""
        if value == "** -> /setup":
            return "**"
        return value.lstrip("/")

    matrix_angular_routes = {
        angular_route_key(row["path_or_symbol"])
        for row in matrix
        if row["kind"] == "angular_route"
    }
    if actual_angular_routes != matrix_angular_routes:
        raise AssertionError(
            f"Angular route matrix mismatch; source={sorted(actual_angular_routes)}; "
            f"matrix={sorted(matrix_angular_routes)}"
        )

    flow_source = read_text("src/app/core/services/meta-auth.service.ts")
    actual_backend_paths = set(re.findall(r"\bbackendPath\s*:\s*'([^']+)'", flow_source))
    matrix_backend_paths = {
        row["path_or_symbol"]
        for row in matrix
        if row["kind"] == "frontend_auth_entry"
    }
    if actual_backend_paths != matrix_backend_paths:
        raise AssertionError(
            f"Frontend auth entry matrix mismatch; source={sorted(actual_backend_paths)}; "
            f"matrix={sorted(matrix_backend_paths)}"
        )

    for row in (item for item in matrix if item["kind"] == "frontend_request"):
        assert_frontend_request(row)

    route_results: list[str] = []
    for case in fixture["requests"]:
        kind = case["kind"]
        if kind == "whatsapp_router":
            observed_handler = route_match(case["method"], case["path"], actual_routes_list)
            if observed_handler != case["source_handler"]:
                raise AssertionError(
                    f"{case['id']}: expected {case['source_handler']}; observed {observed_handler}"
                )
            route_results.append(f"{case['id']} => {observed_handler}")
        elif kind == "whatsapp_preflight":
            if case["method"] != "OPTIONS" or case["source_handler"] != "preflight":
                raise AssertionError(f"{case['id']}: fixture must describe OPTIONS preflight")
            if case["source_status"] != preflight_status:
                raise AssertionError(
                    f"{case['id']}: expected status {case['source_status']}; "
                    f"observed source status {preflight_status}"
                )
            route_results.append(
                f"{case['id']} => OPTIONS preflight returns source status {preflight_status}"
            )
        elif kind == "whatsapp_unmatched_direct_file":
            observed_handler = route_match(case["method"], case["path"], actual_routes_list)
            if observed_handler is not None:
                raise AssertionError(
                    f"{case['id']}: expected no source-router match; observed {observed_handler}"
                )
            route_results.append(
                f"{case['id']} => no matching source-router selector; default branch is 404"
            )
        elif kind == "direct_php_entrypoint":
            source_path = ROOT / case["source_file"]
            if not source_path.is_file():
                raise AssertionError(f"{case['id']}: expected PHP entrypoint does not exist")
            source = source_path.read_text(encoding="utf-8")
            if case.get("required_symbol") and case["required_symbol"] not in source:
                raise AssertionError(
                    f"{case['id']}: expected symbol {case['required_symbol']} missing"
                )
            route_results.append(
                f"{case['id']} => versioned direct PHP script exists (execution not attempted)"
            )
        else:
            raise AssertionError(f"Unknown synthetic request kind: {kind}")

    print(f"PHP functions mapped: {len(actual_functions)}")
    print(f"WhatsApp router selectors mapped (GET/POST): {len(actual_routes)}")
    print("WhatsApp OPTIONS preflight branches mapped: 1")
    print(f"WhatsApp router branches total: {len(actual_routes) + 1}")
    print(f"Angular route declarations mapped: {len(actual_angular_routes)}")
    print(f"Synthetic requests traced: {len(route_results)}")
    for result in route_results:
        print(f"  {result}")
    print("No PHP runtime, HTTP service, database, or Meta provider was invoked.")
    print("PASS: source inventory and synthetic route trace are consistent.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (AssertionError, OSError, json.JSONDecodeError) as error:
        print(f"FAIL: {error}", file=sys.stderr)
        raise SystemExit(1)
