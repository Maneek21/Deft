import importlib.util
import pathlib
import json
import unittest


MODULE = pathlib.Path(__file__).with_name("__init__.py")
SPEC = importlib.util.spec_from_file_location("deft_employee_plugin", MODULE)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class DeftEmployeeHookTests(unittest.TestCase):
    def test_external_write_defaults_closed(self):
        hooks = MOD.DeftEmployeeHooks()
        decision = hooks.pre_tool_call(tool_name="gmail_send_email", args={"to": "a@example.com"})
        self.assertEqual(decision["action"], "block")

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

    def test_llm_context_teaches_executable_deft_contracts(self):
        hooks = MOD.DeftEmployeeHooks()
        context = json.loads(hooks.pre_llm_call()["context"])
        self.assertIn("allowed_next_statuses", context["deft_task_contract"])
        self.assertIn("module_schema_get", context["deft_module_contract"])
        self.assertIn("relations", context["deft_module_contract"])
        self.assertIn("record_progress", context["deft_progress_contract"])
        self.assertIn("Do not mirror every tool call", context["deft_progress_contract"])


if __name__ == "__main__":
    unittest.main()
