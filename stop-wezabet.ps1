$ErrorActionPreference = "SilentlyContinue"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidsFile = Join-Path $root ".pids-wezabet.json"
$scripts = @("wezabet-live.mjs", "wezabet-chrome-live.mjs", "compare-wezabet.mjs")
$ports = @(3301, 3302, 3303)
$killed = @()

function Stop-ByPid([int]$TargetPid) {
  if ($TargetPid -le 0) { return }
  taskkill /F /PID $TargetPid 2>$null | Out-Null
  $script:killed += $TargetPid
}

function Stop-ByScript([string]$ScriptName) {
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine.ToLower().Contains($ScriptName.ToLower()) } |
    ForEach-Object {
      Stop-ByPid $_.ProcessId
      Write-Host "[stop:node] $ScriptName PID=$($_.ProcessId)"
    }
}

function PortPids([int[]]$Ports) {
  $out = @()
  foreach ($port in $Ports) {
    $lines = netstat -ano | Select-String -Pattern ":$port\s+.*LISTENING"
    foreach ($line in $lines) {
      $procId = ($line.ToString().Trim() -split "\s+")[-1]
      if ($procId -match "^\d+$") { $out += [int]$procId }
    }
  }
  return $out | Select-Object -Unique
}

if (Test-Path $pidsFile) {
  try {
    $data = Get-Content $pidsFile -Raw | ConvertFrom-Json
    foreach ($script in $scripts) {
      $tracked = $data.pids.$script
      if ($tracked) {
        Stop-ByPid ([int]$tracked)
        Write-Host "[stop:pids] $script PID=$tracked"
      }
    }
  } catch {}
}

foreach ($script in $scripts) { Stop-ByScript $script }

foreach ($procId in (PortPids $ports)) {
  if ($procId -gt 0) {
    Stop-ByPid $procId
    Write-Host "[stop:port] PID=$procId"
  }
}

$rootNorm = $root.ToLower()
Get-CimInstance Win32_Process |
  Where-Object {
    $_.Name -eq "chrome.exe" -and
    $_.CommandLine -and
    ($_.CommandLine.ToLower().Contains("wezabet-ui") -or $_.CommandLine.ToLower().Contains("wezabet-chrome-ui"))
  } |
  ForEach-Object {
    Stop-ByPid $_.ProcessId
    Write-Host "[stop:chrome] PID=$($_.ProcessId)"
  }

if (Test-Path $pidsFile) { Remove-Item $pidsFile -Force }
Write-Host "WezaBet merenje zaustavljeno. Ugaseno PID-ova: $($killed.Count)"
