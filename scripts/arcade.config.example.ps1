# Copy this file to arcade.config.ps1, then set the full path to Cat Chess.
# The local arcade.config.ps1 file is gitignored so each Windows host can use
# its own Steam library location.

# Steam's default library location:
$GamePath = "C:\Program Files (x86)\Steam\steamapps\common\Cat Chess\CatChess.exe"

# Optional arguments passed to Cat Chess on launch.
$GameArgs = ""

# Set to $true only to test startup without Cat Chess installed. This launches
# Notepad explicitly; normal missing-game behavior is to warn and skip launch.
$DemoMode = $false
