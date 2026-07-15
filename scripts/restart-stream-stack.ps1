# Restart portal + moonlight after proxy / transport fixes.
$ErrorActionPreference = "Stop"

Write-Host "Restarting MoonlightWeb..."
Restart-Service MoonlightWeb -Force
Start-Sleep -Seconds 4

Write-Host "Restarting CozyArcadePortal..."
Restart-Service CozyArcadePortal -Force
Start-Sleep -Seconds 4

Get-Service MoonlightWeb, CozyArcadePortal, Cloudflared, SunshineService -ErrorAction SilentlyContinue |
  Format-Table Name, Status -AutoSize

Write-Host "--- moonlight /stream/ ---"
& curl.exe -sI --max-redirs 0 "http://127.0.0.1:8080/stream/" | Select-Object -First 8
Write-Host "--- portal health ---"
& curl.exe -s "http://127.0.0.1:3000/api/health"
Write-Host ""
