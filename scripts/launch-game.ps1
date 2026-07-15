<#
.SYNOPSIS
    Whitelisted Cat Chess launch / status helper for the arcade portal.
.DESCRIPTION
    Reads scripts/arcade.config.ps1 only. Never accepts an executable path from
    the HTTP client. Outputs a single JSON object on stdout.

    Prefers Steam -applaunch when $SteamAppId is set (required for Steam titles
    started by the LocalSystem portal service). Falls back to the raw exe.

    When running as LocalSystem, starts the process in the active console session
    via CreateProcessAsUser so Sunshine can capture it.
.PARAMETER Action
    status           - report whether the configured game process is running
    launch           - start the game if needed and focus its window
    dismiss-dialogs  - click "No" on Yes/No launch popups for ~90s (internal)
#>
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('status', 'launch', 'dismiss-dialogs')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'
$GamePath = $null
$GameArgs = ''
$DemoMode = $false
$SteamAppId = $null
$SteamPath = 'C:\Program Files (x86)\Steam\steam.exe'

$GameConfigPath = Join-Path $PSScriptRoot 'arcade.config.ps1'
if (Test-Path -LiteralPath $GameConfigPath) {
    . $GameConfigPath
}

function Write-JsonResult {
    param([hashtable]$Result)
    [Console]::Out.Write(($Result | ConvertTo-Json -Compress))
}

