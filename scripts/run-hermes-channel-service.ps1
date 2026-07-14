[CmdletBinding()]
param(
  [string]$ServiceRoot = (Join-Path $env:LOCALAPPDATA 'Deft\hermes-channel'),
  [int]$RestartDelaySeconds = 5
)

$ErrorActionPreference = 'Stop'
$configPath = Join-Path $ServiceRoot 'service.env'
$bridgePath = Join-Path $ServiceRoot 'hermes-agent-channel-bridge.mjs'
$logPath = Join-Path $ServiceRoot 'service.log'
$mutex = [Threading.Mutex]::new($false, 'Local\DeftHermesAgentChannel')

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

  $node = (Get-Command node.exe -ErrorAction Stop).Source
  while ($true) {
    "$(Get-Date -Format o) starting Hermes channel bridge" | Add-Content -LiteralPath $logPath -Encoding utf8
    & $node $bridgePath 2>&1 | ForEach-Object {
      "$_" | Add-Content -LiteralPath $logPath -Encoding utf8
    }
    $bridgeExitCode = $LASTEXITCODE
    "$(Get-Date -Format o) bridge exited with code $bridgeExitCode; restarting in $RestartDelaySeconds seconds" |
      Add-Content -LiteralPath $logPath -Encoding utf8
    Start-Sleep -Seconds $RestartDelaySeconds
  }
} catch {
  "$(Get-Date -Format o) service failed: $($_.Exception.Message)" | Add-Content -LiteralPath $logPath -Encoding utf8
  exit 1
} finally {
  try { $mutex.ReleaseMutex() } catch {}
  $mutex.Dispose()
}
