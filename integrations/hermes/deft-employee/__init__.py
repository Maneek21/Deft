"""Thin Deft policy and reporting hooks for Hermes Agent."""

from __future__ import annotations

import json
import hashlib
import os
import re
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any, Dict


SECRET_PATTERNS = (
    re.compile(r"-----BEGIN .*PRIVATE KEY-----", re.I),
    re.compile(r"\bBearer\s+[A-Za-z0-9._~+/=-]{12,}", re.I),
    re.compile(r"\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*\S{8,}", re.I),
)
WRITE_HINT = re.compile(r"(?:send|email|post|publish|delete|remove|create|update|write|execute|deploy)", re.I)
DESTRUCTIVE_COMMAND = re.compile(r"(?:rm\s+-rf|del\s+/[sq]|format\s+[a-z]:|git\s+reset\s+--hard)", re.I)


DEFT_MCP_TOOL_SCHEMAS = {
    "attachment_list": {
        "name": "deft_attachment_list",
        "description": (
            "List bounded attachment manifests for one visible Deft message or task. "
            "Provide exactly one target."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "message_id": {"type": "string"},
                "task_id": {"type": "string"},
            },
            "additionalProperties": False,
        },
    },
    "attachment_read": {
        "name": "deft_attachment_read",
        "description": (
            "Read one visible Deft attachment through current permission checks. "
            "Text mode returns bounded extracted text; image_question returns bounded vision evidence."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "attachment_id": {"type": "string"},
                "mode": {"type": "string", "enum": ["text", "image_question"]},
                "question": {"type": "string", "maxLength": 1000},
            },
            "required": ["attachment_id"],
            "additionalProperties": False,
        },
    },
    "workspace_plan_import": {
        "name": "deft_workspace_plan_import",
        "description": (
            "Prepare a CSV or XLSX attached to a visible Deft message as one full-review "
            "project/task import. Nothing is created before approval."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "message_id": {"type": "string"},
                "attachment_id": {"type": "string"},
            },
            "required": ["message_id"],
            "additionalProperties": False,
        },
    },
    "document_send": {
        "name": "deft_document_send",
        "description": (
            "Create a protected Markdown, plain-text, or inert CSV document and share it "
            "through Deft chat after full human review."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "source_message_id": {"type": "string"},
                "filename": {"type": "string", "minLength": 1, "maxLength": 128},
                "mime_type": {
                    "type": "string",
                    "enum": ["text/markdown", "text/plain", "text/csv"],
                },
                "content": {"type": "string", "minLength": 1, "maxLength": 65536},
                "caption": {"type": "string", "minLength": 1, "maxLength": 2000},
                "target": {
                    "oneOf": [
                        {
                            "type": "object",
                            "required": ["space_id"],
                            "properties": {"space_id": {"type": "string"}},
                            "additionalProperties": False,
                        },
                        {
                            "type": "object",
                            "required": ["thread_id"],
                            "properties": {"thread_id": {"type": "string"}},
                            "additionalProperties": False,
                        },
                        {
                            "type": "object",
                            "required": ["user_id"],
                            "properties": {"user_id": {"type": "string"}},
                            "additionalProperties": False,
                        },
                    ],
                },
                "idempotency_key": {"type": "string", "maxLength": 128},
            },
            "required": ["source_message_id", "filename", "mime_type", "content"],
            "additionalProperties": False,
        },
    },
}


def _sanitize(value: Any, limit: int = 900) -> str:
    text = value if isinstance(value, str) else json.dumps(value, default=str, ensure_ascii=False)
    for pattern in SECRET_PATTERNS:
        text = pattern.sub("[REDACTED]", text)
    return text[:limit]


def _is_deft_tool(tool_name: str) -> bool:
    return (
        tool_name.startswith("mcp__deft")
        or tool_name.startswith("mcp_deft_")
        or tool_name.startswith("deft_")
    )


def _provider_receipt(result: Any) -> Dict[str, str]:
    if isinstance(result, str):
        try:
            result = json.loads(result)
        except (TypeError, json.JSONDecodeError):
            return {}
    if not isinstance(result, dict):
        return {}
    receipt: Dict[str, str] = {}
    aliases = {
        "id", "message_id", "receipt_id", "request_id", "delivery_id",
        "status", "accepted_at", "sent_at", "delivered_at",
    }
    for key, value in result.items():
        normalized = str(key).lower()
        if normalized in aliases and isinstance(value, (str, int, float, bool)):
            receipt[normalized] = _sanitize(value, 300)
        elif isinstance(value, dict) and normalized in {"data", "result", "receipt", "response"}:
            receipt.update(_provider_receipt(value))
    return receipt


def _provider_accepted(success: bool, receipt: Dict[str, str]) -> bool:
    if not success or not any(key in receipt for key in (
        "id", "message_id", "receipt_id", "request_id", "delivery_id",
    )):
        return False
    status = receipt.get("status", "").lower()
    return not status or status in {"accepted", "sent", "delivered", "success", "succeeded", "ok"}


