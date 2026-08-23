[CmdletBinding()]
param(
  [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Repair', 'Uninstall')]
  [string]$Action = 'Status',
  [string]$ConfigPath,
  [string]$TaskName = 'Deft Hermes Agent Channel',
  [string]$ServiceRoot = (Join-Path $env:LOCALAPPDATA 'Deft\hermes-channel')
)

$ErrorActionPreference = 'Stop'
$runnerSource = Join-Path $PSScriptRoot 'run-hermes-channel-service.ps1'
$bridgeSource = Join-Path $PSScriptRoot 'hermes-agent-channel-bridge.mjs'
$runnerTarget = Join-Path $ServiceRoot 'run-hermes-channel-service.ps1'
$bridgeTarget = Join-Path $ServiceRoot 'hermes-agent-channel-bridge.mjs'
$configTarget = Join-Path $ServiceRoot 'service.env'
$requiredKeys = @(
  'DEFT_CHANNEL_URL',
  'DEFT_CHANNEL_TOKEN',
  'DEFT_EMPLOYEE_SLUG',
  'HERMES_API_URL',
  'HERMES_API_KEY'
)

function Get-ConfigKeys([string]$Path) {
  $keys = @{}
  Get-Content -LiteralPath $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $parts = $line -split '=', 2
    if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      throw "Invalid config entry in $Path"
    }
    $keys[$parts[0]] = $parts[1]
  }
  return $keys
}

function Assert-Config([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { throw "Config file not found: $Path" }
  $values = Get-ConfigKeys $Path
  $missing = $requiredKeys | Where-Object { -not $values[$_] }
  if ($missing) { throw "Config is missing: $($missing -join ', ')" }
  if ($values.DEFT_CHANNEL_URL -notmatch '^https?://') { throw 'DEFT_CHANNEL_URL must be an HTTP(S) URL.' }
  if ($values.HERMES_API_URL -notmatch '^https?://') { throw 'HERMES_API_URL must be an HTTP(S) URL.' }
}

function Protect-Config([string]$Path) {
  $userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  & icacls.exe $Path /inheritance:r /grant:r "*$($userSid):(F)" '*S-1-5-18:(F)' | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Could not protect service config: $Path" }
}

function Get-ServiceProcess {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -like "*$bridgeTarget*"
  }
}

function Get-ServiceSupervisorProcess {
  Get-CimInstance Win32_Process | Where-Object {
    $_.Name -in @('powershell.exe', 'pwsh.exe') -and $_.CommandLine -like "*$runnerTarget*"
  }
}

function Stop-ServiceProcesses {
  # Stop the bridge before its supervisor, then stop the supervisor before it
  # can restart the bridge with environment values cached before an upgrade.
  Get-ServiceProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Get-ServiceSupervisorProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
}

