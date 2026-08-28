#!/usr/bin/env python3
"""Safe pre-start readiness probe for an independently operated Hermes employee."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid


PROTOCOL_VERSION = "deft.agent_channel.v2"
ADAPTER_VERSION = "0.2.1"
CAPABILITY = "autonomous_platform_adapter_v1,accepted_event_rehydration_v1"
REQUIRED_TOOLS = {
    "attachment_list",
    "attachment_read",
    "fetch_unread",
    "memory_recall",
    "record_progress",
    "request_human_approval",
    "send_message",
    "task_detail",
    "task_update",
    "thread_fetch",
    "wiki_search",
    "workspace_plan_import",
    "document_send",
}


def _request_json(url: str, *, token: str, body: dict | None = None) -> dict:
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        url,
        data=payload,
        method="POST" if payload is not None else "GET",
        headers={
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
            **({"Content-Type": "application/json"} if payload is not None else {}),
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"HTTP {exc.code}: {detail}") from exc


def _rpc(mcp_url: str, token: str, method: str, params: dict, request_id: str) -> dict:
    response = _request_json(
        mcp_url.rstrip("/"),
        token=token,
        body={"jsonrpc": "2.0", "id": request_id, "method": method, "params": params},
    )
    if response.get("error"):
        raise RuntimeError(f"MCP {method} failed: {response['error']}")
    result = response.get("result")
    if not isinstance(result, dict):
        raise RuntimeError(f"MCP {method} returned no result object")
    return result


def _tool_call(mcp_url: str, token: str, name: str, arguments: dict) -> dict:
    result = _rpc(
        mcp_url,
        token,
        "tools/call",
        {"name": name, "arguments": arguments},
        f"readiness-{name}",
    )
    outcome = result.get("structuredContent")
    if result.get("isError") is True or (
        isinstance(outcome, dict)
        and outcome.get("schema") == "deft.tool_outcome.v1"
        and outcome.get("deft_status") != "ok"
    ):
        raise RuntimeError(f"MCP tool {name} rejected the readiness probe")
    return result


def run(args: argparse.Namespace) -> dict:
    worker_id = f"deft-readiness-{uuid.uuid4()}"
    channel_base = args.channel_url.rstrip("/")
    checks: list[dict] = []
    warnings = [
        "Deft did not inspect the Hermes model or reasoning configuration.",
        "Deft did not inspect Hermes skills, browser, search, or external connectors.",
        "Those runtime capabilities remain the operator's responsibility.",
    ]

    query = urllib.parse.urlencode({
        "protocol_version": PROTOCOL_VERSION,
        "adapter_version": ADAPTER_VERSION,
        "capabilities": CAPABILITY,
        "worker_id": worker_id,
        "caller_employee_slug": args.employee_slug,
    })
    connected = _request_json(f"{channel_base}/connect?{query}", token=args.channel_token)
    employee = connected.get("employee") if isinstance(connected.get("employee"), dict) else {}
    channel_ok = (
        connected.get("adapter_mode") == "autonomous_platform"
        and employee.get("slug") == args.employee_slug
    )
    checks.append({
        "name": "channel_identity",
        "ok": channel_ok,
        "adapter_mode": connected.get("adapter_mode"),
        "employee_slug": employee.get("slug"),
    })

    listed = _rpc(args.mcp_url, args.mcp_token, "tools/list", {}, "readiness-tools")
    tools = listed.get("tools") if isinstance(listed.get("tools"), list) else []
    tool_names = {str(tool.get("name")) for tool in tools if isinstance(tool, dict)}
    missing = sorted(REQUIRED_TOOLS - tool_names)
    checks.append({
        "name": "identity_bound_mcp",
        "ok": len(tools) >= args.min_tools and not missing,
        "tool_count": len(tools),
        "minimum_tool_count": args.min_tools,
        "missing_required_tools": missing,
    })

    if args.task_id or args.task_key:
        if not args.task_id or not args.task_key:
            raise RuntimeError("--task-id and --task-key must be supplied together")
        _tool_call(args.mcp_url, args.mcp_token, "task_detail", {"task_identifier": args.task_key})
        checks.append({"name": "employee_task_read", "ok": True, "task_key": args.task_key})
        _tool_call(args.mcp_url, args.mcp_token, "record_progress", {
            "task_id": args.task_id,
            "summary": "Fresh Hermes profile passed its identity-bound Deft readiness probe.",
            "status": "working",
            "idempotency_key": f"native-profile-readiness:{args.task_id}",
        })
        checks.append({"name": "governed_progress_write", "ok": True, "task_id": args.task_id})

    try:
        _request_json(
            f"{channel_base}/status",
            token=args.channel_token,
            body={
                "state": "offline",
                "worker_id": worker_id,
                "caller_employee_slug": args.employee_slug,
            },
        )
    except Exception as exc:
        warnings.append(f"Could not record the probe disconnect: {exc}")

    return {
        "ready": all(check["ok"] for check in checks),
        "profile": "deft-independent-hermes-v1",
        "checks": checks,
        "warnings": warnings,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--channel-url", default=os.getenv("DEFT_CHANNEL_URL"), required=not os.getenv("DEFT_CHANNEL_URL"))
    parser.add_argument("--channel-token", default=os.getenv("DEFT_CHANNEL_TOKEN"), required=not os.getenv("DEFT_CHANNEL_TOKEN"))
    parser.add_argument("--employee-slug", default=os.getenv("DEFT_EMPLOYEE_SLUG"), required=not os.getenv("DEFT_EMPLOYEE_SLUG"))
    parser.add_argument("--mcp-url", default=os.getenv("DEFT_MCP_URL"), required=not os.getenv("DEFT_MCP_URL"))
    parser.add_argument("--mcp-token", default=os.getenv("DEFT_MCP_TOKEN"), required=not os.getenv("DEFT_MCP_TOKEN"))
    parser.add_argument("--min-tools", type=int, default=48)
    parser.add_argument("--task-id")
    parser.add_argument("--task-key")
    return parser.parse_args()


def main() -> int:
    try:
        report = run(parse_args())
    except Exception as exc:
        report = {"ready": False, "error": str(exc)}
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report.get("ready") else 1


if __name__ == "__main__":
    sys.exit(main())
