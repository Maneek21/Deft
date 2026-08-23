import importlib.util
import json
import pathlib
import unittest


MODULE = pathlib.Path(__file__).with_name("__init__.py")
SPEC = importlib.util.spec_from_file_location("deft_memory_provider", MODULE)
MOD = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MOD)


class FakeProvider(MOD.DeftMemoryProvider):
    def __init__(self):
        super().__init__()
        self._enabled = True
        self.calls = []

    def _call(self, name, arguments):
        self.calls.append((name, arguments))
        if name == "platform_context":
            return {"employee": {"slug": "rita"}}
        if name == "memory_recall":
            return [{"slug": "rule", "content": "Use verified leads"}]
        return {"ok": True, "page_id": "page-1", "version": 1}


class DeftMemoryProviderTests(unittest.TestCase):
    def test_prefetch_combines_platform_and_wiki_context(self):
        provider = FakeProvider()
        provider.initialize("session-1", agent_context="primary")
        value = provider.prefetch("find qualified leads", session_id="session-1")
        self.assertIn('"slug": "rita"', value)
        self.assertIn('"slug": "rule"', value)

    def test_prefetch_large_context_remains_valid_bounded_json(self):
        provider = FakeProvider()
        provider.initialize("session-large", agent_context="primary")

        def large_call(name, _arguments):
            if name == "platform_context":
                return {
                    "org": {"name": "Deft"},
                    "relevant_wiki_snippets": [{"content": "x" * 6000}],
                    "context_packets": [{"content": "y" * 6000} for _ in range(2)],
                    "teammates": [{"name": "Person " + str(i)} for i in range(20)],
                }
            return [{"slug": f"rule-{i}", "content": "z" * 5000} for i in range(5)]

        provider._call = large_call
        value = provider.prefetch("find company policy", session_id="session-large")
        parsed = json.loads(value)

        self.assertLessEqual(len(value), MOD.MAX_PREFETCH_CHARS)
        self.assertEqual(parsed["source"], "deft")
        self.assertEqual(parsed["session_id"], "session-large")
        self.assertTrue(parsed["truncated"])
        self.assertGreaterEqual(len(parsed["wiki_results"]), 1)

    def test_builtin_memory_write_uses_stable_digest_key(self):
        provider = FakeProvider()
        provider.initialize("session-1", agent_context="primary")
        provider.on_memory_write("add", "memory", "Qualified means 100+ employees")
        first = provider.calls[-1]
        provider.on_memory_write("add", "memory", "Qualified means 100+ employees")
        second = provider.calls[-1]
        self.assertEqual(first[0], "memory_write")
        self.assertEqual(first[1]["idempotency_key"], second[1]["idempotency_key"])

    def test_subagent_does_not_write_company_memory(self):
        provider = FakeProvider()
        provider.initialize("child", agent_context="subagent")
        provider.sync_turn("work", "done", session_id="child")
        self.assertEqual(provider.calls, [])


if __name__ == "__main__":
    unittest.main()
