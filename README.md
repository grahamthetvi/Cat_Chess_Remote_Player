# Addison & Elizabeth's Arcade 🐱🕹️

Welcome to the self-hosted, headless gaming appliance project! This repository contains the complete codebase, automation scripts, and systems deployment blueprint to run **Cat Chess** on an older Windows laptop acting as a headless console, streamed over WebRTC directly into standard mobile and desktop web browsers via Tailscale.

## Project Architecture & Stack

```
   ┌─────────────────────────────────────────────────────────────┐
   │                       Host Windows Laptop                   │
   │                                                             │
   │   ┌───────────────┐     ┌───────────────┐    ┌──────────┐   │
   │   │   Cat Chess   │ ──> │   Sunshine    │ ──>│ Virtual  │   │
   │   │  (3D Game)    │     │ (Host Encoder)│    │ Display  │   │
   │   └───────────────┘     └───────────────┘    └──────────┘   │
   │                                 │ (WebRTC Stream)           │
   │                                 ▼                           │
   │                       ┌──────────────────┐                  │
   │                       │  moonlight-web-  │                  │
   │                       │  stream (Port 80)│                  │
   │                       └──────────────────┘                  │
   │                                 ▲                           │
   │ ┌──────────────────────┐        │                           │
   │ │  Node.js Portal      │ ───────┼─ (Proxy to Stream)        │
   │ │  Express (Port 3000) │ ───────┘                           │
   └─└──────────────────────┘────────────────────────────────────┘
             │                                        ▲
             │ (Static Assets / HUD Panel)            │ (Encrypted Tailscale Tunnel)
             ▼                                        │
   ┌──────────────────────────────────────────────────┼──────────┐
   │                   Client Web Browser             │          │
   │                                                  │          │
   │   ┌──────────────────────────────────────────────┴──────┐   │
   │   │            Addison & Elizabeth's Arcade             │   │
   │   │  ┌──────────────────────────────────────────────┐   │   │
   │   │  │                                              │   │   │
   │   │  │              WebRTC stream canvas            │   │   │
   │   │  │              (16:9 Cozy Theme Overlay)       │   │   │
   │   │  │                                              │   │   │
   │   │  └──────────────────────────────────────────────┘   │   │
   │   └─────────────────────────────────────────────────────┘   │
   └─────────────────────────────────────────────────────────────┘
```

---

## 📦 Directory Structure

```
├── server.js                 # Express portal, auth/identity, APIs, stream proxy
├── package.json              # Node dependencies (express, ws, http-proxy-middleware)
├── data/
│   └── arcade.secrets.example.json  # Template for host secrets (copy locally)
├── public/
│   ├── index.html            # Cozy portal + co-op play UI
│   ├── style.css             # Glassmorphism, cat-themed dark mode design
│   └── app.js                # Stream, presence, notes, launch, invite controls
└── scripts/
    ├── arcade.config.example.ps1 # Template for the local Steam game path
    ├── launch-game.ps1       # Whitelisted game status/launch helper
    └── start-arcade.ps1      # PowerShell startup automation orchestrator
```

---

## 🛠️ Deployment Step-by-Step Blueprint

Follow these steps exactly to configure your Windows laptop as a dedicated, lid-closed headless game appliance.

### 1. Handling the Closed Lid Trap (Virtual Display Driver)
When a laptop lid is closed, Windows disables the physical screen, stopping the GPU from rendering 3D graphics (which breaks video encoding). We trick Windows by installing a virtual display driver.

