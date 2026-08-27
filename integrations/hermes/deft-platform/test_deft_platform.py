import asyncio
import atexit
import hashlib
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import types
import unittest
import uuid
from unittest.mock import patch


PLUGIN_DIR = pathlib.Path(__file__).parent
PACKAGE_NAME = "deft_platform_plugin"
PACKAGE = types.ModuleType(PACKAGE_NAME)
PACKAGE.__path__ = [str(PLUGIN_DIR)]
sys.modules[PACKAGE_NAME] = PACKAGE
SPEC = importlib.util.spec_from_file_location(
    f"{PACKAGE_NAME}.adapter",
    PLUGIN_DIR / "adapter.py",
)
MOD = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MOD
SPEC.loader.exec_module(MOD)
READINESS_SPEC = importlib.util.spec_from_file_location(
    f"{PACKAGE_NAME}.readiness",
    PLUGIN_DIR / "readiness.py",
)
READINESS = importlib.util.module_from_spec(READINESS_SPEC)
sys.modules[READINESS_SPEC.name] = READINESS
READINESS_SPEC.loader.exec_module(READINESS)
TEST_STATE_DIR = tempfile.TemporaryDirectory()
atexit.register(TEST_STATE_DIR.cleanup)


class FakeContext:
    def __init__(self):
        self.registration = None

    def register_platform(self, **kwargs):
        self.registration = kwargs


class FakeConfig:
    def __init__(self, extra=None):
        self.extra = dict(extra or {})
        self.extra.setdefault(
            "state_path",
            str(pathlib.Path(TEST_STATE_DIR.name) / f"state-{uuid.uuid4()}.json"),
        )


