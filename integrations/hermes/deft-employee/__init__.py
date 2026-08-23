"""Thin Deft policy and reporting hooks for Hermes Agent."""

from __future__ import annotations

import json
import os
import re
import urllib.request
from typing import Any, Dict


SECRET_PATTERNS = (
    re.compile(r"-----BEGIN .*PRIVATE KEY-----", re.I),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.I),
    re.compile(r"\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S{8,}", re.I),
)
WRITE_HINT = re.compile(r"(?:send|email|post|publish|delete|remove|create|update|write|execute|deploy)", re.I)
DESTRUCTIVE_COMMAND = re.compile(r"(?:rm\s+-rf|del\s+/[sq]|format\s+[a-z]:|git\s+reset\s+--hard)", re.I)


def _sanitize(value: Any, limit: int = 900) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str, ensure_ascii=False)
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text[:limit]


class DeftEmployeeHooks:
    def __init__(self) -> None:
        self.base_url = os.environ.get("DEFT_MCP_URL", "").rstrip("/")
        self.token = os.environ.get("DEFT_MCP_TOKEN", "")
        self.employee_slug = os.environ.get("DEFT_EMPLOYEE_SLUG", "unknown")
        try:
            self.policy = json.loads(os.environ.get("DEFT_EMPLOYEE_POLICY_JSON", "{}"))
        except json.JSONDecodeError:
            self.policy = {"invalid": True}
        self.tool_calls = 0

    def call_deft(self, name: str, arguments: Dict[str, Any]) -> Any:
        if not self.base_url or not self.token:
            return None
        request = urllib.request.Request(
            f"{self.base_url}/tools/call",
            data=json.dumps({"name": name, "arguments": arguments}).encode(),
            headers={"Authorization": f"Bearer {self.token}", "Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(request, timeout=5) as response:
            return json.loads(response.read().decode())

    def pre_llm_call(self, session_id: str = "", **kwargs: Any) -> Dict[str, str]:
        budgets = self.policy.get("budgets", {})
        return {"context": json.dumps({
            "deft_employee_identity": self.employee_slug,
            "identity_source": "authenticated bearer token",
            "session_id": session_id,
            "assignment_policy": self.policy.get("assignment", {}),
            "budgets": budgets,
            "reporting": "Report milestones, ask a precise human question when blocked, and return evidence plus truthful outcome.",
        }, ensure_ascii=False)}

    def pre_tool_call(self, tool_name: str = "", args: Any = None, **kwargs: Any):
        args = args if isinstance(args, dict) else {}
        if self.policy.get("invalid"):
            return {"action": "block", "message": "Deft employee policy is invalid; human assistance is required."}
        if tool_name in set(self.policy.get("forbidden_tools", [])):
            return {"action": "block", "message": f"Deft policy forbids {tool_name} for this assignment."}
        max_calls = int(self.policy.get("budgets", {}).get("max_tool_calls", 0) or 0)
        if max_calls and self.tool_calls >= max_calls:
            return {"action": "block", "message": "Deft tool-call budget is exhausted; ask for human assistance."}
        rendered = _sanitize(args, 2000)
        if tool_name in {"terminal", "process"} and DESTRUCTIVE_COMMAND.search(rendered):
            return {"action": "block", "message": "Destructive command blocked by Deft employee policy."}
        is_deft_tool = (
            tool_name.startswith("mcp__deft")
            or tool_name.startswith("mcp_deft_")
            or tool_name.startswith("deft_")
        )
        if WRITE_HINT.search(tool_name) and not is_deft_tool and not self.policy.get("allow_external_writes", False):
            return {"action": "block", "message": "External write needs Deft human approval for this assignment."}
        self.tool_calls += 1
        return None

    def post_tool_call(
        self,
        tool_name: str = "",
        args: Any = None,
        result: Any = None,
        duration_ms: int = 0,
        task_id: str = "",
        session_id: str = "",
        turn_id: str = "",
        tool_call_id: str = "",
        status: str = "",
        error_type: str = "",
        error_message: str = "",
        **kwargs: Any,
    ) -> None:
        normalized_status = status.lower() if status else ("error" if error_message else "ok")
        success = normalized_status in {"ok", "completed", "success"}
        detail = error_message if not success and error_message else result
        summary = f"{tool_name} {normalized_status} in {duration_ms}ms: {_sanitize(detail)}"
        try:
            self.call_deft("record_action_attempt", {
                "summary": summary,
                "session_turn_id": turn_id or task_id or session_id or None,
                "metadata": {
                    "tool": tool_name,
                    "tool_call_id": tool_call_id or None,
                    "success": success,
                    "status": normalized_status,
                    "error_type": error_type or None,
                },
            })
        except Exception:
            pass

    def subagent_stop(
        self,
        child_session_id: str = "",
        child_role: str = "",
        child_summary: Any = None,
        child_status: str = "",
        duration_ms: int = 0,
        parent_turn_id: str = "",
        **kwargs: Any,
    ) -> None:
        normalized_status = child_status.lower() or "unknown"
        success = normalized_status in {"ok", "completed", "success"}
        try:
            self.call_deft("record_outcome", {
                "summary": f"Delegated {child_role or 'worker'} {normalized_status}: {_sanitize(child_summary)}",
                "session_turn_id": parent_turn_id or child_session_id or None,
                "metadata": {
                    "status": normalized_status,
                    "success": success,
                    "child_role": child_role,
                    "child_session_id": child_session_id or None,
                    "duration_ms": duration_ms,
                },
            })
        except Exception:
            pass


def register(ctx: Any) -> None:
    hooks = DeftEmployeeHooks()
    ctx.register_hook("pre_llm_call", hooks.pre_llm_call)
    ctx.register_hook("pre_tool_call", hooks.pre_tool_call)
    ctx.register_hook("post_tool_call", hooks.post_tool_call)
    ctx.register_hook("subagent_stop", hooks.subagent_stop)
