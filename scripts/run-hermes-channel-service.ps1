[CmdletBinding()]
param(
  [string]$ServiceRoot = (Join-Path $env:LOCALAPPDATA 'Deft\hermes-channel'),
  [int]$RestartDelaySeconds = 5,
  [int]$MaxLogSizeMB = 10,
  [string]$MutexName,
  [string]$NodePath
)

$ErrorActionPreference = 'Stop'
$resolvedServiceRoot = [IO.Path]::GetFullPath($ServiceRoot).TrimEnd('\', '/')
if (-not $MutexName) {
  $normalizedServiceRoot = $resolvedServiceRoot.ToLowerInvariant()
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $hashBytes = $sha256.ComputeHash([Text.Encoding]::UTF8.GetBytes($normalizedServiceRoot))
  } finally {
    $sha256.Dispose()
  }
  $serviceInstanceHash = ([BitConverter]::ToString($hashBytes)).Replace('-', '').Substring(0, 16)
  $MutexName = "Local\DeftHermesAgentChannel-$serviceInstanceHash"
}
$configPath = Join-Path $ServiceRoot 'service.env'
$bridgePath = Join-Path $ServiceRoot 'hermes-agent-channel-bridge.mjs'
$logPath = Join-Path $ServiceRoot 'service.log'
$healthPath = Join-Path $ServiceRoot 'health.json'
$mutex = [Threading.Mutex]::new($false, $MutexName)

function Rotate-ServiceLog {
  if (-not (Test-Path -LiteralPath $logPath)) { return }
  $maxBytes = [Math]::Max($MaxLogSizeMB, 1) * 1MB
  if ((Get-Item -LiteralPath $logPath).Length -lt $maxBytes) { return }
  $previousLogPath = "$logPath.1"
  Remove-Item -LiteralPath $previousLogPath -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $logPath -Destination $previousLogPath -Force
}

function Write-ServiceLog([string]$Message) {
  Rotate-ServiceLog
  "$(Get-Date -Format o) $Message" | Add-Content -LiteralPath $logPath -Encoding utf8
}

try {
  if (-not $mutex.WaitOne(0)) { exit 0 }
  if (-not (Test-Path -LiteralPath $configPath)) { throw "Missing service config: $configPath" }
  if (-not (Test-Path -LiteralPath $bridgePath)) { throw "Missing bridge runtime: $bridgePath" }

  Get-Content -LiteralPath $configPath | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith('#')) { return }
    $parts = $line -split '=', 2
    if ($parts.Count -ne 2 -or $parts[0] -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
      throw "Invalid config entry in $configPath"
    }
    [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
  }
  [Environment]::SetEnvironmentVariable('DEFT_CHANNEL_HEALTH_FILE', $healthPath, 'Process')

  $node = if ($NodePath) {
    (Resolve-Path -LiteralPath $NodePath -ErrorAction Stop).Path
  } else {
    (Get-Command node.exe -ErrorAction Stop).Source
  }
  while ($true) {
    Write-ServiceLog 'starting Hermes channel bridge'

    # Native stderr contains expected retry diagnostics. Windows PowerShell turns
    # redirected stderr into ErrorRecords, so keep it non-terminating while the
    # bridge runs and let the supervisor react to the actual process exit code.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'
      & $node $bridgePath 2>&1 | ForEach-Object {
        "$_" | Add-Content -LiteralPath $logPath -Encoding utf8
      }
      $bridgeExitCode = $LASTEXITCODE
    } finally {
      $ErrorActionPreference = $previousErrorActionPreference
    }

    if ($bridgeExitCode -eq 78) {
      Write-ServiceLog 'bridge stopped because the Deft server and Hermes adapter are incompatible; install the bundle for the running Deft release'
      exit 78
    }
    Write-ServiceLog "bridge exited with code $bridgeExitCode; restarting in $RestartDelaySeconds seconds"
    Start-Sleep -Seconds $RestartDelaySeconds
  }
} catch {
  Write-ServiceLog "service failed: $($_.Exception.Message)"
  exit 1
} finally {
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
