# Install Sunshine (winget) + moonlight-web-stream release binary, then register MoonlightWeb as NSSM service.
# Run in Admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File "C:\Users\addis\Downloads\Cat_Chess_Remote_Player\scripts\install-stream-stack.ps1"

$ErrorActionPreference = "Stop"

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script in an Administrator PowerShell."
}

function Find-Nssm {
  $wingetRoot = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  $win64 = Get-ChildItem $wingetRoot -Filter "nssm.exe" -Recurse -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '\\win64\\' } |
    Select-Object -First 1 -ExpandProperty FullName
  if ($win64) { return $win64 }
  foreach ($c in @((Get-Command nssm.exe -ErrorAction SilentlyContinue).Source, "C:\Tools\nssm\nssm.exe")) {
    if ($c -and (Test-Path $c)) { return $c }
  }
  throw "nssm.exe not found. Install with: winget install NSSM.NSSM"
}

Write-Host "=== 1) Install Sunshine ===" -ForegroundColor Cyan
winget install --id LizardByte.Sunshine -e --accept-package-agreements --accept-source-agreements --disable-interactivity
Start-Sleep -Seconds 2
$sunshineExe = @(
  "$env:ProgramFiles\Sunshine\sunshine.exe",
  "${env:ProgramFiles(x86)}\Sunshine\sunshine.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $sunshineExe) {
  Write-Host "Sunshine may still be finishing install. Check Start Menu for Sunshine after reboot if missing." -ForegroundColor Yellow
} else {
  Write-Host "Sunshine found: $sunshineExe" -ForegroundColor Green
  $svc = Get-Service sunshine -ErrorAction SilentlyContinue
  if ($svc -and $svc.Status -ne "Running") {
    Start-Service sunshine -ErrorAction SilentlyContinue
  }
}

Write-Host "=== 2) Download moonlight-web-stream release ===" -ForegroundColor Cyan
$dest = "C:\Tools\moonlight-web"
$zip = "$env:TEMP\moonlight-web-windows.zip"
$url = "https://github.com/MrCreativ3001/moonlight-web-stream/releases/download/v2.10.0/moonlight-web-x86_64-pc-windows-gnu.zip"
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
$extract = "$env:TEMP\moonlight-web-extract"
if (Test-Path $extract) { Remove-Item $extract -Recurse -Force }
Expand-Archive -Path $zip -DestinationPath $extract -Force

# Zip layout can be nested; find web-server.exe
$webServer = Get-ChildItem $extract -Recurse -Filter "web-server.exe" | Select-Object -First 1
if (-not $webServer) { throw "web-server.exe not found in release zip" }

# Prefer keeping the folder that contains web-server.exe as the install root
$payloadRoot = $webServer.Directory.FullName
Write-Host "Payload root: $payloadRoot"
robocopy $payloadRoot $dest /E /NFL /NDL /NJH /NJS /nc /ns /np | Out-Null
$webServerInstalled = Join-Path $dest "web-server.exe"
if (-not (Test-Path $webServerInstalled)) { throw "Failed to install web-server.exe to $dest" }
Write-Host "moonlight-web installed: $webServerInstalled" -ForegroundColor Green

# Loopback-only bind so Cloudflare/portal owns public access
$serverDir = Join-Path $dest "server"
New-Item -ItemType Directory -Force -Path $serverDir | Out-Null
$configPath = Join-Path $serverDir "config.json"
# Required fields: first_login_create_admin / first_login_assign_global_hosts (no serde defaults)
@"
{
  "web_server": {
    "bind_address": "127.0.0.1:8080",
    "url_path_prefix": "/stream",
    "first_login_create_admin": true,
    "first_login_assign_global_hosts": true
  }
}
"@ | Set-Content -Path $configPath -Encoding ASCII
Write-Host "Wrote $configPath (bind 127.0.0.1:8080, url_path_prefix /stream)"

Write-Host "=== 3) Register MoonlightWeb NSSM service ===" -ForegroundColor Cyan
$Nssm = Find-Nssm
$ServiceName = "MoonlightWeb"

if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
  sc.exe stop $ServiceName | Out-Null
  Start-Sleep -Seconds 2
  sc.exe delete $ServiceName | Out-Null
  Start-Sleep -Seconds 2
}

$p = Start-Process -FilePath $Nssm -ArgumentList @("install", $ServiceName, $webServerInstalled) -Wait -PassThru -NoNewWindow
if ($p.ExitCode -ne 0) { throw "nssm install MoonlightWeb failed: $($p.ExitCode)" }

Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppDirectory", $dest) -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "DisplayName", "Moonlight Web Stream Bridge") -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "Description", "moonlight-web-stream on 127.0.0.1:8080 for cozy arcade") -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "Start", "SERVICE_AUTO_START") -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppStdout", (Join-Path $dest "moonlight-web.out.log")) -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppStderr", (Join-Path $dest "moonlight-web.err.log")) -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppRotateFiles", "1") -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppExit", "Default", "Restart") -Wait -NoNewWindow | Out-Null
Start-Process -FilePath $Nssm -ArgumentList @("set", $ServiceName, "AppRestartDelay", "5000") -Wait -NoNewWindow | Out-Null

sc.exe start $ServiceName | Out-Null
Start-Sleep -Seconds 4

Write-Host ""
Write-Host "=== Status ===" -ForegroundColor Cyan
Get-Service sunshine, MoonlightWeb, Cloudflared, CozyArcadePortal -ErrorAction SilentlyContinue |
  Format-Table Status, Name, DisplayName -AutoSize

try {
  $code = (Invoke-WebRequest -Uri "http://127.0.0.1:8080/" -UseBasicParsing -TimeoutSec 5).StatusCode
  Write-Host "moonlight-web HTTP: $code" -ForegroundColor Green
} catch {
  Write-Host "moonlight-web not responding yet: $($_.Exception.Message)" -ForegroundColor Yellow
  if (Test-Path (Join-Path $dest "moonlight-web.err.log")) {
    Get-Content (Join-Path $dest "moonlight-web.err.log") -Tail 30
  }
}

Write-Host ""
Write-Host 'NEXT - manual browser pairing cannot be automated:' -ForegroundColor Yellow
Write-Host '  1. Open Sunshine UI:  https://localhost:47990  - accept cert warning, set username/password'
Write-Host '  2. Open moonlight:    http://127.0.0.1:8080  - create admin user'
Write-Host '  3. In moonlight, Add PC -> address localhost, leave port blank'
Write-Host '  4. Pair: enter the PIN shown by moonlight into Sunshine'
Write-Host '  5. Optional: install ViGEmBus from Sunshine Troubleshooting for controllers'
Write-Host '  6. Check portal:      http://127.0.0.1:3000/api/stream-status'

$applyFix = Join-Path $PSScriptRoot "apply-tunnel-video-fix.ps1"
if (Test-Path $applyFix) {
  Write-Host ""
  Write-Host "=== 4) Apply tunnel video fix (720p/WS defaults + Sunshine) ===" -ForegroundColor Cyan
  & powershell -ExecutionPolicy Bypass -File $applyFix
}
