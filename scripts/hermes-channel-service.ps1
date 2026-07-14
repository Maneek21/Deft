[CmdletBinding()]
param(
  [ValidateSet('Install', 'Start', 'Stop', 'Status', 'Uninstall')]
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

switch ($Action) {
  'Install' {
    if (-not $ConfigPath) { throw 'Install requires -ConfigPath.' }
    $resolvedConfig = (Resolve-Path -LiteralPath $ConfigPath).Path
    Assert-Config $resolvedConfig
    New-Item -ItemType Directory -Force -Path $ServiceRoot | Out-Null
    Copy-Item -LiteralPath $runnerSource -Destination $runnerTarget -Force
    Copy-Item -LiteralPath $bridgeSource -Destination $bridgeTarget -Force
    Copy-Item -LiteralPath $resolvedConfig -Destination $configTarget -Force
    Protect-Config $configTarget

    $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $taskAction = New-ScheduledTaskAction -Execute $powershell -Argument (
      '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -ServiceRoot "{1}"' -f $runnerTarget, $ServiceRoot
    )
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -RestartCount 20 -RestartInterval (New-TimeSpan -Minutes 1) `
      -ExecutionTimeLimit (New-TimeSpan -Days 3650) -MultipleInstances IgnoreNew -StartWhenAvailable `
      -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) `
      -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $trigger `
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
    Get-ServiceProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Write-Output "Stopped '$TaskName'."
  }
  'Status' {
    $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    $info = if ($task) { Get-ScheduledTaskInfo -TaskName $TaskName } else { $null }
    $processes = @(Get-ServiceProcess)
    [pscustomobject]@{
      Installed = [bool]$task
      TaskState = if ($task) { [string]$task.State } else { 'NotInstalled' }
      ProcessCount = $processes.Count
      LastRunTime = $info.LastRunTime
      LastTaskResult = $info.LastTaskResult
      ConfigPresent = Test-Path -LiteralPath $configTarget
    }
  }
  'Uninstall' {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-ServiceProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ServiceRoot -Recurse -Force -ErrorAction SilentlyContinue
    Write-Output "Removed '$TaskName'."
  }
}
