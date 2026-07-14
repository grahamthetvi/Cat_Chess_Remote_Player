<#
.SYNOPSIS
    Addison & Elizabeth's Cozy Arcade - Headless Boot Orchestrator
.DESCRIPTION
    Automates the startup flow for the dedicated self-hosted game streaming appliance.
    Verifies that the Node.js Express Portal and Sunshine Streaming Server are running, 
    and launches the target game on the virtual display interface with window focus.
.NOTES
    Configure the installed game's executable in arcade.config.ps1. Copy
    arcade.config.example.ps1 to arcade.config.ps1 before first use.
#>

# --- USER CONFIGURATION ---
$GamePath = $null                               # Set by arcade.config.ps1
$GameArgs = ""                                  # Optional launch arguments, set in config
$DemoMode = $false                              # Explicit opt-in only; launches Notepad when true
$ExpressServiceName = "CozyArcadePortal"       # Name of the NSSM Windows service
$PortalPort = 3000                              # Express portal port

# Load machine-specific game settings when present. This config is intentionally gitignored.
$GameConfigPath = Join-Path $PSScriptRoot "arcade.config.ps1"
if (Test-Path $GameConfigPath) {
    try {
        . $GameConfigPath
        Write-Host "Loaded arcade game configuration from: $GameConfigPath" -ForegroundColor Cyan
    } catch {
        Write-Host "Could not load arcade game configuration: $($_.Exception.Message)" -ForegroundColor Red
    }
} else {
    Write-Host "Game configuration not found: $GameConfigPath. Game launch will be skipped." -ForegroundColor Yellow
}

# --- LOGGING UTILITY ---
function Write-Log {
    param (
        [string]$Message,
        [string]$Level = "INFO"
    )
    $Timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $Color = "White"
    switch ($Level) {
        "INFO"    { $Color = "Cyan" }
        "WARNING" { $Color = "Yellow" }
        "ERROR"   { $Color = "Red" }
        "SUCCESS" { $Color = "Green" }
    }
    Write-Host "[$Timestamp] [$Level] $Message" -ForegroundColor $Color
}

Write-Log "Initializing Cozy Arcade Headless Orchestrator..." "INFO"

# --- 1. VERIFY IDD SAMPLE DRIVER (VIRTUAL DISPLAY) ---
# When physical laptop lid is closed, IddSampleDriver must present a fake monitor
Write-Log "Checking Virtual Display Driver (IddSampleDriver)..." "INFO"
$DriverCheck = Get-PnpDevice -FriendlyName "*IddSampleDevice*" -ErrorAction SilentlyContinue
if ($DriverCheck -and $DriverCheck.Status -eq "OK") {
    Write-Log "IddSampleDevice Virtual Display Driver detected and active." "SUCCESS"
} else {
    Write-Log "IddSampleDevice driver not found. If physical lid is closed, Windows may stop rendering graphics." "WARNING"
}

# --- 2. VERIFY SUNSHINE STREAMING SERVICE ---
Write-Log "Verifying Sunshine Streaming Service..." "INFO"
$SunshineProcess = Get-Process -Name "sunshine" -ErrorAction SilentlyContinue
$SunshineService = Get-Service -Name "sunshine" -ErrorAction SilentlyContinue

if ($SunshineProcess) {
    Write-Log "Sunshine is running as process (PID: $($SunshineProcess.Id))." "SUCCESS"
} elseif ($SunshineService -and $SunshineService.Status -eq "Running") {
    Write-Log "Sunshine is running as a Windows service." "SUCCESS"
} else {
    Write-Log "Sunshine is not running. Attempting to start service/process..." "WARNING"
    if ($SunshineService) {
        Start-Service -Name "sunshine" -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 5
        $SunshineService.Refresh()
        if ($SunshineService.Status -eq "Running") {
            Write-Log "Sunshine service started successfully." "SUCCESS"
        } else {
            Write-Log "Failed to start Sunshine service." "ERROR"
        }
    } else {
        # Fallback to starting executable directly
        $SunshinePath = "${env:ProgramFiles}\Sunshine\sunshine.exe"
        if (Test-Path $SunshinePath) {
            Start-Process -FilePath $SunshinePath -WindowStyle Hidden
            Start-Sleep -Seconds 5
            Write-Log "Sunshine executable launched in background." "SUCCESS"
        } else {
            Write-Log "Sunshine installation not found at standard path: $SunshinePath" "ERROR"
        }
    }
}

