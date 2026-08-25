import asyncio
import atexit
import importlib.util
import json
import os
import pathlib
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
            self.assertTrue(asyncio.run(adapter.connect()))
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
            return True

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
                    delivery_handler=receive,
                    start_listener=False,
                )
                self.assertTrue(await adapter.connect())
                self.assertEqual(await adapter._poll_once(), 1)
                self.assertEqual(await adapter._poll_once(), 0)
                await adapter.disconnect()
                return adapter
            finally:
                platform_registry.unregister("deft")

        adapter = asyncio.run(scenario())
        self.assertEqual([item["id"] for item in delivered], ["event-1"])
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
                    return "I can summarize it."

                adapter.set_message_handler(handler)
                self.assertTrue(await adapter.connect())
                self.assertEqual(await adapter._poll_once(), 1)
                while adapter._background_tasks:
                    await asyncio.gather(*tuple(adapter._background_tasks))
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
        reply = next(call for call in calls if call[1] == "/reply")
        self.assertEqual(reply[3]["event_id"], "channel-event-7")
        self.assertEqual(reply[3]["thread_id"], "thread-1")
        self.assertEqual(reply[3]["adapter_mode"], "autonomous_platform")
        self.assertNotIn("claim_token", reply[3])

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
                    return "I picked this up and will use the launch notes."

                adapter.set_message_handler(handler)
                self.assertTrue(await adapter.connect())
                self.assertEqual(await adapter._poll_once(), 1)
                while adapter._background_tasks:
                    await asyncio.gather(*tuple(adapter._background_tasks))
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
        reply = next(call for call in calls if call[1] == "/reply")
        self.assertEqual(reply[3]["event_id"], "task-event-1")
        self.assertEqual(reply[3]["thread_id"], "task-uuid-1")
        self.assertNotIn("claim_token", reply[3])

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
                return {"ok": True, "transport_state": "accepted"}
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
                never = asyncio.Event()

                async def interrupted_handler(event):
                    await never.wait()

                first.set_message_handler(interrupted_handler)
                self.assertTrue(await first.connect())
                self.assertEqual(await first._poll_once(), 1)
                for task in tuple(first._background_tasks):
                    task.cancel()
                if first._background_tasks:
                    await asyncio.gather(*tuple(first._background_tasks), return_exceptions=True)
                await first.disconnect()

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
                return json.loads(pathlib.Path(state_path).read_text(encoding="utf-8"))
            finally:
                platform_registry.unregister("deft")

        with tempfile.TemporaryDirectory() as temp_dir:
            state = asyncio.run(scenario(pathlib.Path(temp_dir) / "state.json"))
        self.assertEqual(len(received), 1)
        self.assertEqual(len([call for call in calls if call[1] == "/accept"]), 1)
        replies = [call for call in calls if call[1] == "/reply"]
        self.assertEqual(len(replies), 1)
        self.assertEqual(replies[0][3]["idempotency_key"], "autonomous-reply:restart-event-1:response")
        self.assertEqual(state["last_accepted_event_id"], "restart-event-1")
        self.assertEqual(state["pending_events"], [])


if __name__ == "__main__":
    unittest.main()
