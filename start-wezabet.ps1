$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidsFile = Join-Path $root ".pids-wezabet.json"
$stopScript = Join-Path $root "stop-wezabet.ps1"
$uiProfile = Join-Path $root "wezabet-ui"

$services = @(
  @{ Name = "3200 (bwin-live)";      Script = "bwin-live.mjs";        Port = 3200; Health = "http://localhost:3200/data"; Optional = $true },
  @{ Name = "3301 (wezabet-live)";         Script = "wezabet-live.mjs";        Port = 3301; Health = "http://localhost:3301/health" },
  @{ Name = "3303 (wezabet-chrome-live)";  Script = "wezabet-chrome-live.mjs"; Port = 3303; Health = "http://localhost:3303/health" },
  @{ Name = "3302 (compare-wezabet)";      Script = "compare-wezabet.mjs";     Port = 3302; Health = "http://localhost:3302/" }
)

$uiUrls = @(
  "http://localhost:3302/",
  "http://localhost:3301/",
  "http://localhost:3303/",
  "http://localhost:3200/"
)

function Test-Endpoint {
  param([string]$Url, [int]$TimeoutSec = 3)
  try {
    $null = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec $TimeoutSec
    return $true
  } catch { return $false }
}

function Wait-Endpoint {
  param([string]$Url, [int]$TimeoutSec = 90)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt $TimeoutSec) {
    if (Test-Endpoint -Url $Url -TimeoutSec 3) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Open-ChromeWindow {
  $chrome = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $chrome) {
    Write-Host "[ui] Chrome nije nadjen. Otvori rucno: $($uiUrls -join '  ')"
    return
  }
  $args = @("--no-first-run", "--no-default-browser-check", "--new-window", "--user-data-dir=$uiProfile") + $uiUrls
  Start-Process -FilePath $chrome -ArgumentList $args | Out-Null
  Write-Host "[ui] Chrome otvoren (compare / Node / Chrome feed / Bwin)."
}

Set-Location $root

if (Test-Path $stopScript) {
  Write-Host "[prep] Ciscenje starog WezaBet merenja..."
  & powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript
  Start-Sleep -Seconds 1
}

$env:WEZ_OPEN_UI = "0"
$started = @()
$pidMap = @{}

foreach ($svc in $services) {
  if ($svc.Optional -and (Test-Endpoint -Url $svc.Health -TimeoutSec 3)) {
    Write-Host "[skip] $($svc.Name) vec radi"
    continue
  }
  Write-Host "[start] $($svc.Name)"
  $p = Start-Process node -WorkingDirectory $root -ArgumentList $svc.Script -PassThru -WindowStyle Minimized
  $pidMap[$svc.Script] = $p.Id
  if (-not (Wait-Endpoint -Url $svc.Health -TimeoutSec 90)) {
    throw "$($svc.Name) nije postao dostupan."
  }
  $started += $svc.Name
}

$payload = [pscustomobject]@{
  startedAt = (Get-Date).ToString("o")
  root      = $root
  pids      = $pidMap
}
$payload | ConvertTo-Json -Depth 5 | Set-Content -Path $pidsFile -Encoding UTF8

Write-Host ""
Write-Host "WezaBet merenje pokrenuto:"
Write-Host " - Bwin:    http://localhost:3200/"
Write-Host " - WezaBet Node:   http://localhost:3301/"
Write-Host " - WezaBet Chrome: http://localhost:3303/"
Write-Host " - Compare:        http://localhost:3302/"

Open-ChromeWindow
