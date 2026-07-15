$ErrorActionPreference = "Stop"

$cfgPath = "C:\Tools\moonlight-web\server\config.json"
$json = @"
{
  "web_server": {
    "bind_address": "127.0.0.1:8080",
    "url_path_prefix": "/stream",
    "first_login_create_admin": true,
    "first_login_assign_global_hosts": true
  }
}
"@
[System.IO.File]::WriteAllText($cfgPath, $json.Trim() + "`n")
Write-Host "Wrote $cfgPath"

sc.exe stop MoonlightWeb | Out-Null
Start-Sleep -Seconds 2
Get-Process web-server -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1
sc.exe start MoonlightWeb
Start-Sleep -Seconds 5

Get-Service MoonlightWeb, CozyArcadePortal | Format-Table Name, Status -AutoSize
Write-Host "--- err log ---"
Get-Content "C:\Tools\moonlight-web\moonlight-web.err.log" -Tail 20 -ErrorAction SilentlyContinue
Write-Host "--- /stream/ ---"
& curl.exe -sI --max-redirs 0 "http://127.0.0.1:8080/stream/" | Select-Object -First 12

Restart-Service CozyArcadePortal -Force
Start-Sleep -Seconds 3
Write-Host "--- portal ---"
& curl.exe -s "http://127.0.0.1:3000/api/health"
Write-Host ""
