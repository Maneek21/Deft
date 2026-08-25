"""Native Deft messaging adapter for Hermes.

This third-party plugin intentionally owns only the messaging transport. It
does not call a Hermes model endpoint, construct prompts, parse model output,
or supervise the agent's reasoning lifecycle.
"""

from __future__ import annotations

import os
import asyncio
import hashlib
import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Awaitable, Callable, Dict, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, MessageEvent, MessageType, SendResult


PLATFORM_NAME = "deft"
ADAPTER_VERSION = "0.1.0"
CAPABILITY = "autonomous_platform_adapter_v1"
PROTOCOL_VERSION = "deft.agent_channel.v2"

RequestFn = Callable[[str, str, Optional[dict], Optional[dict]], Awaitable[dict]]
DeliveryHandler = Callable[[dict], Awaitable[bool]]


def _configured_value(config: PlatformConfig, key: str, env_name: str) -> str:
    extra = getattr(config, "extra", {}) or {}
    return str(extra.get(key) or os.getenv(env_name, "")).strip()


def _env_enablement() -> Optional[dict]:
    channel_url = os.getenv("DEFT_CHANNEL_URL", "").strip().rstrip("/")
    token = os.getenv("DEFT_CHANNEL_TOKEN", "").strip()
    employee_slug = os.getenv("DEFT_EMPLOYEE_SLUG", "").strip()
    if not channel_url or not token or not employee_slug:
        return None
    return {
        "channel_url": channel_url,
        "token": token,
        "employee_slug": employee_slug,
    }


def validate_config(config: PlatformConfig) -> bool:
    return bool(
        _configured_value(config, "channel_url", "DEFT_CHANNEL_URL")
        and _configured_value(config, "token", "DEFT_CHANNEL_TOKEN")
        and _configured_value(config, "employee_slug", "DEFT_EMPLOYEE_SLUG")
    )


def is_connected(config: PlatformConfig) -> bool:
    """For discovery/status, report whether the adapter is configured."""
    return validate_config(config)


def check_requirements() -> bool:
    """Loop 1 has no dependencies beyond Hermes and Python's stdlib."""
    return True


