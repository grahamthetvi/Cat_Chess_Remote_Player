# Restart CozyArcadePortal so it picks up server.js health-check fix.
$ErrorActionPreference = "Stop"
Restart-Service CozyArcadePortal -Force
Start-Sleep -Seconds 4
Get-Service CozyArcadePortal | Format-Table Name, Status -AutoSize
& curl.exe -s "http://127.0.0.1:3000/api/health"
Write-Host ""
