import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const runnerUrl = new URL('./run-hermes-channel-service.ps1', import.meta.url);
const installerUrl = new URL('./hermes-channel-service.ps1', import.meta.url);

test('Windows Hermes channel runners isolate their mutex by service root', async () => {
  const runner = await readFile(runnerUrl, 'utf8');

  assert.match(runner, /\[string\]\$MutexName,?\s*\r?\n/);
  assert.match(runner, /GetFullPath\(\$ServiceRoot\)/);
  assert.match(runner, /SHA256\]::Create\(\)/);
  assert.match(runner, /Local\\DeftHermesAgentChannel-\$serviceInstanceHash/);
  assert.doesNotMatch(
    runner,
    /\[string\]\$MutexName\s*=\s*'Local\\DeftHermesAgentChannel'/,
  );
});

test('Windows service health compares bridge timestamps as UTC instants', async () => {
  const installer = await readFile(installerUrl, 'utf8');

  assert.match(installer, /function Get-UtcAgeSeconds/);
  assert.match(installer, /\$Timestamp -is \[datetime\]/);
  assert.match(installer, /\[DateTimeOffset\]::Parse/);
  assert.match(installer, /\[DateTimeOffset\]::UtcNow/);
  assert.doesNotMatch(installer, /\(Get-Date\) - \[datetime\]\$health\.checked_at/);
});

test('Windows service installer does not add a duration-bound repeating trigger', async () => {
  const installer = await readFile(installerUrl, 'utf8');

  assert.match(installer, /New-ScheduledTaskTrigger -AtStartup/);
  assert.match(installer, /-Trigger \$startupTrigger/);
  assert.doesNotMatch(installer, /-RepetitionInterval/);
  assert.doesNotMatch(installer, /\$watchdogTrigger/);
});

test('Windows service installer isolates the bridge from interactive-session lifetime', async () => {
  const [installer, runner] = await Promise.all([
    readFile(installerUrl, 'utf8'),
    readFile(runnerUrl, 'utf8'),
  ]);

  assert.match(installer, /WindowsIdentity\]::GetCurrent\(\)\.Name/);
  assert.match(installer, /-LogonType S4U/);
  assert.doesNotMatch(installer, /-LogonType Interactive/);
  assert.match(installer, /-NodePath "\{2\}"/);
  assert.match(runner, /\[string\]\$NodePath/);
  assert.match(runner, /Resolve-Path -LiteralPath \$NodePath/);
});