class DeftMcpToolBridge:
    """Expose a narrow Deft-owned tool seam without changing Hermes core."""

    def __init__(self) -> None:
        self.base_url = os.environ.get("DEFT_MCP_URL", "").rstrip("/")
        self.token = os.environ.get("DEFT_MCP_TOKEN", "")
        self.employee_slug = os.environ.get("DEFT_EMPLOYEE_SLUG", "")

    def available(self) -> bool:
        return bool(self.base_url and self.token and self.employee_slug)

    def call(self, name: str, arguments: Dict[str, Any]) -> str:
        if name not in DEFT_MCP_TOOL_SCHEMAS:
            raise RuntimeError("Unsupported Deft plugin tool")
        if not self.available():
            raise RuntimeError("Deft MCP identity is not configured")
        scoped_arguments = dict(arguments) if isinstance(arguments, dict) else {}
        scoped_arguments["caller_employee_slug"] = self.employee_slug
        body = {
            "jsonrpc": "2.0",
            "id": f"deft-plugin-{uuid.uuid4()}",
            "method": "tools/call",
            "params": {"name": name, "arguments": scoped_arguments},
        }
        request = urllib.request.Request(
            self.base_url,
            data=json.dumps(body).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                payload = json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"Deft MCP HTTP {exc.code}: {_sanitize(detail, 500)}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError("Deft MCP is unavailable") from exc
        if payload.get("error"):
            raise RuntimeError(f"Deft MCP {name} failed: {_sanitize(payload['error'], 500)}")
        result = payload.get("result")
        if not isinstance(result, dict):
            raise RuntimeError(f"Deft MCP {name} returned no result object")
        return json.dumps(result, ensure_ascii=False)


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
            "deft_progress_contract": "For task assignments call record_progress when beginning with a concise plan, at meaningful milestones, and when a blocker or retry approach changes. Use a stable idempotency_key. Do not mirror every tool call or post routine progress to chat.",
            "deft_task_contract": "Read allowed_next_statuses from task_query/task_detail before changing status. On INVALID_TRANSITION, choose only from the returned allowed_next_statuses.",
            "deft_module_contract": "Call module_schema_get before module writes. Follow its exact input_schema and collection example; put scalar fields in data/patch and links in relations: {field_key: [record_ids]}.",
            "deft_tool_outcome_contract": "When structuredContent uses deft.tool_outcome.v1, only deft_status=ok is success. Treat every other status as failed, never claim completion, and do not retry unchanged arguments.",
            "deft_external_action_contract": "A runtime tool success is not proof that a provider accepted an external write. Require a provider receipt or message/request/delivery id before claiming sent or creating a sent activity in Deft; otherwise report an unverified or failed outcome.",
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
        if WRITE_HINT.search(tool_name) and not _is_deft_tool(tool_name) and not self.policy.get("allow_external_writes", False):
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
        external_write = bool(WRITE_HINT.search(tool_name)) and not _is_deft_tool(tool_name)
        if success and not external_write:
            return
        detail = error_message if not success and error_message else result
        receipt = _provider_receipt(result) if external_write else {}
        provider_accepted = _provider_accepted(success, receipt)
        payload = _sanitize(args if isinstance(args, dict) else {}, 2000)
        payload_digest = "sha256:" + hashlib.sha256(payload.encode()).hexdigest()
        if external_write and success and not provider_accepted:
            detail = "tool returned success without a provider acceptance receipt"
        summary = f"{tool_name} {normalized_status} in {duration_ms}ms: {_sanitize(detail)}"
        identity = tool_call_id or hashlib.sha256(
            f"{session_id}\0{turn_id}\0{tool_name}\0{payload_digest}".encode()
        ).hexdigest()
        try:
            self.call_deft("record_action_attempt", {
                "summary": summary,
                "session_turn_id": turn_id or task_id or session_id or None,
                "idempotency_key": f"external-tool:{identity}",
                "metadata": {
                    "tool": tool_name,
                    "tool_call_id": tool_call_id or None,
                    "success": success,
                    "status": normalized_status,
                    "error_type": error_type or None,
                    "external_write": external_write,
                    "proposed_payload": payload if external_write else None,
                    "proposed_payload_digest": payload_digest if external_write else None,
                    "provider_accepted": provider_accepted,
                    "provider_receipt": receipt or None,
                    "evidence_authority": "runtime_reported",
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
    bridge = DeftMcpToolBridge()
    for remote_name, schema in DEFT_MCP_TOOL_SCHEMAS.items():
        def handler(args: Dict[str, Any], _remote_name: str = remote_name, **_kwargs: Any) -> str:
            return bridge.call(_remote_name, args)

        ctx.register_tool(
            name=schema["name"],
            toolset="deft_workspace",
            schema=schema,
            handler=handler,
            check_fn=bridge.available,
            requires_env=["DEFT_MCP_URL", "DEFT_MCP_TOKEN", "DEFT_EMPLOYEE_SLUG"],
            description=schema["description"],
            emoji="🔒",
        )
    ctx.register_skill(
        "runtime",
        Path(__file__).with_name("SKILL.md"),
        "Deft employee assignment, tool-outcome, approval, and evidence rules.",
    )
    ctx.register_hook("pre_llm_call", hooks.pre_llm_call)
    ctx.register_hook("pre_tool_call", hooks.pre_tool_call)
    ctx.register_hook("post_tool_call", hooks.post_tool_call)
    ctx.register_hook("subagent_stop", hooks.subagent_stop)
