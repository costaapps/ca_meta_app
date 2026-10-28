#!/usr/bin/env python3
"""Run the M1.03 offline version/capability selection experiment."""

import json
from pathlib import Path


FIXTURE_PATH = Path(__file__).with_name("meta-capability-fixtures.json")
SELECTABLE_STATUSES = {"documented-proposal", "repo-observed-proposal"}


class SelectionError(ValueError):
    """A requested fixture is missing or incompatible with the proposal."""


def load_profiles():
    fixture_data = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    if fixture_data.get("synthetic") is not True:
        raise SelectionError("fixture set must be explicitly synthetic")
    profiles = fixture_data.get("profiles")
    if not isinstance(profiles, list) or not profiles:
        raise SelectionError("fixture set has no profiles")

    keys = [
        (
            item.get("app_alias"),
            item.get("environment"),
            item.get("graph_api_version"),
            item.get("flow"),
        )
        for item in profiles
    ]
    if len(keys) != len(set(keys)):
        raise SelectionError("duplicate app/environment/version/flow fixture")
    return profiles


def select_capability(
    profiles,
    *,
    app_alias,
    environment,
    graph_api_version,
    flow,
    config_alias,
    operation,
):
    candidates = [
        item
        for item in profiles
        if item["app_alias"] == app_alias
        and item["environment"] == environment
        and item["flow"] == flow
    ]
    if not candidates:
        raise SelectionError("no profile for requested app/environment/flow")

    profile = next(
        (item for item in candidates if item["graph_api_version"] == graph_api_version),
        None,
    )
    if profile is None:
        configured_versions = sorted({item["graph_api_version"] for item in candidates})
        raise SelectionError(
            f"Graph API version {graph_api_version} not configured; "
            f"fixture versions: {', '.join(configured_versions)}"
        )
    if profile["config_alias"] != config_alias:
        raise SelectionError(
            f"config alias {config_alias} is incompatible with flow {flow}"
        )

    capability = profile.get("capabilities", {}).get(operation)
    if capability is None:
        raise SelectionError(f"operation {operation} is not declared for flow {flow}")
    status = capability.get("status")
    if status not in SELECTABLE_STATUSES:
        raise SelectionError(
            f"capability {flow}/{operation} is {status}; evidence gate is unresolved"
        )
    return profile, capability


def expect_selected(profiles, label, request, expected_status, expected_scopes):
    profile, capability = select_capability(profiles, **request)
    if capability["status"] != expected_status:
        raise AssertionError(f"{label}: unexpected capability status {capability['status']}")
    if capability["scopes"] != expected_scopes:
        raise AssertionError(f"{label}: unexpected proposed scopes {capability['scopes']}")
    scopes = ",".join(capability["scopes"]) or "none"
    print(
        f"PASS select {label}: graph={profile['graph_api_version']} "
        f"status={capability['status']} scopes={scopes}"
    )


def expect_rejected(profiles, label, request, message_fragment):
    try:
        select_capability(profiles, **request)
    except SelectionError as error:
        if message_fragment not in str(error):
            raise AssertionError(
                f"{label}: rejected for unexpected reason: {error}"
            ) from error
        print(f"PASS reject {label}: {error}")
        return
    raise AssertionError(f"{label}: incompatible request was selected")


def main():
    profiles = load_profiles()
    expected_flows = {
        "whatsapp_cloud_exclusive",
        "whatsapp_coexistence",
        "facebook_page",
        "instagram_professional_facebook_login",
    }
    present_flows = {item["flow"] for item in profiles}
    if not expected_flows.issubset(present_flows):
        raise AssertionError("one or more required flow fixtures are missing")
    variants = {item["variant"] for item in profiles}
    if len(variants) != len(profiles):
        raise AssertionError("flow variants must have distinct config profiles")

    common = {
        "app_alias": "fixture-meta-app",
        "environment": "fixture-sandbox",
        "graph_api_version": "v24.0",
    }
    expect_selected(
        profiles,
        "WhatsApp Cloud SEND_MESSAGE",
        {
            **common,
            "flow": "whatsapp_cloud_exclusive",
            "config_alias": "fixture-wa-cloud-exclusive",
            "operation": "SEND_MESSAGE",
        },
        "documented-proposal",
        ["whatsapp_business_messaging"],
    )
    expect_selected(
        profiles,
        "Facebook Page READ_STATUS",
        {
            **common,
            "flow": "facebook_page",
            "config_alias": "fixture-facebook-page",
            "operation": "READ_STATUS",
        },
        "repo-observed-proposal",
        ["pages_show_list", "pages_read_engagement"],
    )
    expect_selected(
        profiles,
        "Instagram Facebook Login READ_STATUS",
        {
            **common,
            "flow": "instagram_professional_facebook_login",
            "config_alias": "fixture-instagram-facebook-login",
            "operation": "READ_STATUS",
        },
        "repo-observed-proposal",
        ["pages_show_list", "instagram_basic"],
    )
    expect_selected(
        profiles,
        "Instagram Login SEND_MESSAGE",
        {
            **common,
            "flow": "instagram_professional_instagram_login",
            "config_alias": "fixture-instagram-login",
            "operation": "SEND_MESSAGE",
        },
        "documented-proposal",
        ["instagram_business_manage_messages"],
    )

    expect_rejected(
        profiles,
        "unconfigured Graph version",
        {
            **{**common, "graph_api_version": "v25.0"},
            "flow": "whatsapp_cloud_exclusive",
            "config_alias": "fixture-wa-cloud-exclusive",
            "operation": "SEND_MESSAGE",
        },
        "not configured",
    )
    expect_rejected(
        profiles,
        "Cloud config on Coexistence flow",
        {
            **common,
            "flow": "whatsapp_coexistence",
            "config_alias": "fixture-wa-cloud-exclusive",
            "operation": "SEND_MESSAGE",
        },
        "incompatible with flow",
    )
    expect_rejected(
        profiles,
        "unconfirmed Coexistence capability",
        {
            **common,
            "flow": "whatsapp_coexistence",
            "config_alias": "fixture-wa-coexistence",
            "operation": "SEND_MESSAGE",
        },
        "evidence gate is unresolved",
    )
    expect_rejected(
        profiles,
        "unmatched production environment",
        {
            **{**common, "environment": "production"},
            "flow": "facebook_page",
            "config_alias": "fixture-facebook-page",
            "operation": "READ_STATUS",
        },
        "no profile",
    )

    print(
        "PASS distinct flow/config variants: WhatsApp Cloud exclusive, "
        "WhatsApp Coexistence, Facebook Page, Instagram via Facebook Login, "
        "and separate optional Instagram Login"
    )
    print("LIMITATION synthetic offline selection only; no Meta or Sandbox result")


if __name__ == "__main__":
    main()
