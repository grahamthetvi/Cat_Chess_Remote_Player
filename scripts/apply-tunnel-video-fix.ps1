# Re-apply Cloudflare Tunnel video fixes to moonlight-web + Sunshine, then restart services.
# Run in Admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File "...\scripts\apply-tunnel-video-fix.ps1"

$ErrorActionPreference = "Stop"

$principal = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw "Run this script in an Administrator PowerShell."
}

$MoonlightRoot = "C:\Tools\moonlight-web"
$SunshineConf = Join-Path $env:ProgramFiles "Sunshine\config\sunshine.conf"

if (-not (Test-Path $MoonlightRoot)) {
  throw "moonlight-web not found at $MoonlightRoot"
}

Write-Host "=== 1) Deploy moonlight-web patches from repo ===" -ForegroundColor Cyan
$PatchesDir = Join-Path $PSScriptRoot "moonlight-patches"
$patchMap = @{
  "default_settings.js" = "static\default_settings.js"
  "settings_menu.js"    = "static\component\settings_menu.js"
  "api.js"              = "static\api.js"
  "login.js"            = "static\component\modal\login.js"
  "modal-index.js"      = "static\component\modal\index.js"
}
foreach ($srcName in $patchMap.Keys) {
  $src = Join-Path $PatchesDir $srcName
  $dest = Join-Path $MoonlightRoot $patchMap[$srcName]
  if (-not (Test-Path -LiteralPath $src)) {
    throw "Patch file not found: $src"
  }
  $destDir = Split-Path -Parent $dest
  if (-not (Test-Path $destDir)) {
    throw "moonlight-web directory not found: $destDir"
  }
  Copy-Item -LiteralPath $src -Destination $dest -Force
  Write-Host "Copied $srcName -> $dest"
}

Write-Host "=== 2) Role defaults in data.json ===" -ForegroundColor Cyan
$dataPath = Join-Path $MoonlightRoot "server\data.json"
# PowerShell Set-Content -Encoding utf8 writes a BOM, which moonlight-web
# cannot parse ("expected value at line 1 column 1"). Write via Node instead.
$tmpJs = Join-Path $env:TEMP "arcade-patch-moonlight-data.js"
@'
const fs = require("fs");
const path = process.argv[2];
const data = JSON.parse(fs.readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
// moonlight-web stores version as a STRING ("3"). A numeric 3 makes serde
// miss the v3 variant and fail with "missing field `role`" on users.
if (data.version != null) data.version = String(data.version);
for (const role of Object.values(data.roles || {})) {
  role.default_settings = Object.assign({}, role.default_settings, {
    dataTransport: "websocket",
    videoCodec: "h264",
    videoSize: "custom",
    videoSizeCustom: { width: 960, height: 540 },
    bitrate: 1500,
    fps: 30,
    hdr: false,
    canvasRenderer: true,
    videoFrameQueueSize: 5
  });
  role.permissions = Object.assign({}, role.permissions, {
    maximum_bitrate_kbps: 2000,
    allow_codec_h264: true,
    allow_codec_h265: false,
    allow_codec_av1: false,
    allow_hdr: false,
    allow_transport_webrtc: false,
    allow_transport_websockets: true
  });
}
fs.writeFileSync(path, JSON.stringify(data, null, 4) + "\n", "utf8");
console.log("Updated role tunnel defaults (UTF-8 no BOM)");
'@ | Set-Content -Path $tmpJs -Encoding ascii
& node $tmpJs $dataPath
Remove-Item $tmpJs -Force -ErrorAction SilentlyContinue
Write-Host "Updated role tunnel defaults in $dataPath"

Write-Host "=== 3) Sunshine conf (QSV / FEC) ===" -ForegroundColor Cyan
$sunshineBody = @"
# Cozy Arcade — tuned for moonlight-web over Cloudflare Tunnel (WebSocket).
# Sunshine <-> moonlight-web is local UDP; the browser path is the bottleneck.

encoder = quicksync
hevc_mode = 0
av1_mode = 0
qsv_preset = faster
qsv_coder = cavlc
fec_percentage = 10
"@
[System.IO.File]::WriteAllText($SunshineConf, $sunshineBody.Trim() + "`n")
Write-Host "Wrote $SunshineConf"

Write-Host "=== 4) Restart services ===" -ForegroundColor Cyan
foreach ($name in @("MoonlightWeb", "SunshineService", "sunshine", "CozyArcadePortal")) {
  $svc = Get-Service -Name $name -ErrorAction SilentlyContinue
  if ($svc) {
    Write-Host "Restarting $name..."
    Restart-Service -Name $name -Force -ErrorAction SilentlyContinue
  }
}
Start-Sleep -Seconds 5

Get-Service MoonlightWeb, CozyArcadePortal, Cloudflared, SunshineService, sunshine -ErrorAction SilentlyContinue |
  Format-Table Name, Status -AutoSize

Write-Host "=== Verify ===" -ForegroundColor Cyan
& curl.exe -sI --max-redirs 0 "http://127.0.0.1:8080/stream/" | Select-Object -First 8
Write-Host ""
Write-Host "DONE. On the client browser:" -ForegroundColor Green
Write-Host "  1. Hard-refresh https://lizandadd.com/play (Ctrl+Shift+R)"
Write-Host "  2. Or open DevTools console and run: localStorage.removeItem('mlSettings')"
Write-Host "  3. Connect stream and confirm host log shows 960x540 (not 1920x1080 / 1280x720)"
  Write-Host "  4. Prefer top-level /stream/ if iframe still blanks"
  Write-Host "  5. For Moonlight auto-login: set moonlightUsername/moonlightPassword in data/arcade.secrets.json and restart CozyArcadePortal"