# Internal helper: click "No" on launch popups while the game starts.
if ($Action -eq 'dismiss-dialogs') {
    $ErrorActionPreference = 'SilentlyContinue'
    $deadline = (Get-Date).AddSeconds(90)
    while ((Get-Date) -lt $deadline) {
        try {
            if (-not ('ArcadeDialogClicker' -as [type])) {
                Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ArcadeDialogClicker {
    public const int IDNO = 7;
    public const uint BM_CLICK = 0x00F5;
    public const int GW_CHILD = 5;
    public const int GW_HWNDNEXT = 2;
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr hDlg, int nIDDlgItem);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, int uCmd);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    static bool LooksLikeNo(string text) {
        if (string.IsNullOrWhiteSpace(text)) return false;
        text = text.Trim();
        return text.Equals("No", StringComparison.OrdinalIgnoreCase)
            || text.Equals("&No", StringComparison.OrdinalIgnoreCase);
    }
    static string GetText(IntPtr hWnd) {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
    static string GetClass(IntPtr hWnd) {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
    static bool ClickChildNoButtons(IntPtr parent) {
        IntPtr child = GetWindow(parent, GW_CHILD);
        while (child != IntPtr.Zero) {
            string cls = GetClass(child);
            string text = GetText(child);
            if (cls == "Button" && LooksLikeNo(text)) {
                SetForegroundWindow(parent);
                PostMessage(child, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                return true;
            }
            if (ClickChildNoButtons(child)) return true;
            child = GetWindow(child, GW_HWNDNEXT);
        }
        return false;
    }
    public static bool ClickNoButton() {
        bool clicked = false;
        EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
            if (!IsWindowVisible(hWnd)) return true;
            string cls = GetClass(hWnd);
            if (cls == "#32770") {
                IntPtr noBtn = GetDlgItem(hWnd, IDNO);
                if (noBtn != IntPtr.Zero) {
                    SetForegroundWindow(hWnd);
                    PostMessage(noBtn, BM_CLICK, IntPtr.Zero, IntPtr.Zero);
                    clicked = true;
                    return false;
                }
            }
            if (ClickChildNoButtons(hWnd)) {
                clicked = true;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        return clicked;
    }
}
"@
            }
            [void][ArcadeDialogClicker]::ClickNoButton()
        } catch {}
        Start-Sleep -Milliseconds 700
    }
    exit 0
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

function Wait-ForGameProcess {
    param(
        [string]$Path,
        [int]$TimeoutSeconds = 45
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $proc = Find-GameProcess -Path $Path
        if ($proc) { return $proc }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return $null
}

function Start-DialogDismissHelper {
    # Runs on the interactive desktop so it can see/click the Yes/No popup.
    $self = $PSCommandPath
    if ([string]::IsNullOrWhiteSpace($self)) {
        $self = Join-Path $PSScriptRoot 'launch-game.ps1'
    }
    $argLine = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$self`" -Action dismiss-dialogs"
    if (Test-RunningAsSystem) {
        Ensure-NativeLaunchType
        [void][ArcadeNativeLaunch]::Launch("$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe", $argLine)
    } else {
        Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList $argLine -WindowStyle Hidden | Out-Null
    }
}

function Test-RunningAsSystem {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return $id.IsSystem
}

function Get-LaunchTarget {
    # Steam titles must go through steam.exe -applaunch or they often exit immediately.
    if (-not $DemoMode -and $SteamAppId -and (Test-Path -LiteralPath $SteamPath -PathType Leaf)) {
        return @{
            Path = $SteamPath
            Arguments = "-applaunch $SteamAppId"
            Mode = 'steam'
        }
    }
    return @{
        Path = $GamePath
        Arguments = $GameArgs
        Mode = 'direct'
    }
}

function Ensure-NativeLaunchType {
    if ('ArcadeNativeLaunch' -as [type]) {
        return
    }

    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ArcadeNativeLaunch {
    public const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    public const int STARTF_USESHOWWINDOW = 0x00000001;
    public const short SW_SHOWNORMAL = 1;
    public const int TokenPrimary = 1;
    public const int SecurityIdentification = 2;
    public const int MAXIMUM_ALLOWED = 0x02000000;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct STARTUPINFO {
        public int cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    [DllImport("kernel32.dll")]
    public static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", SetLastError = true)]
    public static extern bool WTSQueryUserToken(uint sessionId, out IntPtr phToken);

    [DllImport("advapi32.dll", SetLastError = true)]
    public static extern bool DuplicateTokenEx(
        IntPtr hExistingToken,
        int dwDesiredAccess,
        IntPtr lpTokenAttributes,
        int ImpersonationLevel,
        int TokenType,
        out IntPtr phNewToken);

    [DllImport("userenv.dll", SetLastError = true)]
    public static extern bool CreateEnvironmentBlock(out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    public static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern bool CreateProcessAsUser(
        IntPtr hToken,
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr hObject);

    public static int Launch(string applicationPath, string arguments) {
        uint sessionId = WTSGetActiveConsoleSessionId();
        if (sessionId == 0xFFFFFFFF) {
            throw new InvalidOperationException("No active console session is available on the host.");
        }

        IntPtr userToken;
        if (!WTSQueryUserToken(sessionId, out userToken)) {
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(),
                "Could not get the logged-on desktop user token. Sign into the arcade laptop, then try again.");
        }

        IntPtr primaryToken = IntPtr.Zero;
        IntPtr environment = IntPtr.Zero;
        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();

        try {
            if (!DuplicateTokenEx(userToken, MAXIMUM_ALLOWED, IntPtr.Zero, SecurityIdentification, TokenPrimary, out primaryToken)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "DuplicateTokenEx failed.");
            }

            CreateEnvironmentBlock(out environment, primaryToken, false);

            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            si.lpDesktop = @"winsta0\default";
            si.dwFlags = STARTF_USESHOWWINDOW;
            si.wShowWindow = SW_SHOWNORMAL;

            string command = "\"" + applicationPath + "\"";
            if (!string.IsNullOrWhiteSpace(arguments)) {
                command += " " + arguments;
            }
            StringBuilder cmdLine = new StringBuilder(command);
            string workDir = System.IO.Path.GetDirectoryName(applicationPath);

            if (!CreateProcessAsUser(
                primaryToken,
                null,
                cmdLine,
                IntPtr.Zero,
                IntPtr.Zero,
                false,
                CREATE_UNICODE_ENVIRONMENT,
                environment,
                workDir,
                ref si,
                out pi)) {
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser failed.");
            }

            return pi.dwProcessId;
        }
        finally {
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            if (environment != IntPtr.Zero) DestroyEnvironmentBlock(environment);
            if (primaryToken != IntPtr.Zero) CloseHandle(primaryToken);
            if (userToken != IntPtr.Zero) CloseHandle(userToken);
        }
    }
}
"@
}

function Start-GameProcess {
    param(
        [string]$Path,
        [string]$Arguments
    )

    if ([string]::IsNullOrWhiteSpace($Arguments)) {
        return Start-Process -FilePath $Path -PassThru
    }
    return Start-Process -FilePath $Path -ArgumentList $Arguments -PassThru
}

function Start-GameInInteractiveSession {
    param(
        [string]$Path,
        [string]$Arguments
    )

    Ensure-NativeLaunchType
    [void][ArcadeNativeLaunch]::Launch($Path, $Arguments)
    # For Steam -applaunch the returned PID is steam/steamurl, not CatChess.
    return (Wait-ForGameProcess -Path $GamePath -TimeoutSeconds 60)
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

    if (-not ('Win32FocusLaunch' -as [type])) {
        Add-Type -TypeDefinition @"
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
    }
    [Win32FocusLaunch]::ShowWindow($Process.MainWindowHandle, 3) | Out-Null
    [Win32FocusLaunch]::SetForegroundWindow($Process.MainWindowHandle) | Out-Null
    return $true
}

if ($DemoMode) {
    $GamePath = "$env:WINDIR\System32\notepad.exe"
    $GameArgs = ''
    $SteamAppId = $null
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
$target = Get-LaunchTarget

if ($Action -eq 'status') {
    Write-JsonResult @{
        ok = $true
        running = $running
        configured = $true
        path = $GamePath
        processName = (Get-GameProcessName -Path $GamePath)
        demoMode = [bool]$DemoMode
        launchMode = $target.Mode
        steamAppId = $SteamAppId
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

try {
    $asSystem = Test-RunningAsSystem
    Start-DialogDismissHelper
    if ($asSystem) {
        $started = Start-GameInInteractiveSession -Path $target.Path -Arguments $target.Arguments
        if (-not $started) {
            Write-JsonResult @{
                ok = $false
                running = $false
                configured = $true
                path = $GamePath
                launchMode = $target.Mode
                error = "Steam launch was sent ($($target.Mode)), but Cat Chess did not start within 60s. On the host: keep the Windows user signed in, ensure Steam is running/logged in, then try again."
            }
            exit 0
        }
        $focused = Focus-GameWindow -Process $started
        Write-JsonResult @{
            ok = $true
            running = $true
            configured = $true
            launched = $true
            focused = $focused
            path = $GamePath
            via = "console-session/$($target.Mode)"
            message = if ($focused) { 'Game launched and focused.' } else { 'Game launched on the host desktop.' }
        }
        exit 0
    }

    Start-GameProcess -Path $target.Path -Arguments $target.Arguments | Out-Null
    $started = if ($target.Mode -eq 'steam') {
        Wait-ForGameProcess -Path $GamePath -TimeoutSeconds 60
    } else {
        Wait-ForGameProcess -Path $GamePath -TimeoutSeconds 20
    }

    if (-not $started) {
        Write-JsonResult @{
            ok = $false
            running = $false
            configured = $true
            path = $GamePath
            launchMode = $target.Mode
            error = "Launch was sent via $($target.Mode), but Cat Chess did not appear. Check Steam is logged in on the host."
        }
        exit 0
    }

    $focused = Focus-GameWindow -Process $started
    Write-JsonResult @{
        ok = $true
        running = $true
        configured = $true
        launched = $true
        focused = $focused
        path = $GamePath
        via = $target.Mode
        message = if ($focused) { 'Game launched and focused.' } else { 'Game launched; window focus pending.' }
    }
    exit 0
} catch {
    Write-JsonResult @{
        ok = $false
        running = $false
        configured = $true
        path = $GamePath
        error = $_.Exception.Message
    }
    exit 0
}
