# Install / refresh CozyArcadePortal as a Windows service via NSSM.
# MUST run in Admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\addis\Downloads\Cat_Chess_Remote_Player\scripts\install-portal-service.ps1"

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $PSScriptRoot "start-portal-service.cmd"
$ServiceName = "CozyArcadePortal"
$DisplayName = "Addison & Elizabeth's Cozy Arcade Portal"

function Find-Nssm {
  $wingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  $win64 = Get-ChildItem $wingetRoot -Filter "nssm.exe" -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\win64\\' } |
    Select-Object -First 1 -ExpandProperty FullName
  if ($win64) { return $win64 }

  foreach ($c in @(
    (Get-Command nssm.exe -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
    "C:\Tools\nssm\nssm.exe"
  )) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  throw "nssm.exe not found. Install with: winget install NSSM.NSSM"
}

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script in an Administrator PowerShell."
}

$Nssm = Find-Nssm
Write-Host "Using NSSM: $Nssm"
Write-Host "Project:    $ProjectRoot"
Write-Host "Launcher:   $Launcher"

if (-not (Test-Path $Launcher)) { throw "Missing launcher: $Launcher" }

$secrets = Join-Path $ProjectRoot "data\arcade.secrets.json"
if (-not (Test-Path $secrets)) {
  throw "Missing $secrets. Copy from arcade.secrets.example.json and set a strong accessToken first."
}

Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -match 'server\.js' } |
  ForEach-Object {
    Write-Host "Stopping existing portal node PID $($_.ProcessId)"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Seconds 1

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  Write-Host "Removing existing service via sc.exe..."
  sc.exe stop $ServiceName | Out-Null
  Start-Sleep -Seconds 2
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
  # Wait until gone
  for ($i = 0; $i -lt 10; $i++) {
    if (-not (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
  }
}

Write-Host "Installing $ServiceName..."
$p = Start-Process -FilePath $Nssm -ArgumentList @("install", $ServiceName, $Launcher) -Wait -PassThru -NoNewWindow
if ($p.ExitCode -ne 0) { throw "nssm install failed with exit $($p.ExitCode)" }

Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppDirectory", $ProjectRoot) -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "DisplayName", $DisplayName) -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "Description", "Express arcade portal for lizandadd.com (loopback :3000)") -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "Start", "SERVICE_AUTO_START") -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppStdout", (Join-Path $ProjectRoot "data\portal-service.out.log")) -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppStderr", (Join-Path $ProjectRoot "data\portal-service.err.log")) -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppRotateFiles", "1") -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppRotateBytes", "1048576") -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppExit", "Default", "Restart") -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppRestartDelay", "5000") -Wait -NoNewWindow | Out-Null

Write-Host "Starting $ServiceName..."
sc.exe start $ServiceName | Out-Null
Start-Sleep -Seconds 4

Get-Service $ServiceName | Format-Table Status, Name, DisplayName -AutoSize

try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:3000/api/health" -TimeoutSec 5
  Write-Host "Health: $($health | ConvertTo-Json -Compress)" -ForegroundColor Green
} catch {
  Write-Host "Health check failed: $($_.Exception.Message)" -ForegroundColor Yellow
  $errLog = Join-Path $ProjectRoot "data\portal-service.err.log"
  $outLog = Join-Path $ProjectRoot "data\portal-service.out.log"
  if (Test-Path $errLog) { Write-Host "--- stderr ---"; Get-Content $errLog -Tail 40 }
  if (Test-Path $outLog) { Write-Host "--- stdout ---"; Get-Content $outLog -Tail 40 }
  throw "Service installed but portal did not respond on 127.0.0.1:3000"
}

Write-Host ""
Write-Host "Production portal is live." -ForegroundColor Cyan
Write-Host "  Local:  http://127.0.0.1:3000/"
Write-Host "  Public: https://lizandadd.com"
Write-Host "  Play:   https://lizandadd.com/play"
Write-Host ""
Write-Host "Confirm tunnel: Get-Service Cloudflared"