switch ($Action) {
  'Install' {
    if (-not $ConfigPath) { throw 'Install requires -ConfigPath.' }
    $resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
    Assert-Config $resolvedConfig

    # Upgrades must replace the running copy as well as the files. Otherwise the
    # old supervisor keeps the mutex and the newly registered task exits idle.
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-ServiceProcesses
    for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
      $existingTask = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      if (
        (-not $existingTask -or [string]$existingTask.State -ne 'Running') -and
        @(Get-ServiceProcess).Count -eq 0 -and
        @(Get-ServiceSupervisorProcess).Count -eq 0
      ) {
        break
      }
      Start-Sleep -Milliseconds 250
    }
    Start-Sleep -Seconds 1

    New-Item -ItemType Directory -Force -Path $ServiceRoot | Out-Null
    Copy-Item -LiteralPath $runnerSource -Destination $runnerTarget -Force
    Copy-Item -LiteralPath $bridgeSource -Destination $bridgeTarget -Force
    Copy-Item -LiteralPath $resolvedConfig -Destination $configTarget -Force
    Protect-Config $configTarget

    $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument (
      '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ServiceRoot "{1}"' -f $runnerTarget, $ServiceRoot
    )
    $logonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
      -RepetitionInterval (New-TimeSpan -Minutes 5)
    $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit (New-TimeSpan -Days 3650) -MultipleInstances IgnoreNew -StartWhenAvailable `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
      -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger @($logonTrigger, $watchdogTrigger) `
      -Settings $settings -Principal $principal -Description 'Runs the Deft Hermes Agent Channel bridge.' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Installed and started '$TaskName'."
  }
  'Start' {
    Start-ScheduledTask -TaskName $TaskName
    Write-Output "Started '$TaskName'."
  }
  'Stop' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-ServiceProcesses
    Write-Output "Stopped '$TaskName'."
  }
  'Status' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $info = if ($task) { Get-ScheduledTaskInfo -TaskName $TaskName } else { $null }
    $processes = @(Get-ServiceProcess)
    $logPath = Join-Path $ServiceRoot 'service.log'
    $healthPath = Join-Path $ServiceRoot 'health.json'
    $logItem = Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue
    $healthItem = Get-Item -LiteralPath $healthPath -ErrorAction SilentlyContinue
    $health = if ($healthItem) {
      try { Get-Content -LiteralPath $healthPath -Raw | ConvertFrom-Json } catch { $null }
    } else { $null }
    $taskState = if ($task) { [string]$task.State } else { 'NotInstalled' }
    $logAgeSeconds = if ($logItem) {
      [Math]::Round(((Get-Date) - $logItem.LastWriteTime).TotalSeconds)
    } else { $null }
    $healthAgeSeconds = if ($health -and $health.checked_at) {
      [Math]::Round(((Get-Date) - [datetime]$health.checked_at).TotalSeconds)
    } else { $null }
    $semanticallyHealthy = $health -and $health.state -eq 'healthy' -and $healthAgeSeconds -le 180
    [pscustomobject]@{
      Installed = [bool]$task
      Healthy = [bool]($task -and $taskState -eq 'Running' -and $processes.Count -eq 1 -and $semanticallyHealthy)
      TaskState = $taskState
      ProcessCount = $processes.Count
      LastRunTime = $info.LastRunTime
      LastTaskResult = $info.LastTaskResult
      ConfigPresent = Test-Path -LiteralPath $configTarget
      LastLogWriteTime = $logItem.LastWriteTime
      LogAgeSeconds = $logAgeSeconds
      RuntimeState = if ($health) { $health.state } else { 'unknown' }
      ProtocolVersion = if ($health) { $health.protocol_version } else { $null }
      AdapterVersion = if ($health) { $health.adapter_version } else { $null }
      ServerRelease = if ($health) { $health.server_release } else { $null }
      LastErrorCode = if ($health) { $health.last_error_code } else { $null }
      LastError = if ($health) { $health.last_error } else { $null }
      HealthAgeSeconds = $healthAgeSeconds
      LastLogLine = if ($logItem) { Get-Content -LiteralPath $logPath -Tail 1 } else { $null }
    }
  }
  'Repair' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $task) { throw "'$TaskName' is not installed. Run Install first." }
    Assert-Config $configTarget
    $healthPath = Join-Path $ServiceRoot 'health.json'
    $health = if (Test-Path -LiteralPath $healthPath) {
      try { Get-Content -LiteralPath $healthPath -Raw | ConvertFrom-Json } catch { $null }
    } else { $null }
    $healthIsFresh = $health -and $health.state -eq 'healthy' -and ((Get-Date) - [datetime]$health.checked_at).TotalSeconds -le 180
    if ([string]$task.State -ne 'Running' -or @(Get-ServiceProcess).Count -ne 1 -or -not $healthIsFresh) {
      Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
      Stop-ServiceProcesses
      Start-ScheduledTask -TaskName $TaskName
      Write-Output "Repaired and started '$TaskName'."
    } else {
      Write-Output "'$TaskName' is healthy; no repair needed."
    }
  }
  'Uninstall' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Stop-ServiceProcesses
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ServiceRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Output "Removed '$TaskName'."
  }
}