class DeftPlatformSkeletonTests(unittest.TestCase):
    def test_readiness_treats_contained_compatibility_outcome_as_failure(self):
        with patch.object(READINESS, "_rpc", return_value={
            "content": [{"type": "text", "text": "DEFT_TOOL_FAILED: denied"}],
            "structuredContent": {
                "schema": "deft.tool_outcome.v1",
                "deft_status": "failed",
            },
        }):
            with self.assertRaisesRegex(RuntimeError, "rejected the readiness probe"):
                READINESS._tool_call("https://deft.example/api/mcp/hermes/v1", "token", "ping_alive", {})

    def test_stock_hermes_keeps_contained_deft_failures_off_the_server_breaker(self):
        from tools import mcp_tool

        server_name = f"deft-compat-{uuid.uuid4().hex}"

        class ContentBlock:
            type = "text"
            text = "DEFT_TOOL_FAILED: task_update requires task_id"

        class Result:
            content = [ContentBlock()]
            isError = False
            structuredContent = {
                "schema": "deft.tool_outcome.v1",
                "deft_status": "failed",
                "code": "DEFT_TOOL_FAILED",
                "retryable": False,
                "outcome_confirmed": False,
            }
            meta = None

        async def call_tool(_name, arguments=None):
            return Result()

        session = types.SimpleNamespace(call_tool=call_tool)
        server = types.SimpleNamespace(session=session, _rpc_lock=None)

        def run_on_loop(coro_or_factory, timeout=30):
            coroutine = coro_or_factory() if callable(coro_or_factory) else coro_or_factory
            loop = asyncio.new_event_loop()
            try:
                async def execute():
                    server._rpc_lock = asyncio.Lock()
                    return await coroutine

                return loop.run_until_complete(execute())
            finally:
                loop.close()

        try:
            with patch.dict(mcp_tool._servers, {server_name: server}), patch.object(
                mcp_tool,
                "_run_on_mcp_loop",
                side_effect=run_on_loop,
            ):
                mcp_tool._server_error_counts.pop(server_name, None)
                handler = mcp_tool._make_tool_handler(server_name, "task_update", 30.0)
                for _ in range(mcp_tool._CIRCUIT_BREAKER_THRESHOLD + 2):
                    payload = json.loads(handler({}))
                    self.assertNotIn("error", payload)
                    self.assertEqual(payload["structuredContent"]["deft_status"], "failed")
                self.assertEqual(mcp_tool._server_error_counts.get(server_name, 0), 0)
        finally:
            mcp_tool._servers.pop(server_name, None)
            mcp_tool._server_error_counts.pop(server_name, None)
            if hasattr(mcp_tool, "_server_breaker_opened_at"):
                mcp_tool._server_breaker_opened_at.pop(server_name, None)

    def test_registers_as_third_party_platform(self):
        context = FakeContext()
        MOD.register(context)
        self.assertEqual(context.registration["name"], "deft")
        self.assertTrue(context.registration["check_fn"]())
        self.assertIn("DEFT_CHANNEL_TOKEN", context.registration["required_env"])

    def test_env_enablement_requires_employee_bound_configuration(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(MOD._env_enablement())
        with patch.dict(os.environ, {
            "DEFT_CHANNEL_URL": "https://demo.deft.ing/api/agent-channel/",
            "DEFT_CHANNEL_TOKEN": "secret-test-token",
            "DEFT_EMPLOYEE_SLUG": "native-spike",
        }, clear=True):
            enabled = MOD._env_enablement()
        self.assertEqual(enabled["channel_url"], "https://demo.deft.ing/api/agent-channel")
        self.assertEqual(enabled["employee_slug"], "native-spike")

    def test_worker_identity_rotates_only_between_gateway_processes(self):
        config = FakeConfig({
            "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
            "token": "secret-test-token",
            "employee_slug": "worker-identity-spike",
            "worker_id": "operator-worker-label",
        })
        first = MOD.DeftAdapter(config, start_listener=False)
        second = MOD.DeftAdapter(config, start_listener=False)

        self.assertEqual(first.worker_id, second.worker_id)
        self.assertTrue(first.worker_id.startswith("operator-worker-label-"))
        self.assertEqual(first._compatibility_query()["worker_id"], first.worker_id)
        reload_package_name = f"deft_platform_reload_{uuid.uuid4().hex}"
        reload_package = types.ModuleType(reload_package_name)
        reload_package.__path__ = [str(PLUGIN_DIR)]
        sys.modules[reload_package_name] = reload_package
        reload_spec = importlib.util.spec_from_file_location(
            f"{reload_package_name}.adapter",
            PLUGIN_DIR / "adapter.py",
        )
        reloaded_module = importlib.util.module_from_spec(reload_spec)
        sys.modules[reload_spec.name] = reloaded_module
        try:
            reload_spec.loader.exec_module(reloaded_module)
            reloaded = reloaded_module.DeftAdapter(
                FakeConfig({
                    "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                    "token": "secret-test-token",
                    "employee_slug": "worker-identity-spike",
                    "worker_id": "changed-label-same-process",
                }),
                start_listener=False,
            )
            self.assertEqual(first.worker_id, reloaded.worker_id)
            self.assertEqual(MOD.PROCESS_BOOT_ID, reloaded_module.PROCESS_BOOT_ID)
        finally:
            sys.modules.pop(reload_spec.name, None)
            sys.modules.pop(reload_package_name, None)
        child_script = """
import importlib.util
import pathlib
import sys
import types

plugin_dir = pathlib.Path(sys.argv[1])
package_name = "deft_platform_subprocess"
package = types.ModuleType(package_name)
package.__path__ = [str(plugin_dir)]
sys.modules[package_name] = package
spec = importlib.util.spec_from_file_location(
    f"{package_name}.adapter",
    plugin_dir / "adapter.py",
)
module = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = module
spec.loader.exec_module(module)
print(module.PROCESS_BOOT_ID)
"""
        child_boot_id = subprocess.check_output(
            [sys.executable, "-c", child_script, str(PLUGIN_DIR)],
            text=True,
        ).strip()
        self.assertNotEqual(MOD.PROCESS_BOOT_ID, child_boot_id)

    def test_certification_final_requires_current_anchor_and_notify_marker(self):
        calls = []

        async def request(method, path, query, body):
            calls.append((method, path, query, body))
            return {
                "ok": True,
                "transport_reply": "sent",
                "result": {"message_id": "certification-message-2"},
            }

        adapter = MOD.DeftAdapter(
            FakeConfig({
                "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                "token": "secret-test-token",
                "employee_slug": "native-spike",
            }),
            request_fn=request,
            start_listener=False,
        )
        old_event = {
            "id": "certification-route-1",
            "kind": "certification.challenge",
            "source_kind": "certification",
            "source_id": "challenge-route-1",
            "org_id": "org-1",
            "space_id": "shared-certification-space",
            "payload": {"certification_prompt": "First proof"},
        }
        new_event = {
            **old_event,
            "id": "certification-route-2",
            "source_id": "challenge-route-2",
            "payload": {"certification_prompt": "Second proof"},
        }
        old_message = adapter._to_message_event(old_event)
        adapter._forget_routes(old_event["id"])
        new_message = adapter._to_message_event(new_event)

        stale = asyncio.run(adapter.send(
            old_message.source.chat_id,
            "Late final from the first certification",
            reply_to=old_event["id"],
            metadata={"notify": True},
        ))
        self.assertFalse(stale.success)
        self.assertEqual(calls, [])
        self.assertIn(new_event["id"], adapter._routes_by_message)

        nonfinal = asyncio.run(adapter.send(
            new_message.source.chat_id,
            "Anchored commentary without final delivery",
            reply_to=new_event["id"],
            metadata={},
        ))
        self.assertTrue(nonfinal.success)
        self.assertEqual(calls, [])
        self.assertIn(new_event["id"], adapter._routes_by_message)

        final = asyncio.run(adapter.send(
            new_message.source.chat_id,
            "Current final certification reply",
            reply_to=new_event["id"],
            metadata={"notify": True},
        ))
        self.assertTrue(final.success)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][3]["event_id"], new_event["id"])
        self.assertNotIn(new_event["id"], adapter._routes_by_message)

    def test_corrupt_transport_state_fails_before_connecting(self):
        calls = []
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = pathlib.Path(temp_dir) / "state.json"
            state_path.write_text("{not-json", encoding="utf-8")
            adapter = MOD.DeftAdapter(
                FakeConfig({
                    "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                    "token": "secret-test-token",
                    "employee_slug": "native-spike",
                    "state_path": str(state_path),
                }),
                request_fn=lambda *args: calls.append(args),
                start_listener=False,
            )
            self.assertFalse(asyncio.run(adapter.connect()))
        self.assertEqual(calls, [])

    def test_transport_state_is_bound_to_endpoint_and_employee_before_recovery(self):
        calls = []

        async def request(method, path, query, body):
            calls.append((method, path, query, body))
            return {"ok": True, "adapter_mode": "autonomous_platform"}

        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = pathlib.Path(temp_dir) / "state.json"
            original = MOD.DeftAdapter(
                FakeConfig({
                    "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                    "token": "original-token",
                    "employee_slug": "first-employee",
                    "state_path": str(state_path),
                }),
                request_fn=request,
                start_listener=False,
            )
            original.set_owner_profile("alpha")
            original._pending_events["accepted-event-1"] = {
                "event_id": "accepted-event-1",
                "transport_accepted": True,
            }
            original._last_accepted_event_id = "accepted-event-1"
            original._save_state()
            calls.clear()

            mismatch_cases = (
                ("https://other.deft.ing/api/agent-channel/v1", "first-employee", "alpha"),
                ("https://demo.deft.ing/api/agent-channel/v1", "second-employee", "alpha"),
                ("https://demo.deft.ing/api/agent-channel/v1", "first-employee", "beta"),
            )
            for endpoint, employee_slug, profile in mismatch_cases:
                with self.subTest(endpoint=endpoint, employee_slug=employee_slug, profile=profile):
                    rotated = MOD.DeftAdapter(
                        FakeConfig({
                            "channel_url": endpoint,
                            "token": "rotated-token",
                            "employee_slug": employee_slug,
                            "state_path": str(state_path),
                        }),
                        request_fn=request,
                        start_listener=False,
                    )
                    rotated.set_owner_profile(profile)
                    self.assertFalse(asyncio.run(rotated.connect()))
                    self.assertEqual(calls, [])
                    self.assertIn(
                        "different Deft endpoint, employee, or owner profile",
                        rotated._state_error or "",
                    )

            token_rotation = MOD.DeftAdapter(
                FakeConfig({
                    "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                    "token": "rotated-token",
                    "employee_slug": "first-employee",
                    "state_path": str(state_path),
                }),
                request_fn=request,
                start_listener=False,
            )
            token_rotation.set_owner_profile("alpha")
            self.assertTrue(asyncio.run(token_rotation.connect()))
            self.assertEqual([call[1] for call in calls], ["/connect"])
            persisted = state_path.read_text(encoding="utf-8")
            self.assertNotIn("first-employee", persisted)
            self.assertNotIn("demo.deft.ing", persisted)
            self.assertNotIn("original-token", persisted)

    def test_standalone_active_profile_owns_its_journal_without_changing_session_namespace(self):
        async def request(method, path, query, body):
            return {"ok": True, "adapter_mode": "autonomous_platform"}

        with tempfile.TemporaryDirectory() as temp_dir, patch(
            "hermes_cli.profiles.get_active_profile_name",
            return_value="alpha",
        ), patch.dict(os.environ, {"HERMES_HOME": temp_dir}):
            config = FakeConfig({
                "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                "token": "secret-test-token",
                "employee_slug": "native-spike",
            })
            config.extra.pop("state_path", None)
            adapter = MOD.DeftAdapter(config, request_fn=request, start_listener=False)
            self.assertIsNone(adapter._session_key_profile())
            self.assertTrue(asyncio.run(adapter.connect()))
            expected_digest = hashlib.sha256(b"alpha").hexdigest()[:16]
            self.assertEqual(
                adapter._state_path,
                pathlib.Path(temp_dir) / f"deft-platform-state-{expected_digest}.json",
            )
            state = json.loads(adapter._state_path.read_text(encoding="utf-8"))
            self.assertEqual(
                state["binding_sha256"],
                MOD._journal_binding(
                    "https://demo.deft.ing/api/agent-channel/v1",
                    "native-spike",
                    "alpha",
                ),
            )

    def test_initial_explicit_state_path_is_reserved_by_one_owner_profile(self):
        calls = []

        async def request(method, path, query, body):
            calls.append((method, path, query, body))
            return {"ok": True, "adapter_mode": "autonomous_platform"}

        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = pathlib.Path(temp_dir) / "shared-state.json"
            config = {
                "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                "token": "secret-test-token",
                "employee_slug": "native-spike",
                "state_path": str(state_path),
            }
            alpha = MOD.DeftAdapter(
                FakeConfig(config), request_fn=request, start_listener=False,
            )
            alpha.set_owner_profile("alpha")
            beta = MOD.DeftAdapter(
                FakeConfig(config), request_fn=request, start_listener=False,
            )
            beta.set_owner_profile("beta")

            self.assertTrue(asyncio.run(alpha.connect()))
            self.assertTrue(state_path.exists())
            self.assertFalse(asyncio.run(beta.connect()))
            self.assertEqual([call[1] for call in calls], ["/connect"])
            alpha._pending_events["alpha-event"] = {
                "event_id": "alpha-event",
                "transport_accepted": True,
            }
            alpha._save_state()
            state = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual([item["event_id"] for item in state["pending_events"]], ["alpha-event"])
            self.assertEqual(
                state["binding_sha256"],
                MOD._journal_binding(
                    "https://demo.deft.ing/api/agent-channel/v1",
                    "native-spike",
                    "alpha",
                ),
            )

    def test_named_profiles_use_isolated_default_journals(self):
        async def request(method, path, query, body):
            if path == "/connect":
                return {"ok": True, "adapter_mode": "autonomous_platform"}
            if path == "/status":
                return {"ok": True}
            raise AssertionError(path)

        def implicit_config():
            config = FakeConfig({
                "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                "token": "secret-test-token",
                "employee_slug": "native-spike",
            })
            config.extra.pop("state_path", None)
            return config

        async def scenario(state_root):
            with patch.dict(os.environ, {"HERMES_HOME": str(state_root)}):
                default = MOD.DeftAdapter(
                    implicit_config(), request_fn=request, start_listener=False,
                )
                default.set_owner_profile("default")
                alpha = MOD.DeftAdapter(
                    implicit_config(), request_fn=request, start_listener=False,
                )
                alpha.set_owner_profile("alpha")
                beta = MOD.DeftAdapter(
                    implicit_config(), request_fn=request, start_listener=False,
                )
                beta.set_owner_profile("beta")

                self.assertTrue(await default.connect())
                self.assertTrue(await alpha.connect())
                self.assertTrue(await beta.connect())
                self.assertEqual(
                    default._state_path,
                    state_root / "deft-platform-state.json",
                )
                self.assertNotEqual(alpha._state_path, default._state_path)
                self.assertNotEqual(beta._state_path, default._state_path)
                self.assertNotEqual(alpha._state_path, beta._state_path)

                alpha._pending_events["alpha-event"] = {
                    "event_id": "alpha-event",
                    "transport_accepted": True,
                }
                alpha._last_accepted_event_id = "alpha-event"
                alpha._save_state()
                beta._pending_events["beta-event"] = {
                    "event_id": "beta-event",
                    "transport_accepted": True,
                }
                beta._last_accepted_event_id = "beta-event"
                beta._save_state()

                alpha_reloaded = MOD.DeftAdapter(
                    implicit_config(), request_fn=request, start_listener=False,
                )
                alpha_reloaded.set_owner_profile("alpha")
                beta_reloaded = MOD.DeftAdapter(
                    implicit_config(), request_fn=request, start_listener=False,
                )
                beta_reloaded.set_owner_profile("beta")
                self.assertTrue(await alpha_reloaded.connect())
                self.assertTrue(await beta_reloaded.connect())
                self.assertEqual(alpha_reloaded._state_path, alpha._state_path)
                self.assertEqual(beta_reloaded._state_path, beta._state_path)
                self.assertEqual(set(alpha_reloaded._pending_events), {"alpha-event"})
                self.assertEqual(set(beta_reloaded._pending_events), {"beta-event"})

                explicit_path = state_root / "operator-selected-state.json"
                explicit = MOD.DeftAdapter(
                    FakeConfig({
                        "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                        "token": "secret-test-token",
                        "employee_slug": "native-spike",
                        "state_path": str(explicit_path),
                    }),
                    request_fn=request,
                    start_listener=False,
                )
                explicit.set_owner_profile("alpha")
                self.assertTrue(await explicit.connect())
                self.assertEqual(explicit._state_path, explicit_path)

                for adapter in (
                    default,
                    alpha,
                    beta,
                    alpha_reloaded,
                    beta_reloaded,
                    explicit,
                ):
                    await adapter.disconnect()

        with tempfile.TemporaryDirectory() as temp_dir:
            asyncio.run(scenario(pathlib.Path(temp_dir)))

    def test_authentication_failure_is_not_retried_by_listener(self):
        calls = []

        async def request(method, path, query, body):
            calls.append(path)
            if path == "/connect":
                return {"ok": True, "adapter_mode": "autonomous_platform"}
            if path == "/events":
                raise MOD.DeftChannelRequestError(
                    "token expired", status=401, code="UNAUTHORIZED", retryable=False,
                )
            if path == "/status":
                return {"ok": True}
            raise AssertionError(path)

        async def scenario():
            adapter = MOD.DeftAdapter(
                FakeConfig({
                    "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                    "token": "secret-test-token",
                    "employee_slug": "native-spike",
                }),
                request_fn=request,
                start_listener=True,
            )
            adapter.set_message_handler(lambda event: None)
            self.assertTrue(await adapter.connect())
            await adapter._poll_task
            await adapter.disconnect()

        asyncio.run(scenario())
        self.assertEqual(calls.count("/events"), 1)

    def test_adapter_loads_and_unloads_without_model_api(self):
        context = FakeContext()
        MOD.register(context)
        from gateway.platform_registry import PlatformEntry, platform_registry

        registration = context.registration
        platform_registry.register(PlatformEntry(
            name=registration["name"],
            label=registration["label"],
            adapter_factory=registration["adapter_factory"],
            check_fn=registration["check_fn"],
            validate_config=registration["validate_config"],
        ))
        config = FakeConfig({
            "channel_url": "https://demo.deft.ing/api/agent-channel",
            "token": "secret-test-token",
            "employee_slug": "native-spike",
        })
        try:
            async def request(method, path, query, body):
                self.assertEqual(path, "/connect")
                return {"ok": True, "adapter_mode": "autonomous_platform"}

            adapter = MOD.DeftAdapter(config, request_fn=request, start_listener=False)
            self.assertNotIn("responses", adapter.channel_url)
            self.assertTrue(adapter.authorization_is_upstream)
            self.assertTrue(asyncio.run(adapter.connect(is_reconnect=True)))
            asyncio.run(adapter.disconnect())
            self.assertFalse(adapter._running)
        finally:
            platform_registry.unregister("deft")

    def test_accepts_delivery_once_without_a_reasoning_lease(self):
        calls = []
        delivered = []
        event = {"id": "event-1", "claim_token": "claim-1", "payload": {"content": "hello"}}
        event_reads = 0

        async def request(method, path, query, body):
            nonlocal event_reads
            calls.append((method, path, query, body))
            if path == "/connect":
                return {"ok": True, "adapter_mode": "autonomous_platform"}
            if path == "/events":
                event_reads += 1
                return {"ok": True, "events": [event] if event_reads == 1 else []}
            if path == "/accept":
                return {"ok": True, "transport_state": "accepted", "business_outcome": None}
            raise AssertionError(path)

        async def receive(value):
            delivered.append(value)

        async def scenario():
            from gateway.platform_registry import PlatformEntry, platform_registry
            platform_registry.register(PlatformEntry(
                name="deft",
                label="Deft",
                adapter_factory=lambda cfg: None,
                check_fn=lambda: True,
            ))
            try:
                adapter = MOD.DeftAdapter(
                    FakeConfig({
                        "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                        "token": "secret-test-token",
                        "employee_slug": "native-spike",
                    }),
                    request_fn=request,
                    start_listener=False,
                )
                adapter.set_message_handler(receive)
                self.assertTrue(await adapter.connect())
                self.assertEqual(await adapter._poll_once(), 1)
                if adapter._background_tasks:
                    await asyncio.gather(*list(adapter._background_tasks))
                self.assertEqual(await adapter._poll_once(), 0)
                await adapter.disconnect()
                return adapter
            finally:
                platform_registry.unregister("deft")

        adapter = asyncio.run(scenario())
        self.assertEqual([item.raw_message["id"] for item in delivered], ["event-1"])
        accepts = [call for call in calls if call[1] == "/accept"]
        self.assertEqual(len(accepts), 1)
        self.assertEqual(accepts[0][3]["claim_token"], "claim-1")
        self.assertEqual(adapter._last_accepted_event_id, "event-1")
        self.assertFalse(any("responses" in call[1] for call in calls))

    def test_maps_speaker_scope_and_thread_then_replies_through_normal_send(self):
        calls = []
        received = []
        source_event = {
            "id": "channel-event-7",
            "org_id": "org-1",
            "space_id": "space-1",
            "thread_id": "thread-1",
            "source_id": "message-1",
            "actor_user_id": "diego-1",
            "claim_token": "claim-7",
            "payload": {
                "message_id": "message-1",
                "reply_thread_id": "thread-1",
                "author_id": "diego-1",
                "author_name": "Diego",
                "content": "Can you summarize this?",
                "is_dm": False,
            },
        }

        async def request(method, path, query, body):
            calls.append((method, path, query, body))
            if path == "/connect":
                return {"ok": True, "adapter_mode": "autonomous_platform"}
            if path == "/events":
                return {"ok": True, "events": [source_event]}
            if path == "/accept":
                return {"ok": True, "transport_state": "accepted"}
            if path == "/reply":
                return {"ok": True, "transport_reply": "sent", "result": {"id": "message-2"}}
            raise AssertionError(path)

        async def scenario():
            from gateway.platform_registry import PlatformEntry, platform_registry
            platform_registry.register(PlatformEntry(
                name="deft", label="Deft", adapter_factory=lambda cfg: None, check_fn=lambda: True,
            ))
            try:
                adapter = MOD.DeftAdapter(
                    FakeConfig({
                        "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                        "token": "secret-test-token",
                        "employee_slug": "native-spike",
                    }),
                    request_fn=request,
                    start_listener=False,
                )

                async def handler(event):
                    received.append(event)
                    notice = await adapter.send(
                        event.source.chat_id,
                        "A runtime advisory must not become the chat reply.",
                        metadata={"thread_id": event.source.thread_id},
                    )
                    self.assertTrue(notice.success)
                    progress = await adapter.send(
                        event.source.chat_id,
                        "Working on the summary.",
                        reply_to=event.message_id,
                        metadata={"thread_id": event.source.thread_id},
                    )
                    self.assertTrue(progress.success)
                    return "I can summarize it."

                adapter.set_message_handler(handler)
                self.assertTrue(await adapter.connect())
                self.assertEqual(await adapter._poll_once(), 1)
                while adapter._background_tasks:
                    await asyncio.gather(*tuple(adapter._background_tasks))
                late = await adapter.send(
                    "org-1:space-1",
                    "Late delegated completion.",
                    reply_to="message-1",
                    metadata={"thread_id": "thread-1"},
                )
                self.assertTrue(late.success)
                await adapter.disconnect()
            finally:
                platform_registry.unregister("deft")

        asyncio.run(scenario())
        self.assertEqual(len(received), 1)
        message_event = received[0]
        self.assertEqual(message_event.text, "Can you summarize this?")
        self.assertEqual(message_event.source.chat_id, "org-1:space-1")
        self.assertEqual(message_event.source.thread_id, "thread-1")
        self.assertEqual(message_event.source.user_id, "diego-1")
        self.assertEqual(message_event.source.user_name, "Diego")
        self.assertEqual(message_event.auto_skill, "deft-employee:runtime")
        replies = [call for call in calls if call[1] == "/reply"]
        self.assertEqual(len(replies), 3)
        self.assertEqual({reply[3]["event_id"] for reply in replies}, {"channel-event-7"})
        self.assertEqual({reply[3]["thread_id"] for reply in replies}, {"thread-1"})
        self.assertEqual(
            {reply[3]["adapter_mode"] for reply in replies},
            {"autonomous_platform"},
        )
        self.assertEqual(len({reply[3]["idempotency_key"] for reply in replies}), 3)
        final_reply = next(
            reply for reply in replies if reply[3]["content"] == "I can summarize it."
        )
        self.assertEqual(
            final_reply[3]["idempotency_key"],
            "autonomous-reply:channel-event-7:final",
        )
        self.assertTrue(all("claim_token" not in reply[3] for reply in replies))

    def test_task_assignment_uses_normal_handler_and_returns_a_task_comment(self):
        calls = []
        received = []
        task_event = {
            "id": "task-event-1",
            "kind": "task.assigned",
            "source_kind": "task",
            "source_id": "task-uuid-1",
            "org_id": "org-1",
            "actor_user_id": "diego-1",
            "claim_token": "task-claim-1",
            "payload": {
                "task_id": "task-uuid-1",
                "task_key": "OPS-42",
                "title": "Prepare the launch brief",
                "description": "Use the launch notes in Knowledge.",
                "status": "todo",
                "priority": "p1",
                "assigned_by": "diego-1",
                "assigned_by_name": "Diego",
            },
        }

        async def request(method, path, query, body):
            calls.append((method, path, query, body))
            if path == "/connect":
                return {"ok": True, "adapter_mode": "autonomous_platform"}
            if path == "/events":
                return {"ok": True, "events": [task_event]}
            if path == "/accept":
                return {"ok": True, "transport_state": "accepted"}
            if path == "/reply":
                return {
                    "ok": True,
                    "transport_reply": "sent",
                    "transport_target": "task_comment",
                    "result": {"comment_id": "comment-1"},
                }
            raise AssertionError(path)

        async def scenario():
            from gateway.platform_registry import PlatformEntry, platform_registry
            platform_registry.register(PlatformEntry(
                name="deft", label="Deft", adapter_factory=lambda cfg: None, check_fn=lambda: True,
            ))
            try:
                adapter = MOD.DeftAdapter(
                    FakeConfig({
                        "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                        "token": "secret-test-token",
                        "employee_slug": "native-spike",
                    }),
                    request_fn=request,
                    start_listener=False,
                )

                async def handler(event):
                    received.append(event)
                    notice = await adapter.send(
                        event.source.chat_id,
                        "A runtime status notice must not complete the task delivery.",
                        metadata={"thread_id": event.source.thread_id},
                    )
                    self.assertTrue(notice.success)
                    interim = await adapter.send(
                        event.source.chat_id,
                        "I am checking Deft Knowledge.",
                        reply_to=event.message_id,
                        metadata={
                            "thread_id": event.source.thread_id,
                            "_interim_send": True,
                        },
                    )
                    self.assertTrue(interim.success)
                    final = await adapter.send(
                        event.source.chat_id,
                        "I picked this up and will use the launch notes.",
                        metadata={
                            "thread_id": event.source.thread_id,
                            "notify": True,
                        },
                    )
                    self.assertTrue(final.success)
                    return None

                adapter.set_message_handler(handler)
                self.assertTrue(await adapter.connect())
                self.assertEqual(await adapter._poll_once(), 1)
                while adapter._background_tasks:
                    await asyncio.gather(*tuple(adapter._background_tasks))
                self.assertEqual(adapter._pending_events, {})
                late = await adapter.send(
                    "org-1:tasks",
                    "A late continuation must not create a second task reply.",
                    metadata={
                        "thread_id": "task-uuid-1",
                        "notify": True,
                    },
                )
                self.assertFalse(late.success)
                self.assertIn("No accepted Deft source event", late.error or "")
                await adapter.disconnect()
            finally:
                platform_registry.unregister("deft")

        asyncio.run(scenario())
        self.assertEqual(len(received), 1)
        task = received[0]
        self.assertIn("Task: OPS-42", task.text)
        self.assertIn("Task ID: task-uuid-1", task.text)
        self.assertEqual(task.source.chat_id, "org-1:tasks")
        self.assertEqual(task.source.thread_id, "task-uuid-1")
        self.assertEqual(task.source.user_id, "diego-1")
        self.assertEqual(task.source.user_name, "Diego")
        replies = [call for call in calls if call[1] == "/reply"]
        self.assertEqual(len(replies), 1)
        reply = replies[0]
        self.assertEqual(reply[3]["content"], "I picked this up and will use the launch notes.")
        self.assertEqual(reply[3]["event_id"], "task-event-1")
        self.assertEqual(reply[3]["thread_id"], "task-uuid-1")
        self.assertNotIn("claim_token", reply[3])

    def test_certification_uses_prompt_and_reports_session_bound_reply(self):
        calls = []
        received = []
        processing_session_keys = []
        adapter_after_run = None
        certification_event = {
            "id": "certification-event-1",
            "kind": "certification.challenge",
            "source_kind": "certification",
            "source_id": "certification-challenge-1",
            "org_id": "org-1",
            "space_id": "certification-challenge-1",
            "actor_user_id": "owner-1",
            "claim_token": "certification-claim-1",
            "payload": {
                "is_dm": True,
                "certification_prompt": "Run the real certification turn and reply with nonce-123.",
            },
        }

        async def request(method, path, query, body):
            calls.append((method, path, query, body))
            if path == "/connect":
                return {"ok": True, "adapter_mode": "autonomous_platform"}
            if path == "/events":
                return {"ok": True, "events": [certification_event]}
            if path == "/accept":
                return {"ok": True, "transport_state": "accepted"}
            if path == "/reply":
                return {
                    "ok": True,
                    "transport_reply": "sent",
                    "transport_target": "chat_message",
                    "business_outcome": None,
                    "result": {"message_id": "certification-reply-1"},
                }
            if path == "/status":
                return {"ok": True}
            raise AssertionError(path)

        async def scenario():
            nonlocal adapter_after_run
            from gateway.platform_registry import PlatformEntry, platform_registry
            platform_registry.register(PlatformEntry(
                name="deft", label="Deft", adapter_factory=lambda cfg: None, check_fn=lambda: True,
            ))
            try:
                adapter = MOD.DeftAdapter(
                    FakeConfig({
                        "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                        "token": "secret-test-token",
                        "employee_slug": "native-spike",
                    }),
                    request_fn=request,
                    start_listener=False,
                )
                adapter.set_owner_profile("profile-b")

                async def handler(event):
                    received.append(event)
                    processing_session_keys.extend(adapter._active_sessions)
                    interim = await adapter.send(
                        event.source.chat_id,
                        "Interim certification commentary.",
                        reply_to=event.message_id,
                        metadata={"_interim_send": True},
                    )
                    self.assertTrue(interim.success)
                    self.assertEqual(interim.raw_response, {"interim_suppressed": True})
                    return "Certification complete nonce-123."

                adapter.set_message_handler(handler)
                self.assertTrue(await adapter.connect())
                self.assertEqual(await adapter._poll_once(), 1)
                while adapter._background_tasks:
                    await asyncio.gather(*tuple(adapter._background_tasks))
                self.assertEqual(adapter._pending_events, {})
                late = await adapter.send(
                    received[0].source.chat_id,
                    "Late certification output must be rejected.",
                    reply_to=certification_event["id"],
                )
                self.assertFalse(late.success)
                self.assertIn("No accepted Deft source event", late.error or "")
                adapter_after_run = adapter
                await adapter.disconnect()
            finally:
                platform_registry.unregister("deft")

        asyncio.run(scenario())
        self.assertEqual(len(received), 1)
        self.assertEqual(
            received[0].text,
            "Run the real certification turn and reply with nonce-123.",
        )
        paths = [call[1] for call in calls]
        self.assertIn("/accept", paths)
        self.assertIn("/reply", paths)
        self.assertNotIn("/ack", paths)
        self.assertNotIn("/reconcile", paths)
        reply = next(call for call in calls if call[1] == "/reply")
        expected_session_key = MOD.build_session_key(
            received[0].source,
            group_sessions_per_user=True,
            thread_sessions_per_user=False,
            profile="profile-b",
        )
        self.assertEqual(processing_session_keys, [expected_session_key])
        self.assertEqual(reply[3]["runtime_session_key"], expected_session_key)
        self.assertTrue(reply[3]["runtime_session_key"].startswith("agent:profile-b:"))
        self.assertEqual(reply[3]["idempotency_key"], "autonomous-reply:certification-event-1:final")
        self.assertNotIn("outcome", reply[3])
        self.assertIsNone(reply[3]["thread_id"])
        self.assertNotIn("claim_token", reply[3])
        self.assertEqual(len([call for call in calls if call[1] == "/reply"]), 1)
        self.assertEqual(adapter_after_run._routes_by_message, {})
        self.assertEqual(adapter_after_run._routes_by_scope, {})

    def test_blank_certification_prompt_fails_closed_and_stays_journaled(self):
        calls = []
        delivered = []
        event_delivered = False
        certification_event = {
            "id": "blank-certification-event-1",
            "kind": "certification.challenge",
            "source_kind": "certification",
            "source_id": "blank-certification-1",
            "org_id": "org-1",
            "space_id": "blank-certification-1",
            "claim_token": "blank-certification-claim-1",
            "payload": {"certification_prompt": "   \n\t"},
        }
        accepted_event = json.loads(json.dumps(certification_event))
        accepted_event["claim_token"] = None

        async def request(method, path, query, body):
            nonlocal event_delivered
            calls.append((method, path, query, body))
            if path == "/connect":
                return {"ok": True, "adapter_mode": "autonomous_platform"}
            if path == "/events":
                if event_delivered:
                    return {"ok": True, "events": []}
                event_delivered = True
                return {"ok": True, "events": [certification_event]}
            if path == "/accept":
                response = {"ok": True, "transport_state": "accepted"}
                if "claim_token" not in body:
                    response["event"] = accepted_event
                return response
            if path == "/status":
                return {"ok": True}
            raise AssertionError(path)

        async def scenario(state_path):
            config = {
                "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                "token": "secret-test-token",
                "employee_slug": "native-spike",
                "state_path": str(state_path),
            }
            first = MOD.DeftAdapter(
                FakeConfig(config), request_fn=request, start_listener=False,
            )

            async def handler(event):
                delivered.append(event)
                return "This must never run."

            first.set_message_handler(handler)
            self.assertTrue(await first.connect())
            with self.assertRaisesRegex(RuntimeError, "has no certification_prompt"):
                await first._poll_once()
            self.assertEqual(set(first._pending_events), {certification_event["id"]})
            await first.disconnect()

            second = MOD.DeftAdapter(
                FakeConfig(config), request_fn=request, start_listener=False,
            )
            second.set_message_handler(handler)
            self.assertTrue(await second.connect())
            with self.assertRaisesRegex(RuntimeError, "has no certification_prompt"):
                await second._poll_once()
            self.assertEqual(set(second._pending_events), {certification_event["id"]})
            await second.disconnect()
            return json.loads(state_path.read_text(encoding="utf-8"))

        with tempfile.TemporaryDirectory() as temp_dir:
            state = asyncio.run(scenario(pathlib.Path(temp_dir) / "state.json"))
        self.assertEqual(delivered, [])
        accepts = [call for call in calls if call[1] == "/accept"]
        self.assertEqual(len(accepts), 2)
        self.assertIn("claim_token", accepts[0][3])
        self.assertNotIn("claim_token", accepts[1][3])
        self.assertEqual(state["pending_events"], [{
            "event_id": certification_event["id"],
            "transport_accepted": True,
        }])

    def test_certification_failure_and_empty_output_recover_across_restarts(self):
        calls = []
        reply_attempts = []
        event_delivered = False
        reply_phase = "failure"
        certification_event = {
            "id": "certification-restart-event-1",
            "kind": "certification.restart_proof",
            "source_kind": "certification",
            "source_id": "certification-restart-1",
            "org_id": "org-1",
            "space_id": "certification-restart-1",
            "claim_token": "certification-restart-claim-1",
            "payload": {
                "certification_prompt": "Prove restart continuity with nonce-restart-1.",
            },
        }
        accepted_event = json.loads(json.dumps(certification_event))
        accepted_event["claim_token"] = None

        async def request(method, path, query, body):
            nonlocal event_delivered
            calls.append((method, path, query, body))
            if path == "/connect":
                return {"ok": True, "adapter_mode": "autonomous_platform"}
            if path == "/events":
                if event_delivered:
                    return {"ok": True, "events": []}
                event_delivered = True
                return {"ok": True, "events": [certification_event]}
            if path == "/accept":
                response = {"ok": True, "transport_state": "accepted"}
                if "claim_token" not in body:
                    response["event"] = accepted_event
                return response
            if path == "/reply":
                reply_attempts.append((reply_phase, dict(body)))
                if reply_phase == "failure":
                    return {"ok": False}
                return {
                    "ok": True,
                    "transport_reply": "sent",
                    "result": {"message_id": "restart-proof-reply-1"},
                }
            if path == "/status":
                return {"ok": True}
            raise AssertionError(path)

        async def drain(adapter):
            while adapter._background_tasks:
                await asyncio.gather(*tuple(adapter._background_tasks))

        async def scenario(state_path):
            nonlocal reply_phase
            from gateway.platform_registry import PlatformEntry, platform_registry
            platform_registry.register(PlatformEntry(
                name="deft", label="Deft", adapter_factory=lambda cfg: None, check_fn=lambda: True,
            ))
            try:
                config = {
                    "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                    "token": "secret-test-token",
                    "employee_slug": "native-spike",
                    "state_path": str(state_path),
                }
                first = MOD.DeftAdapter(
                    FakeConfig(config), request_fn=request, start_listener=False,
                )

                async def failed_handler(event):
                    return "First certification output is rejected."

                first.set_message_handler(failed_handler)
                self.assertTrue(await first.connect())
                self.assertEqual(await first._poll_once(), 1)
                await drain(first)
                self.assertEqual(set(first._pending_events), {certification_event["id"]})
                journal_after_failure = json.loads(state_path.read_text(encoding="utf-8"))
                await first.disconnect()

                reply_phase = "empty"
                second = MOD.DeftAdapter(
                    FakeConfig(config), request_fn=request, start_listener=False,
                )

                async def empty_handler(event):
                    return None

                second.set_message_handler(empty_handler)
                self.assertTrue(await second.connect())
                self.assertEqual(await second._poll_once(), 1)
                await drain(second)
                self.assertEqual(set(second._pending_events), {certification_event["id"]})
                journal_after_empty = json.loads(state_path.read_text(encoding="utf-8"))
                await second.disconnect()

                reply_phase = "success"
                third = MOD.DeftAdapter(
                    FakeConfig(config), request_fn=request, start_listener=False,
                )

                async def recovered_handler(event):
                    return "Recovered certification output nonce-restart-1."

                third.set_message_handler(recovered_handler)
                self.assertTrue(await third.connect())
                self.assertEqual(await third._poll_once(), 1)
                await drain(third)
                self.assertEqual(third._pending_events, {})
                self.assertEqual(third._routes_by_message, {})
                self.assertEqual(third._routes_by_scope, {})
                journal_after_success = json.loads(state_path.read_text(encoding="utf-8"))
                await third.disconnect()
                return journal_after_failure, journal_after_empty, journal_after_success
            finally:
                platform_registry.unregister("deft")

        with tempfile.TemporaryDirectory() as temp_dir:
            failed, empty, succeeded = asyncio.run(
                scenario(pathlib.Path(temp_dir) / "state.json")
            )
        expected_pending = [{
            "event_id": certification_event["id"],
            "transport_accepted": True,
        }]
        self.assertEqual(failed["pending_events"], expected_pending)
        self.assertEqual(empty["pending_events"], expected_pending)
        self.assertEqual(succeeded["pending_events"], [])
        accepts = [call for call in calls if call[1] == "/accept"]
        self.assertEqual(len(accepts), 3)
        self.assertIn("claim_token", accepts[0][3])
        self.assertTrue(all("claim_token" not in call[3] for call in accepts[1:]))
        self.assertGreaterEqual(len(reply_attempts), 3)
        self.assertEqual(reply_attempts[-1][0], "success")
        self.assertEqual(
            {attempt[1]["idempotency_key"] for attempt in reply_attempts},
            {"autonomous-reply:certification-restart-event-1:final"},
        )

    def test_certification_lost_success_response_dedupes_regenerated_output(self):
        reply_attempts = []
        durable_replies = {}
        event_delivered = False
        lose_first_response = True
        certification_event = {
            "id": "certification-lost-response-event-1",
            "kind": "certification.challenge",
            "source_kind": "certification",
            "source_id": "certification-lost-response-1",
            "org_id": "org-1",
            "space_id": "certification-lost-response-1",
            "claim_token": "certification-lost-response-claim-1",
            "payload": {
                "certification_prompt": "Return a durable certification proof.",
            },
        }
        accepted_event = json.loads(json.dumps(certification_event))
        accepted_event["claim_token"] = None

        async def request(method, path, query, body):
            nonlocal event_delivered, lose_first_response
            if path == "/connect":
                return {"ok": True, "adapter_mode": "autonomous_platform"}
            if path == "/events":
                if event_delivered:
                    return {"ok": True, "events": []}
                event_delivered = True
                return {"ok": True, "events": [certification_event]}
            if path == "/accept":
                response = {"ok": True, "transport_state": "accepted"}
                if "claim_token" not in body:
                    response["event"] = accepted_event
                return response
            if path == "/reply":
                reply_attempts.append(dict(body))
                key = body["idempotency_key"]
                durable_replies.setdefault(key, {
                    "content": body["content"],
                    "message_id": "durable-certification-reply-1",
                })
                if lose_first_response:
                    lose_first_response = False
                    raise MOD.DeftChannelRequestError(
                        "reply timed out after the server committed it",
                        status=504,
                        code="RESPONSE_TIMEOUT",
                        retryable=False,
                    )
                return {
                    "ok": True,
                    "transport_reply": "sent",
                    "idempotent_replay": True,
                    "result": {"message_id": durable_replies[key]["message_id"]},
                }
            if path == "/status":
                return {"ok": True}
            raise AssertionError(path)

        async def drain(adapter):
            while adapter._background_tasks:
                await asyncio.gather(*tuple(adapter._background_tasks))

        async def scenario(state_path):
            from gateway.platform_registry import PlatformEntry, platform_registry
            platform_registry.register(PlatformEntry(
                name="deft", label="Deft", adapter_factory=lambda cfg: None, check_fn=lambda: True,
            ))
            try:
                config = {
                    "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                    "token": "secret-test-token",
                    "employee_slug": "native-spike",
                    "state_path": str(state_path),
                }
                first = MOD.DeftAdapter(
                    FakeConfig(config), request_fn=request, start_listener=False,
                )

                async def first_handler(event):
                    return "First generated certification proof."

                first.set_message_handler(first_handler)
                self.assertTrue(await first.connect())
                self.assertEqual(await first._poll_once(), 1)
                await drain(first)
                self.assertEqual(set(first._pending_events), {certification_event["id"]})
                await first.disconnect()

                second = MOD.DeftAdapter(
                    FakeConfig(config), request_fn=request, start_listener=False,
                )

                async def regenerated_handler(event):
                    return "Different regenerated certification proof."

                second.set_message_handler(regenerated_handler)
                self.assertTrue(await second.connect())
                self.assertEqual(await second._poll_once(), 1)
                await drain(second)
                self.assertEqual(second._pending_events, {})
                late = await second.send(
                    f"org-1:{certification_event['space_id']}",
                    "Late output after idempotent confirmation.",
                    reply_to=certification_event["id"],
                )
                self.assertFalse(late.success)
                await second.disconnect()
                return json.loads(state_path.read_text(encoding="utf-8"))
            finally:
                platform_registry.unregister("deft")

        with tempfile.TemporaryDirectory() as temp_dir:
            state = asyncio.run(scenario(pathlib.Path(temp_dir) / "state.json"))
        self.assertEqual(len(reply_attempts), 2)
        self.assertNotEqual(reply_attempts[0]["content"], reply_attempts[1]["content"])
        self.assertEqual(
            {attempt["idempotency_key"] for attempt in reply_attempts},
            {"autonomous-reply:certification-lost-response-event-1:final"},
        )
        self.assertEqual(len(durable_replies), 1)
        only_durable_reply = next(iter(durable_replies.values()))
        self.assertEqual(only_durable_reply["content"], reply_attempts[0]["content"])
        self.assertEqual(state["pending_events"], [])

    def test_restart_resumes_one_accepted_event_without_duplicate_reply(self):
        calls = []
        received = []
        source_event = {
            "id": "restart-event-1",
            "kind": "task.assigned",
            "source_kind": "task",
            "source_id": "restart-task-1",
            "org_id": "org-1",
            "actor_user_id": "diego-1",
            "claim_token": "restart-claim-1",
            "payload": {
                "task_id": "restart-task-1",
                "task_key": "OPS-77",
                "title": "Survive an adapter restart",
                "status": "todo",
                "assigned_by": "diego-1",
            },
        }
        accepted_event = json.loads(json.dumps(source_event))
        accepted_event.update({
            "status": "acknowledged",
            "claim_token": None,
            "claim_owner": None,
            "lease_expires_at": None,
        })
        event_delivered = False

        async def request(method, path, query, body):
            nonlocal event_delivered
            calls.append((method, path, query, body))
            if path == "/connect":
                return {"ok": True, "adapter_mode": "autonomous_platform"}
            if path == "/events":
                if not event_delivered:
                    event_delivered = True
                    return {"ok": True, "events": [source_event]}
                return {"ok": True, "events": []}
            if path == "/accept":
                return {
                    "ok": True,
                    "transport_state": "accepted",
                    "event": accepted_event,
                }
            if path == "/reply":
                return {
                    "ok": True,
                    "transport_reply": "sent",
                    "transport_target": "task_comment",
                    "result": {"comment_id": "restart-comment-1"},
                }
            raise AssertionError(path)

        async def scenario(state_path):
            from gateway.platform_registry import PlatformEntry, platform_registry
            platform_registry.register(PlatformEntry(
                name="deft", label="Deft", adapter_factory=lambda cfg: None, check_fn=lambda: True,
            ))
            try:
                config = {
                    "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                    "token": "secret-test-token",
                    "employee_slug": "native-spike",
                    "state_path": str(state_path),
                }
                first = MOD.DeftAdapter(FakeConfig(config), request_fn=request, start_listener=False)

                async def interrupted_handler(event):
                    # Hermes may accept a task, hand it to deferred work, and
                    # end the originating channel turn before any final reply.
                    return None

                first.set_message_handler(interrupted_handler)
                self.assertTrue(await first.connect())
                self.assertEqual(await first._poll_once(), 1)
                while first._background_tasks:
                    await asyncio.gather(*tuple(first._background_tasks))
                await first.disconnect()
                journal_after_first = pathlib.Path(state_path).read_text(encoding="utf-8")

                second = MOD.DeftAdapter(FakeConfig(config), request_fn=request, start_listener=False)

                async def resumed_handler(event):
                    received.append(event)
                    return "Restarted cleanly and resumed the task once."

                second.set_message_handler(resumed_handler)
                self.assertTrue(await second.connect())
                self.assertEqual(await second._poll_once(), 1)
                while second._background_tasks:
                    await asyncio.gather(*tuple(second._background_tasks))
                await second.disconnect()

                third = MOD.DeftAdapter(FakeConfig(config), request_fn=request, start_listener=False)
                third.set_message_handler(resumed_handler)
                self.assertTrue(await third.connect())
                self.assertEqual(await third._poll_once(), 0)
                await third.disconnect()
                return (
                    json.loads(pathlib.Path(state_path).read_text(encoding="utf-8")),
                    journal_after_first,
                )
            finally:
                platform_registry.unregister("deft")

        with tempfile.TemporaryDirectory() as temp_dir:
            state, accepted_journal = asyncio.run(scenario(pathlib.Path(temp_dir) / "state.json"))
        self.assertEqual(len(received), 1)
        accepts = [call for call in calls if call[1] == "/accept"]
        self.assertEqual(len(accepts), 2)
        self.assertEqual(accepts[0][3]["claim_token"], "restart-claim-1")
        self.assertNotIn("claim_token", accepts[1][3])
        replies = [call for call in calls if call[1] == "/reply"]
        self.assertEqual(len(replies), 1)
        self.assertEqual(
            replies[0][3]["idempotency_key"],
            "autonomous-reply:restart-event-1:final",
        )
        self.assertEqual(json.loads(accepted_journal), {
            "version": 3,
            "binding_sha256": MOD._journal_binding(
                "https://demo.deft.ing/api/agent-channel/v1",
                "native-spike",
                "default",
            ),
            "last_accepted_event_id": "restart-event-1",
            "pending_events": [{
                "event_id": "restart-event-1",
                "transport_accepted": True,
            }],
        })
        for forbidden in (
            "restart-claim-1",
            "restart-task-1",
            "Survive an adapter restart",
            "secret-test-token",
            '"payload"',
        ):
            self.assertNotIn(forbidden, accepted_journal)
        self.assertEqual(state["last_accepted_event_id"], "restart-event-1")
        self.assertEqual(state["pending_events"], [])

    def test_stale_preaccept_journal_is_reacquired_without_claim_or_payload_persistence(self):
        calls = []
        received = []
        reclaimed_event = {
            "id": "stale-event-1",
            "kind": "message.created",
            "source_kind": "message",
            "source_id": "message-1",
            "org_id": "org-1",
            "space_id": "space-1",
            "claim_token": "fresh-claim-1",
            "payload": {
                "content": "Reacquire this private message from Deft.",
                "author_name": "Diego",
            },
        }
        event_polled = False

        async def request(method, path, query, body):
            nonlocal event_polled
            calls.append((method, path, query, body))
            if path == "/connect":
                return {"ok": True, "adapter_mode": "autonomous_platform"}
            if path == "/accept" and "claim_token" not in body:
                raise MOD.DeftChannelRequestError(
                    "claim expired", status=409, code="STALE_CLAIM", retryable=False,
                )
            if path == "/events":
                if not event_polled:
                    event_polled = True
                    return {"ok": True, "events": [reclaimed_event]}
                return {"ok": True, "events": []}
            if path == "/accept":
                self.assertEqual(body["claim_token"], "fresh-claim-1")
                return {"ok": True, "transport_state": "accepted"}
            if path == "/status":
                return {"ok": True}
            raise AssertionError(path)

        async def scenario(state_path):
            from gateway.platform_registry import PlatformEntry, platform_registry
            platform_registry.register(PlatformEntry(
                name="deft", label="Deft", adapter_factory=lambda cfg: None, check_fn=lambda: True,
            ))
            try:
                state_path.write_text(json.dumps({
                    "version": 3,
                    "binding_sha256": MOD._journal_binding(
                        "https://demo.deft.ing/api/agent-channel/v1",
                        "native-spike",
                        "default",
                    ),
                    "last_accepted_event_id": None,
                    "pending_events": [{
                        "event_id": "stale-event-1",
                        "transport_accepted": False,
                    }],
                }), encoding="utf-8")
                adapter = MOD.DeftAdapter(FakeConfig({
                    "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                    "token": "secret-test-token",
                    "employee_slug": "native-spike",
                    "state_path": str(state_path),
                }), request_fn=request, start_listener=False)

                async def handler(event):
                    received.append(event)
                    return None

                adapter.set_message_handler(handler)
                self.assertTrue(await adapter.connect())
                self.assertEqual(await adapter._poll_once(), 1)
                while adapter._background_tasks:
                    await asyncio.gather(*tuple(adapter._background_tasks))
                await adapter.disconnect()
                return state_path.read_text(encoding="utf-8")
            finally:
                platform_registry.unregister("deft")

        with tempfile.TemporaryDirectory() as temp_dir:
            journal = asyncio.run(scenario(pathlib.Path(temp_dir) / "state.json"))
        self.assertEqual([event.text for event in received], [
            "Reacquire this private message from Deft.",
        ])
        accepts = [call for call in calls if call[1] == "/accept"]
        self.assertEqual(len(accepts), 2)
        self.assertNotIn("claim_token", accepts[0][3])
        self.assertEqual(accepts[1][3]["claim_token"], "fresh-claim-1")
        self.assertNotIn("fresh-claim-1", journal)
        self.assertNotIn("Reacquire this private message", journal)
        self.assertNotIn('"payload"', journal)

    def test_unbound_legacy_journal_with_pending_work_fails_before_network(self):
        calls = []
        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = pathlib.Path(temp_dir) / "state.json"
            state_path.write_text(json.dumps({
                "version": 2,
                "last_accepted_event_id": "legacy-event-1",
                "pending_events": [{
                    "event_id": "legacy-event-1",
                    "transport_accepted": True,
                }],
            }), encoding="utf-8")
            adapter = MOD.DeftAdapter(
                FakeConfig({
                    "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                    "token": "secret-test-token",
                    "employee_slug": "native-spike",
                    "state_path": str(state_path),
                }),
                request_fn=lambda *args: calls.append(args),
                start_listener=False,
            )
            self.assertFalse(asyncio.run(adapter.connect()))
            self.assertEqual(calls, [])
            self.assertIn("unbound legacy state contains pending work", adapter._state_error or "")

    def test_legacy_journal_without_pending_work_discards_cursor_and_binds(self):
        async def request(method, path, query, body):
            self.assertEqual(path, "/connect")
            return {"ok": True, "adapter_mode": "autonomous_platform"}

        with tempfile.TemporaryDirectory() as temp_dir:
            state_path = pathlib.Path(temp_dir) / "state.json"
            state_path.write_text(json.dumps({
                "version": 2,
                "last_accepted_event_id": "completed-legacy-event",
                "pending_events": [],
            }), encoding="utf-8")
            adapter = MOD.DeftAdapter(
                FakeConfig({
                    "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
                    "token": "secret-test-token",
                    "employee_slug": "native-spike",
                    "state_path": str(state_path),
                }),
                request_fn=request,
                start_listener=False,
            )
            self.assertTrue(asyncio.run(adapter.connect()))
            migrated = json.loads(state_path.read_text(encoding="utf-8"))
            self.assertEqual(migrated["version"], 3)
            self.assertIsNone(migrated["last_accepted_event_id"])
            self.assertEqual(
                migrated["binding_sha256"],
                MOD._journal_binding(
                    "https://demo.deft.ing/api/agent-channel/v1",
                    "native-spike",
                    "default",
                ),
            )

    def test_maps_human_task_comment_and_cancellation_into_the_task_session(self):
        adapter = MOD.DeftAdapter(FakeConfig({
            "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
            "token": "secret-test-token",
            "employee_slug": "native-spike",
        }), start_listener=False)
        comment = adapter._to_message_event({
            "id": "task-comment-event-1",
            "kind": "task.commented",
            "source_kind": "task",
            "source_id": "task-1",
            "org_id": "org-1",
            "actor_user_id": "human-1",
            "payload": {
                "task_id": "task-1",
                "task_key": "OPS-1",
                "commenter_id": "human-1",
                "commenter_name": "Diego",
                "content": "Use the revised numbers in Knowledge.",
            },
        })
        cancelled = adapter._to_message_event({
            "id": "task-cancel-event-1",
            "kind": "task.status_changed",
            "source_kind": "task",
            "source_id": "task-1",
            "org_id": "org-1",
            "actor_user_id": "human-1",
            "payload": {
                "task_id": "task-1",
                "task_key": "OPS-1",
                "old_status": "in_progress",
                "new_status": "cancelled",
                "actor_name": "Diego",
            },
        })
        self.assertIn("Diego commented", comment.text)
        self.assertIn("revised numbers", comment.text)
        self.assertEqual(comment.source.thread_id, "task-1")
        self.assertEqual(comment.source.user_id, "human-1")
        self.assertIn("in_progress -> cancelled", cancelled.text)
        self.assertIn("Stop work", cancelled.text)
        self.assertEqual(cancelled.source.thread_id, "task-1")

    def test_maps_targetless_approval_resolution_as_an_acknowledgeable_notification(self):
        calls = []

        async def request(method, path, query, body):
            calls.append((method, path, query, body))
            if path == "/reply":
                return {
                    "ok": True,
                    "transport_reply": "sent",
                    "transport_target": "notification_ack",
                    "result": {"acknowledged": True},
                }
            raise AssertionError(path)

        adapter = MOD.DeftAdapter(FakeConfig({
            "channel_url": "https://demo.deft.ing/api/agent-channel/v1",
            "token": "secret-test-token",
            "employee_slug": "native-spike",
        }), request_fn=request, start_listener=False)
        notice = adapter._to_message_event({
            "id": "approval-event-1",
            "kind": "approval.resolved",
            "source_kind": "approval",
            "source_id": "action-1",
            "org_id": "org-1",
            "actor_user_id": "human-1",
            "payload": {
                "action_id": "action-1",
                "action": "module_record_create",
                "decision": "approved",
                "execution_status": "completed",
                "summary": "Add the reviewed contact.",
            },
        })
        self.assertIn("approval was approved", notice.text)
        self.assertIn("Add the reviewed contact", notice.text)
        result = asyncio.run(adapter.send(
            notice.source.chat_id,
            "Approval received; continuing autonomously.",
            reply_to=notice.message_id,
            metadata={"thread_id": notice.source.thread_id},
        ))
        self.assertTrue(result.success)
        reply = calls[0]
        self.assertEqual(reply[3]["event_id"], "approval-event-1")
        self.assertEqual(
            reply[3]["idempotency_key"],
            "autonomous-reply:approval-event-1:final",
        )


if __name__ == "__main__":
    unittest.main()