# --- 3. VERIFY NODE.JS WEB PORTAL SERVICE ---
Write-Log "Verifying Node.js Express Portal (Service: $ExpressServiceName)..." "INFO"
$PortalService = Get-Service -Name $ExpressServiceName -ErrorAction SilentlyContinue

if ($PortalService) {
    if ($PortalService.Status -ne "Running") {
        Write-Log "Portal service is registered but stopped. Starting service..." "WARNING"
        Start-Service -Name $ExpressServiceName
        Start-Sleep -Seconds 3
    } else {
        Write-Log "Portal service '$ExpressServiceName' is already running." "SUCCESS"
    }
} else {
    Write-Log "Portal service not registered via NSSM. Checking if Express is responsive on port $PortalPort..." "WARNING"
    try {
        $Response = Invoke-WebRequest -Uri "http://127.0.0.1:$PortalPort/api/health" -UseBasicParsing -TimeoutSec 3
        Write-Log "Express portal responded: $($Response.StatusCode)" "SUCCESS"
    } catch {
        Write-Log "Express portal is not responding. Starting Node.js server manually..." "WARNING"
        $ServerScriptPath = Join-Path $PSScriptRoot "..\server.js"
        if (Test-Path $ServerScriptPath) {
            Start-Process -FilePath "node" -ArgumentList $ServerScriptPath -WindowStyle Hidden -WorkingDirectory (Split-Path $ServerScriptPath)
            Start-Sleep -Seconds 3
            Write-Log "Node.js server process launched manually." "SUCCESS"
        } else {
            Write-Log "Could not locate server.js at: $ServerScriptPath" "ERROR"
        }
    }
}

# --- 4. LAUNCH GAME AND FORCE WINDOW FOCUS ---
if ([string]::IsNullOrWhiteSpace($GamePath)) {
    Write-Log "No game path is configured. Copy arcade.config.example.ps1 to arcade.config.ps1 and set `$GamePath. Game launch skipped." "WARNING"
} elseif (-not (Test-Path -LiteralPath $GamePath -PathType Leaf)) {
    Write-Log "Game executable not found: $GamePath. Check the Steam install path in arcade.config.ps1. Game launch skipped." "WARNING"
}

if (-not [string]::IsNullOrWhiteSpace($GamePath) -and (Test-Path -LiteralPath $GamePath -PathType Leaf)) {
    # Start the game process
    Write-Log "Launching game target: $GamePath" "INFO"
    $GameProcess = Start-Process -FilePath $GamePath -ArgumentList $GameArgs -PassThru

    # Wait for window handle to instantiate
    Write-Log "Waiting for game window to initialize..." "INFO"
    $Timeout = 15 # seconds
    $Counter = 0
    while (-not $GameProcess.MainWindowHandle -and $Counter -lt $Timeout) {
        Start-Sleep -Seconds 1
        $GameProcess.Refresh()
        $Counter++
    }

    # Win32 API window focus integration
    if ($GameProcess.MainWindowHandle) {
        Write-Log "Game window handle resolved: $($GameProcess.MainWindowHandle). Focus targetting..." "INFO"
    
        # Inline C# type definitions for raw user32 calls
        $FocusAssembly = @"
    using System;
    using System.Runtime.InteropServices;
    public class Win32Focus {
        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        public static extern bool SetForegroundWindow(IntPtr hWnd);
        
        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    }
"@
        Add-Type -TypeDefinition $FocusAssembly -ErrorAction SilentlyContinue
        
        # ShowWindow parameters: 3 = Maximize / ShowMaximized
        [Win32Focus]::ShowWindow($GameProcess.MainWindowHandle, 3) | Out-Null
        [Win32Focus]::SetForegroundWindow($GameProcess.MainWindowHandle) | Out-Null
        
        Write-Log "Game has been focused and maximized on the virtual screen display." "SUCCESS"
    } else {
        Write-Log "Game launched, but could not resolve a main window handle. Window focus adjustment skipped." "WARNING"
    }
} elseif ($DemoMode) {
    $DemoPath = "C:\Windows\System32\notepad.exe"
    if (Test-Path -LiteralPath $DemoPath -PathType Leaf) {
        Write-Log "Demo mode enabled; launching Notepad instead of Cat Chess." "WARNING"
        Start-Process -FilePath $DemoPath | Out-Null
    } else {
        Write-Log "Demo mode requested, but Notepad was not found. Demo launch skipped." "WARNING"
    }
}

Write-Log "Orchestrator boot completed. Review any warnings above for skipped components." "SUCCESS"
