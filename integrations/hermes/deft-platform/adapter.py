"""Native Deft messaging adapter for Hermes.

This third-party plugin intentionally owns only the messaging transport. It
does not call a Hermes model endpoint, construct prompts, parse model output,
or supervise the agent's reasoning lifecycle.
"""

from __future__ import annotations

import os
from typing import Any, Dict, Optional

from gateway.config import Platform, PlatformConfig
from gateway.platforms.base import BasePlatformAdapter, SendResult


PLATFORM_NAME = "deft"
ADAPTER_VERSION = "0.1.0"
CAPABILITY = "autonomous_platform_adapter_v1"


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
    """Minimal loadable adapter; network delivery is added in Loop 2."""

    def __init__(self, config: PlatformConfig):
        super().__init__(config=config, platform=Platform(PLATFORM_NAME))
        self.channel_url = _configured_value(config, "channel_url", "DEFT_CHANNEL_URL").rstrip("/")
        self.token = _configured_value(config, "token", "DEFT_CHANNEL_TOKEN")
        self.employee_slug = _configured_value(config, "employee_slug", "DEFT_EMPLOYEE_SLUG")

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
        self._mark_connected()
        return True

    async def disconnect(self) -> None:
        self._mark_disconnected()

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

