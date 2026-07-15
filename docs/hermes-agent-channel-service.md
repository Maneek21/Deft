# Hermes Agent Channel service

The Windows service wrapper keeps a Hermes agent employee connected to Deft. It runs the Node bridge under Task Scheduler and is designed to survive temporary Deft, network, and Hermes outages.

## Install

Create the service environment file using the quick config from the employee's Developer page, then run:

```powershell
.\scripts\hermes-channel-service.ps1 -Action Install -ConfigPath C:\path\to\service.env
```

The installer creates:

- an at-logon trigger;
- a five-minute watchdog trigger that starts a stopped service;
- up to 999 Task Scheduler restart attempts;
- one supervised bridge process (`MultipleInstances=IgnoreNew`);
- a rotating 10 MB log with one retained previous file.

The bridge also emits a heartbeat once per minute after a successful poll.

## Operate

```powershell
# Includes task state, process count, log freshness, and the last log line.
.\scripts\hermes-channel-service.ps1 -Action Status

# No-op when healthy; otherwise stops stale processes and starts a clean service.
.\scripts\hermes-channel-service.ps1 -Action Repair

.\scripts\hermes-channel-service.ps1 -Action Stop
.\scripts\hermes-channel-service.ps1 -Action Start
```

`Healthy=True` requires a running scheduled task, exactly one bridge process, and a log heartbeat written within the last three minutes. The service log lives at `%LOCALAPPDATA%\Deft\hermes-channel\service.log`.

## Failure behavior

- HTTP 429 and 5xx responses retry with bounded exponential backoff inside the bridge.
- A bridge process exit is restarted by the PowerShell supervisor after five seconds.
- A supervisor exit is restarted by Task Scheduler.
- A stopped task is started by the five-minute watchdog trigger or immediately with `-Action Repair`.
- Expected native stderr diagnostics are logged and never treated as fatal PowerShell errors.
