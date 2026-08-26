# Legacy Hermes Agent Channel bridge service

This Windows service wrapper is the rollback adapter for a Hermes agent employee.
Fresh profiles use the native `deft-platform` plugin and direct HTTP MCP from
the immutable integration bundle linked on the employee's Developer page.

Run this bridge only during an explicit rollback. Stop and disable
`deft-platform`, revoke its credentials, issue fresh matched fallback
credentials, and never run the bridge and native adapter for the same employee.
The fallback bundle remains pinned to the running Deft release and Agent Channel
contract.

## Install

After completing the rollback steps, create the service environment file using
the template in the matched bundle's `legacy/bridge/README.md`, then run:

```powershell
.\scripts\hermes-channel-service.ps1 -Action Install -ConfigPath C:\path\to\service.env
```

The installer creates:

- an at-logon trigger;
- a five-minute watchdog trigger that starts a stopped service;
- up to 999 Task Scheduler restart attempts;
- one supervised bridge process (`MultipleInstances=IgnoreNew`);
- a rotating 10 MB log with one retained previous file.

The bridge also writes `health.json` after successful protocol negotiation and each poll. A process that is merely alive but cannot consume work is not healthy.

## Operate

```powershell
# Includes semantic runtime state, versions, process state, and the last log line.
.\scripts\hermes-channel-service.ps1 -Action Status

# No-op when healthy; otherwise stops stale processes and starts a clean service.
.\scripts\hermes-channel-service.ps1 -Action Repair

.\scripts\hermes-channel-service.ps1 -Action Stop
.\scripts\hermes-channel-service.ps1 -Action Start
```

`Healthy=True` requires a running scheduled task, exactly one bridge process, and a fresh `health.json` whose state is `healthy`. The status output includes adapter, protocol, and server-release information plus a bounded error code. The service log lives at `%LOCALAPPDATA%\Deft\hermes-channel\service.log`.

## Failure behavior

- HTTP 429 and 5xx responses retry with bounded exponential backoff inside the bridge.
- Protocol or capability mismatches fail closed before the first event poll with `INCOMPATIBLE_CHANNEL`.
- Exit code 78 stops the tight supervisor restart loop; install the fallback assets from the bundle matched to the running Deft release.
- A bridge process exit is restarted by the PowerShell supervisor after five seconds.
- A supervisor exit is restarted by Task Scheduler.
- A stopped task is started by the five-minute watchdog trigger or immediately with `-Action Repair`.
- Expected native stderr diagnostics are logged and never treated as fatal PowerShell errors.
