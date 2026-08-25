"""Native Deft messaging adapter for Hermes.

This third-party plugin intentionally owns only the messaging transport. It
does not call a Hermes model endpoint, construct prompts, parse model output,
or supervise the agent's reasoning lifecycle.
"""

from __future__ import annotations

import os
import asyncio
import json
import socket
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Awaitable, Callable, Dict, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult


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
            if self._delivery_handler is None:
                break
            accepted_by_hermes = await self._delivery_handler(event)
            if not accepted_by_hermes:
                break
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
        return accepted_count

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
        return SendResult(success=False, error="Deft outbound delivery is not implemented before Loop 3")

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
