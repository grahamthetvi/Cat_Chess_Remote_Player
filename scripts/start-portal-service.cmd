@echo off
REM Production launcher for CozyArcadePortal (used by NSSM).
REM Secrets stay in data\arcade.secrets.json — do not put the access token here.

set PORT=3000
set BIND_HOST=127.0.0.1
set TRUST_PROXY=loopback
set PUBLIC_MODE=1
set STREAM_TARGET=http://127.0.0.1:8080
set PUBLIC_PLAY_URL=https://lizandadd.com/play

"C:\Program Files\nodejs\node.exe" server.js
