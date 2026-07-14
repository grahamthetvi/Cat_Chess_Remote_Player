<#
.SYNOPSIS
    Whitelisted Cat Chess launch / status helper for the arcade portal.
.DESCRIPTION
    Reads scripts/arcade.config.ps1 only. Never accepts an executable path from
    the HTTP client. Outputs a single JSON object on stdout.
.PARAMETER Action
    status  - report whether the configured game process is running
    launch  - start the game if needed and focus its window
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('status', 'launch')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$GamePath = $null
$GameArgs = ''
$DemoMode = $false

$GameConfigPath = Join-Path $PSScriptRoot 'arcade.config.ps1'
if (Test-Path -LiteralPath $GameConfigPath) {
    . $GameConfigPath
}

function Write-JsonResult {
    param([hashtable]$Result)
    [Console]::Out.Write(($Result | ConvertTo-Json -Compress))
}

function Get-GameProcessName {
    param([string]$Path)
    if ([string]::IsNullOrWhiteSpace($Path)) {
        return $null
    }
    return [System.IO.Path]::GetFileNameWithoutExtension($Path)
}

function Find-GameProcess {
    param([string]$Path)
    $name = Get-GameProcessName -Path $Path
    if (-not $name) {
        return $null
    }
    return Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
}

function Focus-GameWindow {
    param($Process)
    if (-not $Process) {
        return $false
    }

    $Process.Refresh()
    $timeout = 15
    $counter = 0
    while (-not $Process.MainWindowHandle -and $counter -lt $timeout) {
        Start-Sleep -Seconds 1
        $Process.Refresh()
        $counter++
    }

    if (-not $Process.MainWindowHandle) {
        return $false
    }

    $FocusAssembly = @"
using System;
using System.Runtime.InteropServices;
public class Win32FocusLaunch {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
    Add-Type -TypeDefinition $FocusAssembly -ErrorAction SilentlyContinue
    [Win32FocusLaunch]::ShowWindow($Process.MainWindowHandle, 3) | Out-Null
    [Win32FocusLaunch]::SetForegroundWindow($Process.MainWindowHandle) | Out-Null
    return $true
}

if ([string]::IsNullOrWhiteSpace($GamePath)) {
    Write-JsonResult @{
        ok = $false
        running = $false
        configured = $false
        error = 'No game path configured. Copy arcade.config.example.ps1 to arcade.config.ps1 and set $GamePath.'
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $GamePath -PathType Leaf)) {
    Write-JsonResult @{
        ok = $false
        running = $false
        configured = $true
        path = $GamePath
        error = "Game executable not found: $GamePath"
    }
    exit 0
}

$existing = Find-GameProcess -Path $GamePath
$running = $null -ne $existing

if ($Action -eq 'status') {
    Write-JsonResult @{
        ok = $true
        running = $running
        configured = $true
        path = $GamePath
        processName = (Get-GameProcessName -Path $GamePath)
    }
    exit 0
}

# Action: launch
if ($running) {
    $focused = Focus-GameWindow -Process $existing
    Write-JsonResult @{
        ok = $true
        running = $true
        configured = $true
        launched = $false
        focused = $focused
        path = $GamePath
        message = if ($focused) { 'Game already running; window focused.' } else { 'Game already running; window focus skipped.' }
    }
    exit 0
}

$started = Start-Process -FilePath $GamePath -ArgumentList $GameArgs -PassThru
$focused = Focus-GameWindow -Process $started
Write-JsonResult @{
    ok = $true
    running = $true
    configured = $true
    launched = $true
    focused = $focused
    path = $GamePath
    message = if ($focused) { 'Game launched and focused.' } else { 'Game launched; window focus pending.' }
}
exit 0