class DeftAdapter(BasePlatformAdapter):
    """Autonomous Deft transport adapter for Hermes's normal agent loop."""

    def __init__(
        self,
        config: PlatformConfig,
        *,
        request_fn: Optional[RequestFn] = None,
        delivery_handler: Optional[DeliveryHandler] = None,
        start_listener: bool = True,
    ):
        super().__init__(config=config, platform=Platform(PLATFORM_NAME))
        self.channel_url = _configured_value(config, "channel_url", "DEFT_CHANNEL_URL").rstrip("/")
        self.token = _configured_value(config, "token", "DEFT_CHANNEL_TOKEN")
        self.employee_slug = _configured_value(config, "employee_slug", "DEFT_EMPLOYEE_SLUG")
        extra = getattr(config, "extra", {}) or {}
        try:
            self.poll_ms = max(100, int(extra.get("poll_ms") or os.getenv("DEFT_CHANNEL_POLL_MS", "1000")))
        except (TypeError, ValueError):
            self.poll_ms = 1000
        self.worker_id = str(
            extra.get("worker_id")
            or os.getenv("DEFT_CHANNEL_WORKER_ID", "")
            or f"hermes-deft-{socket.gethostname()}-{os.getpid()}"
        )[:200]
        self._request_fn = request_fn or self._http_request
        self._delivery_handler = delivery_handler
        self._start_listener = start_listener
        self._poll_task: Optional[asyncio.Task] = None
        self._last_accepted_event_id: Optional[str] = None
        self._routes_by_message: Dict[str, dict] = {}
        self._routes_by_scope: Dict[tuple[str, str], dict] = {}

    @property
    def name(self) -> str:
        return "Deft"

    async def connect(self) -> bool:
        if not validate_config(self.config):
            self._set_fatal_error(
                "config_missing",
                "DEFT_CHANNEL_URL, DEFT_CHANNEL_TOKEN, and DEFT_EMPLOYEE_SLUG are required",
                retryable=False,
            )
            return False
        try:
            response = await self._request(
                "GET",
                "/connect",
                query=self._compatibility_query(),
            )
        except Exception as exc:
            self._set_fatal_error("connect_failed", str(exc), retryable=True)
            return False
        if response.get("adapter_mode") != "autonomous_platform":
            self._set_fatal_error(
                "incompatible_channel",
                "Deft did not negotiate autonomous_platform adapter mode",
                retryable=False,
            )
            return False
        self._mark_connected()
        if self._start_listener:
            self._poll_task = asyncio.create_task(self._poll_loop())
        return True

    async def disconnect(self) -> None:
        task = self._poll_task
        self._poll_task = None
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._mark_disconnected()

    def set_delivery_handler(self, handler: Optional[DeliveryHandler]) -> None:
        """Install the narrow event-acceptance seam used by the native mapper."""
        self._delivery_handler = handler

    def _compatibility_query(self) -> dict:
        return {
            "protocol_version": PROTOCOL_VERSION,
            "adapter_version": ADAPTER_VERSION,
            "capabilities": CAPABILITY,
            "worker_id": self.worker_id,
            "caller_employee_slug": self.employee_slug,
        }

    async def _request(
        self,
        method: str,
        path: str,
        *,
        query: Optional[dict] = None,
        body: Optional[dict] = None,
    ) -> dict:
        return await self._request_fn(method, path, query, body)

    async def _http_request(
        self,
        method: str,
        path: str,
        query: Optional[dict],
        body: Optional[dict],
    ) -> dict:
        def perform() -> dict:
            url = f"{self.channel_url}{path}"
            if query:
                url = f"{url}?{urllib.parse.urlencode(query)}"
            payload = json.dumps(body).encode("utf-8") if body is not None else None
            request = urllib.request.Request(
                url,
                data=payload,
                method=method,
                headers={
                    "Authorization": f"Bearer {self.token}",
                    "Accept": "application/json",
                    **({"Content-Type": "application/json"} if payload is not None else {}),
                },
            )
            try:
                with urllib.request.urlopen(request, timeout=30) as response:
                    return json.loads(response.read().decode("utf-8"))
            except urllib.error.HTTPError as exc:
                detail = exc.read().decode("utf-8", errors="replace")[:2000]
                raise RuntimeError(f"Deft channel HTTP {exc.code}: {detail}") from exc

        return await asyncio.to_thread(perform)

    async def _poll_once(self) -> int:
        response = await self._request(
            "GET",
            "/events",
            query={
                **self._compatibility_query(),
                "limit": 1,
                "lease_ms": 30000,
                **({"cursor": self._last_accepted_event_id} if self._last_accepted_event_id else {}),
            },
        )
        events = response.get("events") if isinstance(response, dict) else None
        if not isinstance(events, list):
            raise RuntimeError("Deft channel returned an invalid events payload")
        accepted_count = 0
        for event in events:
            if not isinstance(event, dict) or not event.get("id") or not event.get("claim_token"):
                raise RuntimeError("Deft channel returned an event without an identity or claim")
            message_event = None
            if self._delivery_handler is not None:
                accepted_by_hermes = await self._delivery_handler(event)
                if not accepted_by_hermes:
                    break
            else:
                if self._message_handler is None:
                    break
                message_event = self._to_message_event(event)
            accepted = await self._request(
                "POST",
                "/accept",
                body={
                    "event_id": event["id"],
                    "claim_token": event["claim_token"],
                    "caller_employee_slug": self.employee_slug,
                },
            )
            if accepted.get("transport_state") != "accepted":
                raise RuntimeError("Deft did not confirm transport acceptance")
            self._last_accepted_event_id = str(event["id"])
            accepted_count += 1
            if message_event is not None:
                await self.handle_message(message_event)
        return accepted_count

    def _to_message_event(self, event: dict) -> MessageEvent:
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        org_id = str(event.get("org_id") or "")
        if event.get("kind") == "task.assigned":
            task_id = str(payload.get("task_id") or event.get("source_id") or event["id"])
            task_key = str(payload.get("task_key") or task_id)
            title = str(payload.get("title") or "Untitled task")
            description = str(payload.get("description") or "").strip()
            status = str(payload.get("status") or "todo")
            priority = str(payload.get("priority") or "")
            lines = [
                "A Deft task was assigned to you.",
                f"Task: {task_key}",
                f"Task ID: {task_id}",
                f"Title: {title}",
                f"Status: {status}",
            ]
            if priority:
                lines.append(f"Priority: {priority}")
            if description:
                lines.extend(["Description:", description])
            chat_id = f"{org_id}:tasks"
            source = self.build_source(
                chat_id=chat_id,
                chat_name="Deft tasks",
                chat_type="channel",
                user_id=str(payload.get("assigned_by") or event.get("actor_user_id") or "") or None,
                user_name=str(payload.get("assigned_by_name") or "") or None,
                thread_id=task_id,
                guild_id=org_id or None,
                parent_chat_id="tasks",
                message_id=task_id,
            )
            route = {
                "event_id": str(event["id"]),
                "source_kind": "task",
                "task_id": task_id,
                "space_id": "",
                "thread_id": task_id,
                "source_message_id": task_id,
            }
            self._routes_by_message[task_id] = route
            self._routes_by_scope[(chat_id, task_id)] = route
            return MessageEvent(
                text="\n".join(lines),
                message_type=MessageType.TEXT,
                source=source,
                raw_message=event,
                message_id=task_id,
            )

        space_id = str(event.get("space_id") or payload.get("space_id") or "")
        source_message_id = str(event.get("source_id") or payload.get("message_id") or event["id"])
        reply_thread_id = event.get("thread_id") or payload.get("reply_thread_id")
        thread_id = str(reply_thread_id) if reply_thread_id else None
        chat_id = f"{org_id}:{space_id}"
        is_dm = payload.get("is_dm") is True
        source = self.build_source(
            chat_id=chat_id,
            chat_name=str(payload.get("space_name") or space_id),
            chat_type="dm" if is_dm else "channel",
            user_id=str(payload.get("author_id") or event.get("actor_user_id") or "") or None,
            user_name=str(payload.get("author_name") or "") or None,
            thread_id=thread_id,
            guild_id=org_id or None,
            parent_chat_id=space_id or None,
            message_id=source_message_id,
        )
        route = {
            "event_id": str(event["id"]),
            "source_kind": "message",
            "space_id": space_id,
            "thread_id": thread_id,
            "source_message_id": source_message_id,
        }
        self._routes_by_message[source_message_id] = route
        self._routes_by_scope[(chat_id, thread_id or "")] = route
        return MessageEvent(
            text=str(payload.get("content") or ""),
            message_type=MessageType.TEXT,
            source=source,
            raw_message=event,
            message_id=source_message_id,
            reply_to_message_id=str(payload.get("parent_id")) if payload.get("parent_id") else None,
        )

    async def _deliver_to_hermes(self, event: dict) -> bool:
        if self._message_handler is None:
            return False
        message_event = self._to_message_event(event)
        await self.handle_message(message_event)
        return True

    async def _poll_loop(self) -> None:
        while self._running:
            try:
                await self._poll_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                await asyncio.sleep(min(self.poll_ms / 1000, 5.0))
                continue
            await asyncio.sleep(self.poll_ms / 1000)

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> SendResult:
        thread_id = str((metadata or {}).get("thread_id") or "")
        route = self._routes_by_message.get(str(reply_to or ""))
        if route is None:
            route = self._routes_by_scope.get((chat_id, thread_id))
        if route is None and not thread_id:
            candidates = [value for (scope, _), value in self._routes_by_scope.items() if scope == chat_id]
            route = candidates[-1] if candidates else None
        if route is None:
            return SendResult(success=False, error="No accepted Deft source event is available for this reply")

        digest = hashlib.sha256(content.encode("utf-8")).hexdigest()[:24]
        idempotency_key = f"autonomous-reply:{route['event_id']}:{digest}"
        try:
            response = await self._request(
                "POST",
                "/reply",
                body={
                    "event_id": route["event_id"],
                    "content": content,
                    "thread_id": route["thread_id"],
                    "idempotency_key": idempotency_key,
                    "adapter_mode": "autonomous_platform",
                    "caller_employee_slug": self.employee_slug,
                },
            )
        except Exception as exc:
            return SendResult(success=False, error=str(exc), retryable=True)
        if not response.get("ok"):
            return SendResult(success=False, error="Deft rejected the autonomous reply")
        result = response.get("result") if isinstance(response.get("result"), dict) else {}
        message_id = (
            result.get("comment_id")
            if route.get("source_kind") == "task"
            else result.get("id") or result.get("message_id")
        )
        return SendResult(success=True, message_id=str(message_id) if message_id else None, raw_response=response)

    async def get_chat_info(self, chat_id: str) -> Dict[str, Any]:
        return {"name": chat_id, "type": "channel", "chat_id": chat_id}


def register(ctx: Any) -> None:
    """Hermes plugin entry point."""
    ctx.register_platform(
        name=PLATFORM_NAME,
        label="Deft",
        adapter_factory=lambda cfg: DeftAdapter(cfg),
        check_fn=check_requirements,
        validate_config=validate_config,
        is_connected=is_connected,
        required_env=["DEFT_CHANNEL_URL", "DEFT_CHANNEL_TOKEN", "DEFT_EMPLOYEE_SLUG"],
        install_hint="No extra package is required.",
        env_enablement_fn=_env_enablement,
        emoji="🏢",
        pii_safe=True,
        allow_update_command=True,
        platform_hint=(
            "You are working in Deft. Reply to the current workplace conversation. "
            "Use employee-scoped Deft MCP for workspace reads and writes."
        ),
    )
