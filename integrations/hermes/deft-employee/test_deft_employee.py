import importlib.util
import pathlib
import json
import unittest


MODULE = pathlib.Path(__file__).with_name("__init__.py")
PLUGIN_DIR = MODULE.parent
SPEC = importlib.util.spec_from_file_location("deft_employee_plugin", MODULE)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class FakeContext:
    def __init__(self):
        self.hooks = {}
        self.skills = []

    def register_hook(self, name, callback):
        self.hooks[name] = callback

    def register_skill(self, name, path, description=""):
        self.skills.append((name, pathlib.Path(path), description))


class DeftEmployeeHookTests(unittest.TestCase):
    def test_external_write_defaults_closed(self):
        hooks = MOD.DeftEmployeeHooks()
        decision = hooks.pre_tool_call(tool_name="gmail_send_email", args={"to": "a@example.com"})
        self.assertEqual(decision["action"], "block")

    def test_approved_external_write_is_available_to_the_runtime(self):
        hooks = MOD.DeftEmployeeHooks()
        hooks.policy = {"allow_external_writes": True}
        decision = hooks.pre_tool_call(tool_name="gmail_send_email", args={"to": "a@example.com"})
        self.assertIsNone(decision)

    def test_tool_budget_exhaustion_requests_human_assistance(self):
        hooks = MOD.DeftEmployeeHooks()
        hooks.policy = {"budgets": {"max_tool_calls": 1}}
        self.assertIsNone(hooks.pre_tool_call(tool_name="browser", args={"url": "https://example.com"}))
        decision = hooks.pre_tool_call(tool_name="browser", args={"url": "https://example.org"})
        self.assertEqual(decision["action"], "block")
        self.assertIn("human assistance", decision["message"])

    def test_model_visible_deft_write_is_governed_by_deft(self):
        hooks = MOD.DeftEmployeeHooks()
        decision = hooks.pre_tool_call(
            tool_name="mcp_deft_memory_write",
            args={"title": "Certification memory"},
        )
        self.assertIsNone(decision)

    def test_destructive_command_is_blocked(self):
        hooks = MOD.DeftEmployeeHooks()
        decision = hooks.pre_tool_call(tool_name="terminal", args={"command": "rm -rf /tmp/work"})
        self.assertEqual(decision["action"], "block")

    def test_report_sanitizer_redacts_bearer(self):
        value = MOD._sanitize("Bearer abcdefghijklmnopqrstuvwxyz")
        self.assertNotIn("abcdefghijklmnopqrstuvwxyz", value)
        self.assertIn("[REDACTED]", value)

    def test_runtime_status_drives_truthful_tool_and_child_receipts(self):
        hooks = MOD.DeftEmployeeHooks()
        calls = []
        hooks.call_deft = lambda name, args: calls.append((name, args))
        hooks.post_tool_call(
            tool_name="browser",
            result="navigation failed",
            status="error",
            error_type="TimeoutError",
            error_message="timed out",
            tool_call_id="tool-1",
        )
        hooks.subagent_stop(
            child_session_id="child-1",
            child_role="researcher",
            child_summary="Could not access the source",
            child_status="timeout",
        )
        self.assertFalse(calls[0][1]["metadata"]["success"])
        self.assertEqual(calls[0][1]["metadata"]["status"], "error")
        self.assertFalse(calls[1][1]["metadata"]["success"])
        self.assertEqual(calls[1][1]["metadata"]["status"], "timeout")

    def test_external_write_reports_provider_acceptance_and_replay_identity(self):
        hooks = MOD.DeftEmployeeHooks()
        calls = []
        hooks.call_deft = lambda name, args: calls.append((name, args))
        hooks.post_tool_call(
            tool_name="gmail_send_email",
            args={"to": "buyer@example.com", "subject": "Trial follow-up"},
            result={"status": "accepted", "message_id": "provider-message-42"},
            status="success",
            tool_call_id="tool-send-1",
            turn_id="turn-1",
        )
        self.assertEqual(calls[0][0], "record_action_attempt")
        report = calls[0][1]
        self.assertEqual(report["idempotency_key"], "external-tool:tool-send-1")
        self.assertTrue(report["metadata"]["external_write"])
        self.assertTrue(report["metadata"]["provider_accepted"])
        self.assertEqual(
            report["metadata"]["provider_receipt"]["message_id"],
            "provider-message-42",
        )

    def test_successful_internal_and_research_reads_do_not_create_raw_tool_noise(self):
        hooks = MOD.DeftEmployeeHooks()
        calls = []
        hooks.call_deft = lambda name, args: calls.append((name, args))
        hooks.post_tool_call(tool_name="browser_search", result={"items": 10}, status="success")
        hooks.post_tool_call(tool_name="mcp_deft_task_query", result={"tasks": []}, status="success")
        self.assertEqual(calls, [])

    def test_llm_context_teaches_executable_deft_contracts(self):
        hooks = MOD.DeftEmployeeHooks()
        context = json.loads(hooks.pre_llm_call()["context"])
        self.assertIn("allowed_next_statuses", context["deft_task_contract"])
        self.assertIn("module_schema_get", context["deft_module_contract"])
        self.assertIn("relations", context["deft_module_contract"])
        self.assertIn("record_progress", context["deft_progress_contract"])
        self.assertIn("Do not mirror every tool call", context["deft_progress_contract"])
        self.assertIn("deft.tool_outcome.v1", context["deft_tool_outcome_contract"])
        self.assertIn("never claim completion", context["deft_tool_outcome_contract"])


class DeftEmployeePluginTests(unittest.TestCase):
    def test_registers_runtime_skill_and_existing_hooks(self):
        context = FakeContext()
        MOD.register(context)

        self.assertEqual(
            set(context.hooks),
            {"pre_llm_call", "pre_tool_call", "post_tool_call", "subagent_stop"},
        )
        self.assertEqual(len(context.skills), 1)
        name, path, description = context.skills[0]
        self.assertEqual(name, "runtime")
        self.assertEqual(path, PLUGIN_DIR / "SKILL.md")
        self.assertTrue(path.is_file())
        self.assertIn("Deft", description)

        content = path.read_text(encoding="utf-8")
        self.assertIn("deft_status", content)
        self.assertIn("record_progress", content)
        self.assertIn("provider receipt", content.lower())

    def test_stock_hermes_resolves_the_qualified_runtime_skill(self):
        from hermes_cli.plugins import PluginContext, PluginManager, PluginManifest

        manager = PluginManager()
        manifest = PluginManifest(
            name="deft-employee",
            version="0.3.0",
            description="Deft employee policy",
            source="user",
        )
        MOD.register(PluginContext(manifest, manager))

        self.assertEqual(
            manager.find_plugin_skill("deft-employee:runtime"),
            PLUGIN_DIR / "SKILL.md",
        )


if __name__ == "__main__":
    unittest.main()
