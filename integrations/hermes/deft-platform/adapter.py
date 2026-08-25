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
import pathlib
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Awaitable, Callable, Dict, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import (
    BasePlatformAdapter,
    MessageEvent,
    MessageType,
    ProcessingOutcome,
    SendResult,
)


PLATFORM_NAME = "deft"
ADAPTER_VERSION = "0.1.0"
CAPABILITY = "autonomous_platform_adapter_v1"
PROTOCOL_VERSION = "deft.agent_channel.v2"
MAX_RECENT_ROUTES = 200

RequestFn = Callable[[str, str, Optional[dict], Optional[dict]], Awaitable[dict]]


class DeftChannelRequestError(RuntimeError):
    def __init__(self, message: str, *, status: int, code: str, retryable: bool):
        super().__init__(message)
        self.status = status
        self.code = code
        self.retryable = retryable


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
        self._start_listener = start_listener
        self._poll_task: Optional[asyncio.Task] = None
        default_state_path = pathlib.Path(os.getenv("HERMES_HOME", "~/.hermes")).expanduser() / "deft-platform-state.json"
        self._state_path = pathlib.Path(str(extra.get("state_path") or default_state_path)).expanduser()
        self._state_error: Optional[str] = None
        self._last_accepted_event_id: Optional[str] = None
        self._pending_events: Dict[str, dict] = {}
        self._inflight_event_ids: set[str] = set()
        self._routes_by_message: Dict[str, dict] = {}
        self._routes_by_scope: Dict[tuple[str, str], dict] = {}
        self._load_state()

    @property
    def name(self) -> str:
        return "Deft"

    @property
    def authorization_is_upstream(self) -> bool:
        """Trust Deft's authenticated, tenant-scoped event authorization."""
        return True

    async def connect(self, *, is_reconnect: bool = False) -> bool:
        if self._state_error:
            self._set_fatal_error("state_invalid", self._state_error, retryable=False)
            return False
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

    def _load_state(self) -> None:
        if not self._state_path.exists():
            return
        try:
            raw = json.loads(self._state_path.read_text(encoding="utf-8"))
            if raw.get("version") != 1:
                raise ValueError("unsupported state version")
            cursor = raw.get("last_accepted_event_id")
            if cursor is not None and not isinstance(cursor, str):
                raise ValueError("cursor must be a string or null")
            pending = raw.get("pending_events") or []
            if not isinstance(pending, list):
                raise ValueError("pending_events must be a list")
            parsed: Dict[str, dict] = {}
            for item in pending:
                if not isinstance(item, dict) or not isinstance(item.get("event"), dict):
                    raise ValueError("pending event entry is invalid")
                event_id = str(item["event"].get("id") or "")
                if not event_id or event_id in parsed:
                    raise ValueError("pending event identity is missing or duplicated")
                parsed[event_id] = item
            self._last_accepted_event_id = cursor
            self._pending_events = parsed
        except Exception as exc:
            self._state_error = f"Deft platform state is invalid: {exc}"

    def _save_state(self) -> None:
        self._state_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "version": 1,
            "last_accepted_event_id": self._last_accepted_event_id,
            "pending_events": list(self._pending_events.values()),
        }
        temp_path = self._state_path.with_name(f"{self._state_path.name}.tmp.{os.getpid()}")
        temp_path.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        try:
            os.chmod(temp_path, 0o600)
        except OSError:
            pass
        os.replace(temp_path, self._state_path)

    def _remember_pending(self, event: dict) -> None:
        self._pending_events[str(event["id"])] = {
            "event": json.loads(json.dumps(event)),
            "transport_accepted": False,
        }
        self._save_state()

    def _mark_pending_accepted(self, event_id: str) -> None:
        pending = self._pending_events[event_id]
        pending["transport_accepted"] = True
        pending["event"].pop("claim_token", None)
        pending["event"].pop("claim_owner", None)
        pending["event"].pop("lease_expires_at", None)
        self._last_accepted_event_id = event_id
        self._save_state()

    def _complete_pending(self, route: dict) -> None:
        event_id = str(route["event_id"])
        self._pending_events.pop(event_id, None)
        self._inflight_event_ids.discard(event_id)
        self._save_state()

    def _remember_route(
        self,
        message_id: str,
        chat_id: str,
        thread_id: str,
        route: dict,
    ) -> None:
        self._routes_by_message[message_id] = route
        self._routes_by_scope[(chat_id, thread_id)] = route
        while len(self._routes_by_message) > MAX_RECENT_ROUTES:
            self._routes_by_message.pop(next(iter(self._routes_by_message)))
        while len(self._routes_by_scope) > MAX_RECENT_ROUTES:
            self._routes_by_scope.pop(next(iter(self._routes_by_scope)))

    async def _resume_pending(self) -> int:
        if self._message_handler is None:
            return 0
        resumed = 0
        for event_id, pending in list(self._pending_events.items()):
            if event_id in self._inflight_event_ids:
                continue
            event = pending["event"]
            if not pending.get("transport_accepted"):
                claim_token = event.get("claim_token")
                if not claim_token:
                    raise RuntimeError(f"Pending Deft event {event_id} has no acceptance claim")
                accepted = await self._request(
                    "POST",
                    "/accept",
                    body={
                        "event_id": event_id,
                        "claim_token": claim_token,
                        "caller_employee_slug": self.employee_slug,
                    },
                )
                if accepted.get("transport_state") != "accepted":
                    raise RuntimeError(f"Deft did not reconcile transport acceptance for {event_id}")
                self._mark_pending_accepted(event_id)
            message_event = self._to_message_event(event)
            self._inflight_event_ids.add(event_id)
            try:
                await self.handle_message(message_event)
            except Exception:
                self._inflight_event_ids.discard(event_id)
                raise
            resumed += 1
        return resumed

    async def disconnect(self) -> None:
        task = self._poll_task
        self._poll_task = None
        if task:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
        try:
            await self._request(
                "POST",
                "/status",
                body={
                    "state": "offline",
                    "worker_id": self.worker_id,
                    "caller_employee_slug": self.employee_slug,
                },
            )
        except Exception:
            pass
        self._mark_disconnected()

    async def on_processing_complete(
        self,
        event: MessageEvent,
        outcome: ProcessingOutcome,
    ) -> None:
        await super().on_processing_complete(event, outcome)
        if outcome == ProcessingOutcome.CANCELLED:
            return
        route = self._routes_by_message.get(str(event.message_id or ""))
        if route is not None:
            self._complete_pending(route)

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
                try:
                    parsed = json.loads(detail)
                    error_code = str(parsed.get("code") or "HTTP_ERROR")
                    message = str(parsed.get("error") or detail)
                except Exception:
                    error_code = "HTTP_ERROR"
                    message = detail
                retryable = exc.code in {408, 425, 429} or exc.code >= 500
                raise DeftChannelRequestError(
                    f"Deft channel HTTP {exc.code} {error_code}: {message}",
                    status=exc.code,
                    code=error_code,
                    retryable=retryable,
                ) from exc

        return await asyncio.to_thread(perform)

    async def _poll_once(self) -> int:
        accepted_count = await self._resume_pending()
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
        for event in events:
            if not isinstance(event, dict) or not event.get("id") or not event.get("claim_token"):
                raise RuntimeError("Deft channel returned an event without an identity or claim")
            if self._message_handler is None:
                break
            message_event = self._to_message_event(event)
            self._remember_pending(event)
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
            event_id = str(event["id"])
            self._last_accepted_event_id = event_id
            self._mark_pending_accepted(event_id)
            self._inflight_event_ids.add(event_id)
            accepted_count += 1
            try:
                await self.handle_message(message_event)
            except Exception:
                self._inflight_event_ids.discard(event_id)
                raise
        return accepted_count

    def _to_message_event(self, event: dict) -> MessageEvent:
        payload = event.get("payload") if isinstance(event.get("payload"), dict) else {}
        org_id = str(event.get("org_id") or "")
        event_kind = str(event.get("kind") or "")
        if event_kind.startswith("task.") or (
            event_kind == "approval.resolved" and event.get("source_kind") == "task"
        ):
            task_id = str(payload.get("task_id") or event.get("source_id") or event["id"])
            task_key = str(payload.get("task_key") or task_id)
            title = str(payload.get("title") or "Untitled task")
            description = str(payload.get("description") or "").strip()
            status = str(payload.get("status") or "todo")
            priority = str(payload.get("priority") or "")
            if event_kind == "task.commented":
                speaker = str(payload.get("commenter_name") or payload.get("actor_name") or "A teammate")
                lines = [
                    f"{speaker} commented on your Deft task.",
                    f"Task: {task_key}",
                    f"Task ID: {task_id}",
                    "Comment:",
                    str(payload.get("content") or ""),
                ]
            elif event_kind == "task.status_changed":
                old_status = str(payload.get("old_status") or "unknown")
                new_status = str(payload.get("new_status") or status)
                lines = [
                    "A teammate changed the status of your Deft task.",
                    f"Task: {task_key}",
                    f"Task ID: {task_id}",
                    f"Status: {old_status} -> {new_status}",
                ]
                if new_status == "cancelled":
                    lines.append("The task was cancelled. Stop work and do not make further changes for it.")
            elif event_kind == "approval.resolved":
                decision = str(payload.get("decision") or "resolved")
                lines = [
                    f"A Deft approval for this task was {decision}.",
                    f"Task: {task_key}",
                    f"Task ID: {task_id}",
                    f"Action: {payload.get('action') or 'unknown'}",
                    f"Execution: {payload.get('execution_status') or 'unknown'}",
                ]
                if payload.get("summary"):
                    lines.append(f"Request: {payload['summary']}")
                if payload.get("reason"):
                    lines.append(f"Reason: {payload['reason']}")
            else:
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
            event_message_id = str(event["id"])
            source = self.build_source(
                chat_id=chat_id,
                chat_name="Deft tasks",
                chat_type="channel",
                user_id=str(
                    payload.get("commenter_id")
                    or payload.get("actor_user_id")
                    or payload.get("assigned_by")
                    or event.get("actor_user_id")
                    or ""
                ) or None,
                user_name=str(
                    payload.get("commenter_name")
                    or payload.get("actor_name")
                    or payload.get("assigned_by_name")
                    or ""
                ) or None,
                thread_id=task_id,
                guild_id=org_id or None,
                parent_chat_id="tasks",
                message_id=event_message_id,
            )
            route = {
                "event_id": str(event["id"]),
                "source_kind": "task",
                "task_id": task_id,
                "space_id": "",
                "thread_id": task_id,
                "source_message_id": event_message_id,
            }
            self._remember_route(event_message_id, chat_id, task_id, route)
            return MessageEvent(
                text="\n".join(lines),
                message_type=MessageType.TEXT,
                source=source,
                raw_message=event,
                message_id=event_message_id,
            )

        if event_kind == "approval.resolved":
            action_id = str(payload.get("action_id") or event.get("source_id") or event["id"])
            decision = str(payload.get("decision") or "resolved")
            lines = [
                f"A Deft approval was {decision}.",
                f"Approval ID: {action_id}",
                f"Action: {payload.get('action') or 'unknown'}",
                f"Execution: {payload.get('execution_status') or 'unknown'}",
            ]
            if payload.get("summary"):
                lines.append(f"Request: {payload['summary']}")
            if payload.get("reason"):
                lines.append(f"Reason: {payload['reason']}")
            space_id = str(event.get("space_id") or "")
            event_message_id = str(event["id"])
            thread_id = str(event.get("thread_id") or "") or action_id
            chat_id = f"{org_id}:{space_id or 'approvals'}"
            source = self.build_source(
                chat_id=chat_id,
                chat_name="Deft approvals",
                chat_type="channel",
                user_id=str(event.get("actor_user_id") or "") or None,
                thread_id=thread_id,
                guild_id=org_id or None,
                parent_chat_id=space_id or "approvals",
                message_id=event_message_id,
            )
            route = {
                "event_id": event_message_id,
                "source_kind": "message" if space_id else "notification",
                "space_id": space_id,
                "thread_id": thread_id,
                "source_message_id": event_message_id,
            }
            self._remember_route(event_message_id, chat_id, thread_id, route)
            return MessageEvent(
                text="\n".join(lines),
                message_type=MessageType.TEXT,
                source=source,
                raw_message=event,
                message_id=event_message_id,
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
        self._remember_route(source_message_id, chat_id, thread_id or "", route)
        return MessageEvent(
            text=str(payload.get("content") or ""),
            message_type=MessageType.TEXT,
            source=source,
            raw_message=event,
            message_id=source_message_id,
            reply_to_message_id=str(payload.get("parent_id")) if payload.get("parent_id") else None,
        )

    async def _poll_loop(self) -> None:
        consecutive_failures = 0
        while self._running:
            try:
                await self._poll_once()
                consecutive_failures = 0
            except asyncio.CancelledError:
                raise
            except DeftChannelRequestError as exc:
                consecutive_failures += 1
                if not exc.retryable or consecutive_failures >= 5:
                    self._set_fatal_error(exc.code.lower(), str(exc), retryable=exc.retryable)
                    break
                await asyncio.sleep(min(2 ** (consecutive_failures - 1), 30))
                continue
            except Exception as exc:
                consecutive_failures += 1
                if consecutive_failures >= 5:
                    self._set_fatal_error("channel_unavailable", str(exc), retryable=True)
                    break
                await asyncio.sleep(min(2 ** (consecutive_failures - 1), 30))
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

        # Hermes labels tool-boundary commentary as interim transport output.
        # It is useful in a live chat stream, but mapping every preamble to a
        # durable task comment floods the task and obscures the actual work
        # report written through Deft MCP. Keep the delivery successful so the
        # autonomous runtime can continue, and persist only its final reply.
        if route.get("source_kind") == "task" and (metadata or {}).get("_interim_send") is True:
            return SendResult(success=True, raw_response={"interim_suppressed": True})

        content_digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
        idempotency_key = f"autonomous-reply:{route['event_id']}:{content_digest}"
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
        except DeftChannelRequestError as exc:
            return SendResult(success=False, error=str(exc), retryable=exc.retryable)
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
