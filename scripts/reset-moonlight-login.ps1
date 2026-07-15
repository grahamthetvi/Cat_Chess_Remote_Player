# Reset Moonlight-web login without dumping secrets.
# - Default: set a new password for an existing user (keeps hosts / pairing).
# - -RecreateFirstLogin: wipe users so the next UI login creates a fresh admin.
#
# Run elevated (MoonlightWeb service control):
#   powershell -ExecutionPolicy Bypass -File scripts\reset-moonlight-login.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\reset-moonlight-login.ps1 -RecreateFirstLogin

param(
  [switch]$RecreateFirstLogin
)

$ErrorActionPreference = "Stop"
$dataPath = "C:\Tools\moonlight-web\server\data.json"
$cfgPath = "C:\Tools\moonlight-web\server\config.json"
$node = Get-Command node.exe -ErrorAction SilentlyContinue
if (-not $node) {
  throw "node.exe is required"
}

function Stop-Moonlight {
  Write-Host "Stopping MoonlightWeb..."
  sc.exe stop MoonlightWeb | Out-Null
  Start-Sleep -Seconds 2
  Get-Process web-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1
}

function Start-Moonlight {
  Write-Host "Starting MoonlightWeb..."
  sc.exe start MoonlightWeb | Out-Null
  Start-Sleep -Seconds 4
  Get-Service MoonlightWeb | Format-Table Name, Status -AutoSize
}

function Invoke-MoonlightDataEdit([string]$Mode, [string]$Username, [string]$Password) {
  $js = @'
const fs = require("fs");
const crypto = require("crypto");
const dataPath = process.argv[2];
const mode = process.argv[3];
const username = process.argv[4] || "";
const password = process.argv[5] || "";
const raw = fs.readFileSync(dataPath, "utf8");
const data = JSON.parse(raw);
const users = data.users || {};
const names = Object.values(users).map((u) => u.name);

if (mode === "list") {
  process.stdout.write(JSON.stringify({ names }));
  process.exit(0);
}

if (mode === "recreate") {
  data.users = {};
  if (data.hosts && typeof data.hosts === "object") {
    for (const host of Object.values(data.hosts)) {
      host.owner = null;
    }
  }
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 4) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ ok: true, mode }));
  process.exit(0);
}

if (mode === "password") {
  if (!password) {
    console.error("empty password");
    process.exit(2);
  }
  const entry = Object.values(users).find((u) => u.name === username);
  if (!entry) {
    console.error("user not found");
    process.exit(3);
  }
  const iterations = 600000;
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
  entry.password = {
    salt: salt.toString("hex"),
    hash: hash.toString("hex"),
    iterations
  };
  fs.writeFileSync(dataPath, JSON.stringify(data, null, 4) + "\n", "utf8");
  process.stdout.write(JSON.stringify({ ok: true, mode, username }));
  process.exit(0);
}

console.error("unknown mode");
process.exit(1);
'@
  $tmp = Join-Path $env:TEMP "ml-edit-data.js"
  Set-Content -Path $tmp -Value $js -Encoding ascii
  if ($Mode -eq "password") {
    return & node.exe $tmp $dataPath $Mode $Username $Password
  }
  return & node.exe $tmp $dataPath $Mode $Username
}

# Keep first-login flags enabled for recreate flow
if (Test-Path $cfgPath) {
  & node.exe -e @"
const fs=require('fs');
const p=process.argv[1];
const c=JSON.parse(fs.readFileSync(p,'utf8'));
c.web_server=c.web_server||{};
c.web_server.bind_address=c.web_server.bind_address||'127.0.0.1:8080';
c.web_server.url_path_prefix=c.web_server.url_path_prefix||'/stream';
c.web_server.first_login_create_admin=true;
c.web_server.first_login_assign_global_hosts=true;
fs.writeFileSync(p, JSON.stringify(c,null,2)+'\n');
"@ $cfgPath
}

if (-not (Test-Path $dataPath)) {
  throw "Moonlight data not found at $dataPath"
}

$listJson = Invoke-MoonlightDataEdit -Mode "list"
$list = $listJson | ConvertFrom-Json
Write-Host "Existing Moonlight username(s):"
if (-not $list.names -or $list.names.Count -eq 0) {
  Write-Host "  (none - next /stream/ login creates admin)"
} else {
  foreach ($n in $list.names) { Write-Host "  - $n" }
}

Stop-Moonlight

$backup = "$dataPath.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
Copy-Item $dataPath $backup -Force
Write-Host "Backup: $backup"

if ($RecreateFirstLogin -or -not $list.names -or $list.names.Count -eq 0) {
  if ($list.names -and $list.names.Count -gt 0) {
    Write-Host "Wiping users so the next Moonlight login creates a new admin..."
    Invoke-MoonlightDataEdit -Mode "recreate" | Out-Null
  }
  Start-Moonlight
  Write-Host @"

Done. Open http://127.0.0.1:8080/stream/ (or https://lizandadd.com/stream/ after unlock)
and create a new username/password on first login.
This is NOT the Sunshine username/password.
"@
  exit 0
}

$targetName = $list.names[0]
if (@($list.names).Count -gt 1) {
  $targetName = Read-Host "Username to reset"
  if ($list.names -notcontains $targetName) {
    Start-Moonlight
    throw "Username not found: $targetName"
  }
}

$pass1 = Read-Host "New Moonlight password" -AsSecureString
$pass2 = Read-Host "Confirm password" -AsSecureString
$bstr1 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass1)
$bstr2 = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($pass2)
try {
  $p1 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr1)
  $p2 = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr2)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr1)
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr2)
}
if ($p1 -cne $p2) {
  Start-Moonlight
  throw "Passwords do not match"
}
if ([string]::IsNullOrEmpty($p1)) {
  Start-Moonlight
  throw "Password cannot be empty"
}

Invoke-MoonlightDataEdit -Mode "password" -Username $targetName -Password $p1 | Out-Null
$p1 = $null
$p2 = $null

Start-Moonlight

Write-Host @"

Password updated for Moonlight user '$targetName'.
Log in at https://lizandadd.com/play -> Connect Stream (or /stream/) with that username.
Do not use the Sunshine admin credentials unless they are the same by coincidence.
"@