1. **Download:** Go to the official GitHub repository for [IddSampleDriver Releases](https://github.com/ge9/IddSampleDriver/releases).
2. **Extract:** Download the latest ZIP (e.g. `IddSampleDriver.zip`) and extract it to a permanent folder on your laptop, e.g., `C:\IddSampleDriver\`.
3. **Install the Certificate:**
   * Right-click `IddSampleDriver.cer` and click **Install Certificate**.
   * Choose **Local Machine** as the store location.
   * Place the certificate in the **Trusted Root Certification Authorities** store.
4. **Install the Device Driver:**
   * Open PowerShell as **Administrator**.
   * Run the following command to install the virtual display:
     ```powershell
     pnputil /add-driver C:\IddSampleDriver\IddSampleDriver.inf /install
     ```
5. **Configure Resolution:**
   * Open the configuration file `C:\IddSampleDriver\option.txt` in Notepad.
   * Define a single line of config for a crisp 1080p 60Hz experience:
     ```text
     1920, 1080, 60
     ```
   * Open your Windows Display Settings (`Start -> Settings -> System -> Display`). You will see a new active second monitor. Keep it set to "Extend these displays" or, when the lid is closed, it will automatically become the active primary screen.

---

### 2. Configure Windows Power Management
We must prevent the laptop from sleeping or hibernating when the lid is closed.

1. Press `Win + R`, type `control`, and press Enter to open the classic **Control Panel**.
2. Navigate to **Hardware and Sound** -> **Power Options**.
3. In the left-hand column, click **Choose what closing the lid does**.
4. Configure the lid options:
   * **When I close the lid (On battery):** Select **Do Nothing**.
   * **When I close the lid (Plugged in):** Select **Do Nothing**.
5. Click **Save changes**.
6. Back in **Power Options**, click **Change plan settings** next to your active power plan, select **Change advanced power settings**:
   * Set **Sleep -> Sleep after** to **Never** (both Battery & Plugged in).
   * Set **Sleep -> Allow hybrid sleep** to **Off**.
   * Set **PCI Express -> Link State Power Management** to **Off** (ensures your GPU runs at full power).

---

### 3. Protect Battery Longevity (Swell Prevention)
Since the laptop sits plugged into AC power 24/7, keeping the battery charged at 100% will cause heat-induced swelling. We must cap the battery charge limit to 50%-60%.

* **For Dell Laptops:**
  * Restart and press `F2` to enter **BIOS Setup**.
  * Go to **Power Management** -> **Primary Battery Charge Configuration**.
  * Change setting to **Custom** and set **Start Charging: 50%** and **Stop Charging: 60%**.
* **For Lenovo Laptops:**
  * Open **Lenovo Vantage** (pre-installed or download from Windows Store).
  * Go to **Power Settings** and enable **Conservation Mode** (automatically limits charge to 60%).
* **For HP / ASUS / Acer Laptops:**
  * Boot into BIOS (`F10`, `F2` or `Del`) and look for **Battery Health Manager**, **ASUS Battery Health Charging**, or **Battery Care Function**. Cap the limit to **60%** or select "Maximum Lifespan" / "Stationary Mode".

---

### 4. Set up Tailscale (Secure Mesh Network)
1. Download and install [Tailscale for Windows](https://tailscale.com/download/windows).
2. Log in with your Tailscale account.
3. Turn on Tailscale. Note your laptop's Tailscale IP address (e.g. `100.x.y.z`).
4. Install Tailscale on your mobile phones or client computers. This creates a secure, encrypted peer-to-peer connection so you can play anywhere without forwarding router ports.

---

### 5. Install Services & Server Configuration

#### A. Install Node.js
Download and run the long-term support installer (LTS) from the official [Node.js Website](https://nodejs.org/).

#### B. Setup Project Code
Place the directory `Cat_Chess_Remote_Player` in a secure location on the laptop, e.g., `C:\Cat_Chess_Remote_Player\`.

Open command prompt in the directory and install dependencies:
```bash
npm install
```

#### C. Register the Web Portal as a Persistent Service (via NSSM)
We register our Express backend as a Windows service so it runs silently in the background immediately upon boot, without requiring a user login.

1. Download [NSSM (Non-Sucking Service Manager)](https://nssm.cc/download).
2. Extract `nssm.exe` (specifically the one in the `win64` directory) to `C:\Windows\System32\` or another system folder in your PATH.
3. Open a command prompt as **Administrator** and run:
   ```cmd
   nssm install CozyArcadePortal
   ```
4. A GUI configuration window will pop up. Configure the tabs as follows:
   * **Application Tab:**
     * **Path:** Select the path to your installed `node.exe` (usually `C:\Program Files\nodejs\node.exe`).
     * **Startup directory:** Set to the workspace root: `C:\Cat_Chess_Remote_Player`.
     * **Arguments:** Set to the Express file: `server.js`.
   * **Details Tab:**
     * **Display name:** `Addison & Elizabeth's Cozy Arcade Portal`
     * **Startup type:** `Automatic`
   * **Environment Tab:** Set the portal configuration (optional if using `data/arcade.secrets.json`):
     ```text
     PORT=3000
     STREAM_TARGET=http://127.0.0.1:8080
     ARCADE_ACCESS_TOKEN=replace-with-a-long-random-secret
     ALLOWED_EMBED_ORIGINS=https://www.example.com,https://example.com
     DISCORD_WEBHOOK_URL=
     PUBLIC_PLAY_URL=https://arcade.example.com/play
     ```
   Prefer putting the access token, security question keywords, and Discord webhook in
   `data/arcade.secrets.json` on the host (see section 6). `ALLOWED_EMBED_ORIGINS` is optional.
   When it is unset, the portal can only be framed by pages served from the portal's own origin.
   Add only the complete origins of websites that should be allowed to iframe the arcade.
5. Click **Install service**.
6. Start the service by running:
   ```cmd
   net start CozyArcadePortal
   ```

Now, the portal is running. You can verify it by opening `http://localhost:3000` or `http://[Tailscale-IP]:3000` in your web browser.

---

### 6. Secrets, Access Control, and HTTPS

Secrets **never go through Git**. The Windows host keeps the real file; your development machine only needs the committed example (or an optional dummy copy for local unlock testing).

On the **host laptop**:

```powershell
Copy-Item .\data\arcade.secrets.example.json .\data\arcade.secrets.json
notepad .\data\arcade.secrets.json
```

Fill in:

| Field | Purpose |
| --- | --- |
| `accessToken` | Shared unlock secret (same role as `ARCADE_ACCESS_TOKEN`) |
| `securityQuestion` | Shown only for unknown IPs |
| `acceptedKeywords` | Normalized keywords that count as a correct answer (e.g. `park`, `trail`) |
| `discordWebhookUrl` | Optional Discord invite / bridge-online notifications |
| `publicPlayUrl` | Link included in Discord invites |

`data/arcade.secrets.json`, `known-ips.json`, `session-note.json`, and `audit.log` are gitignored. On a Linux/dev checkout, either leave secrets unset for open local UI work, or create a **dummy** `data/arcade.secrets.json`. If you must copy the real host file to another machine, use Tailscale/`scp`/USB — never commit it.

Environment variables still override the secrets file when set (`ARCADE_ACCESS_TOKEN`, `DISCORD_WEBHOOK_URL`, `PUBLIC_PLAY_URL`). Generate a strong token with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

When a token is set (env or secrets file), unlock is required. After unlock, unknown IPs answer the security question (keyword match), then choose **Liz** or **Addison**. That IP→name mapping is remembered in `data/known-ips.json`. One-time links such as `https://arcade.example.com/?access_token=YOUR_TOKEN` still exchange for a 30-day `HttpOnly` cookie, then continue to identity.

`/api/health` stays public and returns only `{"status":"healthy"}`. Portal pages, `/play`, `/stream`, and the other APIs require access (and identity where applicable). Failed unlocks are rate-limited and written to `data/audit.log`.

#### Private Tailscale HTTPS (recommended)

Tailscale encrypts tailnet traffic, but direct visits to Node still use a plain `http://` browser origin. For a browser-trusted HTTPS URL without exposing port 3000, bind Node to loopback and let Tailscale Serve terminate TLS:

```text
BIND_HOST=127.0.0.1
TRUST_PROXY=loopback
```

Then on the Windows host:

```powershell
tailscale serve --https=443 http://127.0.0.1:3000
```

Open the HTTPS URL printed by Tailscale. This remains tailnet-only unless you separately enable Funnel. Do not enable Funnel merely for convenience: it makes the service internet-reachable, so enable the token gate first and understand the exposure.

#### Public website or custom domain

Use Caddy (or another TLS reverse proxy) in front of Node, and keep Node private to the host:

```text
BIND_HOST=127.0.0.1
TRUST_PROXY=loopback
ARCADE_ACCESS_TOKEN=replace-with-a-long-random-secret
```

Example Caddyfile for a domain whose DNS points to this machine:

```caddyfile
arcade.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

Caddy obtains and renews certificates and proxies HTTP and WebSocket upgrades. Do not forward Node's port 3000 through the router or firewall; publish only Caddy's HTTPS port. `TRUST_PROXY=loopback` lets Express recognize Caddy's forwarded HTTPS scheme so the session cookie gets its `Secure` flag. If the reverse proxy is on another host, set `TRUST_PROXY` to that proxy's specific IP address or CIDR rather than trusting all forwarded headers.

---

### 7. Configure the Cat Chess Steam Location
`start-arcade.ps1` reads the game executable from `scripts\arcade.config.ps1` each time the orchestrator boots. This local file is intentionally ignored by Git so a machine-specific Steam library path is never committed.

On the Windows machine that has Cat Chess installed:

1. In Steam, open **Library** → right-click **Cat Chess** → **Manage** → **Browse local files**.
2. In the folder that opens, locate the game's `.exe` file. Steam libraries normally place it below `steamapps\common`, for example:
   ```text
   C:\Program Files (x86)\Steam\steamapps\common\Cat Chess\CatChess.exe
   D:\SteamLibrary\steamapps\common\Cat Chess\CatChess.exe
   ```
   Use the filename shown in the folder if it differs from `CatChess.exe`.
3. Copy the template and edit the new local config:
   ```powershell
   Copy-Item .\scripts\arcade.config.example.ps1 .\scripts\arcade.config.ps1
   notepad .\scripts\arcade.config.ps1
   ```
4. Set `$GamePath` to the full path found in step 2, then save:
   ```powershell
   $GamePath = "D:\SteamLibrary\steamapps\common\Cat Chess\CatChess.exe"
   ```

If the config file, path, or executable is missing, the orchestrator logs a clear warning and continues to start supporting services, but skips the game launch. It never substitutes another program in normal operation. For a deliberate no-game startup test only, set `$DemoMode = $true` in the local config; that explicitly launches Notepad.

### 8. Install Sunshine & Stream Bridge

1. **Install Sunshine:** Download and install [Sunshine](https://github.com/LizardByte/Sunshine/releases). Configure it to run on Windows Startup.
2. **Install Stream Bridge:** Download and run [moonlight-web-stream](https://github.com/MrCreativ3001/moonlight-web-stream) (usually on port 8080 or dockerized). Pair/configure it with Sunshine before opening the portal; the portal does not configure Sunshine or create Moonlight pairings.
3. **Automate boot sequence:**
   Set the PowerShell script `scripts/start-arcade.ps1` to run on user login.
   * Press `Win + R`, type `shell:startup`, and press Enter.
   * Create a shortcut to the PowerShell script in this folder:
     * Right-click -> **New** -> **Shortcut**.
     * Paste this command:
       ```cmd
       powershell.exe -ExecutionPolicy Bypass -File "C:\Cat_Chess_Remote_Player\scripts\start-arcade.ps1"
       ```
     * Name the shortcut `Start Arcade`.

#### Verify the streaming stack

With Sunshine and `moonlight-web-stream` running on the host, first open the bridge directly at `http://127.0.0.1:8080/` and complete any pairing or stream setup it requires. Then start this portal and check:

```text
http://localhost:3000/api/stream-status
```

It returns `available: true`, the bridge HTTP status, and probe latency when the configured `STREAM_TARGET` is reachable. The portal displays the same result in its **Stream Bridge** panel and only starts the default `/stream/` iframe after that check succeeds. `STREAM_HEALTH_TIMEOUT_MS` (default `3000`) can be raised for a slow-starting bridge.

The portal deliberately embeds the official Moonlight web page rather than attempting its own WebRTC signaling or input protocol. Direct WebRTC/player controls were removed because `moonlight-web-stream` owns a version-specific signaling and input flow; use the controls on the embedded Moonlight page for mouse, touch, keyboard, and gamepad support.

### Cat Chess split-screen co-op (two remote players)

Cat Chess Steam split-screen is **one game on the host** with **two local controllers**. The portal does **not** exclusive-lock the stream: both of you should open `/play` and watch the same desktop.

1. Install [ViGEmBus](https://github.com/ViGEm/ViGEmBus/releases) on the Windows host so Sunshine can expose virtual Xbox pads.
2. Prefer Xbox-style Bluetooth/USB controllers. On each phone/laptop, pair **one** controller before connecting the stream.
3. In Steam, avoid Steam Input collapsing both pads into a single device for Cat Chess (prefer the game’s default / Xbox controller path).
4. Confirm Windows **Settings → Devices → Game Controllers** (or `joy.cpl`) shows **two** controllers when both Moonlight clients are connected with pads.
5. Use **Start Cat Chess** in the portal (calls `scripts/launch-game.ps1`) so the game is running and focused on the virtual display.
6. Both click **Connect Stream**. Play split-screen PvP as if you were on the couch.

If browser dual-client input is flaky, use **native Moonlight apps** against the same Sunshine host for the video/input path, and keep this portal for unlock, presence, launch, notes, and Discord invites.

### Portal co-op features

- **Presence:** header shows who is currently on the arcade (Liz / Addison heartbeats).
- **Co-op checklist:** unlocked, bridge healthy, game running, both present.
- **Session note:** shared sticky text for save slots / whose turn (`GET`/`PUT /api/notes`).
- **Discord invite:** `POST /api/notify/invite` (requires webhook in secrets/env; rate-limited).
- **Stream quality tips:** Smooth / Balanced / Pretty presets store a preference in `localStorage` and show Moonlight settings guidance (they do not re-encode video themselves).
- **Audit log:** `GET /api/audit` (authenticated) returns recent unlock/identify/launch/invite/note events without raw tokens.

---

## 🎮 Play Game
Once everything is running:
1. Open the browser on your phone, tablet, or desktop connected to Tailscale.
2. Navigate to `http://[Laptop-Tailscale-IP]:3000` (or `/play`).
3. Unlock with the access token, complete identity (Liz or Addison), then use **Start Cat Chess** if needed.
4. Click **Connect Stream** or **Start Stream**.
5. Attach a controller per player for split-screen. Enjoy **Cat Chess**! 🐱🐾

## 🌐 Connect the Arcade to a Website
Use the dedicated play URL for a button, card, or navigation link on your
website:

```html
<a href="https://arcade.example.com/play">Play Cat Chess</a>
```

For an in-page player, configure the portal host with the website's origin
before starting Node:

```text
ALLOWED_EMBED_ORIGINS=https://www.example.com
ARCADE_ACCESS_TOKEN=replace-with-a-long-random-secret
```

Then embed the lightweight player. `embed=1` removes the portal header,
sidebar, and footer while retaining the stream launcher and HUD controls:

```html
<iframe
  src="https://arcade.example.com/play?embed=1"
  title="Play Cat Chess"
  allow="autoplay; gamepad; fullscreen; clipboard-read; clipboard-write"
  allowfullscreen
  style="width: 100%; aspect-ratio: 16 / 9; border: 0;"
></iframe>
```

The portal must be reachable by the website visitor. A Tailscale-only address
works for people on the same tailnet; a public website needs a separately
secured public route or reverse proxy. If the parent website uses HTTPS, serve
the arcade over HTTPS too—browsers block an insecure (`http`) iframe inside an
HTTPS page. Restart the portal after changing `ALLOWED_EMBED_ORIGINS`.

The token gate works most reliably when the website and arcade are same-site
subdomains (for example, `www.example.com` and `arcade.example.com`). Browsers
may block the arcade session cookie as a third-party cookie when an unrelated
domain embeds it. For unrelated domains, use the `/play` link to open the
arcade in its own tab instead of relying on an iframe.
