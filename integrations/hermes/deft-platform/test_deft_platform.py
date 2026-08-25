import asyncio
import importlib.util
import os
import pathlib
import sys
import types
import unittest
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


class FakeContext:
    def __init__(self):
        self.registration = None

    def register_platform(self, **kwargs):
        self.registration = kwargs


class FakeConfig:
    def __init__(self, extra=None):
        self.extra = extra or {}


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
            adapter = registration["adapter_factory"](config)
            self.assertNotIn("responses", adapter.channel_url)
            self.assertTrue(asyncio.run(adapter.connect()))
            asyncio.run(adapter.disconnect())
            self.assertFalse(adapter._running)
        finally:
            platform_registry.unregister("deft")


if __name__ == "__main__":
    unittest.main()
