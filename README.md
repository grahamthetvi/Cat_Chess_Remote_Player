# Addison & Elizabeth's Arcade 🐱🕹️

Welcome to the self-hosted, headless gaming appliance project! This repository runs **Cat Chess** on an always-on Windows laptop and publishes it at **https://lizandadd.com** — anyone can visit the public landing page; only Liz and Addison unlock to play. Players need a normal web browser (no Tailscale or other client installs). The host reaches the internet through a **Cloudflare Tunnel** so you do not open router ports.

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
   │                       │  stream (loopback)│                 │
   │                       └──────────────────┘                  │
   │                                 ▲                           │
   │ ┌──────────────────────┐        │                           │
   │ │  Node.js Portal      │ ───────┼─ (Proxy to Stream)        │
   │ │  Express :3000       │ ───────┘                           │
   │ │  BIND 127.0.0.1      │                                    │
   └─└──────────┬───────────┘────────────────────────────────────┘
                │ cloudflared tunnel (outbound only)
                ▼
   ┌────────────────────────────────────────────────────────────┐
   │              Cloudflare (DNS + HTTPS for lizandadd.com)    │
   └────────────────────────────┬───────────────────────────────┘
                                ▼
   ┌────────────────────────────────────────────────────────────┐
   │                   Client Web Browser                       │
   │  /  public landing  ·  /play gated arcade after unlock     │
   └────────────────────────────────────────────────────────────┘
```

---

## 📦 Directory Structure

```
├── server.js                 # Express portal, auth/identity, APIs, stream proxy
├── package.json              # Node dependencies (express, ws, http-proxy-middleware)
├── data/
│   └── arcade.secrets.example.json  # Template for host secrets (copy locally)
├── public/
│   ├── landing.html          # Public brand home (no unlock)
│   ├── index.html            # Gated co-op play UI (/play)
│   ├── style.css             # Shared cozy theme + landing
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

### 4. Publish lizandadd.com (Cloudflare Tunnel)

Players should not install Tailscale. The laptop stays private on the LAN; Cloudflare Tunnel provides HTTPS for the domain without opening inbound ports (works behind CGNAT).

1. Buy/register **lizandadd.com** and add it to a Cloudflare account (update nameservers as Cloudflare instructs).
2. On the Windows host, install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/).
3. Authenticate and create a tunnel that points at the portal loopback address:

```powershell
cloudflared tunnel login
cloudflared tunnel create cozy-arcade
cloudflared tunnel route dns cozy-arcade lizandadd.com
cloudflared tunnel route dns cozy-arcade www.lizandadd.com
```

4. Configure the tunnel ingress to `http://127.0.0.1:3000` (see Cloudflare’s config file docs). Run the tunnel as a Windows service so it starts at boot:

```powershell
cloudflared service install
```

5. Do **not** publish Node port 3000, moonlight-web-stream, or Sunshine on the public internet. Keep those on loopback / LAN only.

**Optional:** Install Tailscale on the **host only** for admin SSH/`scp` to the laptop. Clients never need it.

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
     BIND_HOST=127.0.0.1
     TRUST_PROXY=loopback
     PUBLIC_MODE=1
     STREAM_TARGET=http://127.0.0.1:8080
     ARCADE_ACCESS_TOKEN=replace-with-a-long-random-secret
     PUBLIC_PLAY_URL=https://lizandadd.com/play
     ALLOWED_EMBED_ORIGINS=
     DISCORD_WEBHOOK_URL=
     ```
   Prefer putting the access token, security question keywords, and Discord webhook in
   `data/arcade.secrets.json` on the host (see section 6). `PUBLIC_MODE=1` refuses to start
   without an access token. `ALLOWED_EMBED_ORIGINS` is optional; leave empty unless you iframe
   `/play` from another origin you control.
5. Click **Install service**.
6. Start the service by running:
   ```cmd
   net start CozyArcadePortal
   ```

Verify locally with `http://127.0.0.1:3000/` (public landing) and confirm Cloudflare serves `https://lizandadd.com`.

---

### 6. Secrets, Access Control, and Public HTTPS

Secrets **never go through Git**. The Windows host keeps the real file; your development machine only needs the committed example (or an optional dummy copy for local unlock testing).

On the **host laptop**:

```powershell
Copy-Item .\data\arcade.secrets.example.json .\data\arcade.secrets.json
notepad .\data\arcade.secrets.json
```

Fill in:

| Field | Purpose |
| --- | --- |
| `accessToken` | Shared unlock secret for Liz & Addison (same role as `ARCADE_ACCESS_TOKEN`) |
| `securityQuestion` | Shown only for unknown IPs |
| `acceptedKeywords` | Normalized keywords that count as a correct answer (e.g. `park`, `trail`) |
| `discordWebhookUrl` | Optional Discord invite / bridge-online notifications |
| `publicPlayUrl` | Link included in Discord invites (`https://lizandadd.com/play`) |

`data/arcade.secrets.json`, `known-ips.json`, `session-note.json`, and `audit.log` are gitignored. On a Linux/dev checkout, either leave secrets unset for open local UI work, or create a **dummy** `data/arcade.secrets.json`. If you must copy the real host file to another machine, use a private channel (`scp`/USB/Tailscale admin) — never commit it.

Environment variables override the secrets file when set (`ARCADE_ACCESS_TOKEN`, `DISCORD_WEBHOOK_URL`, `PUBLIC_PLAY_URL`, `PUBLIC_MODE`). Generate a strong token with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

#### Couple-only gate on a public domain

- **`/`** — public landing (no cookie). Anyone can visit.
- **`/play`, `/stream`, and play APIs** — require unlock + Liz/Addison identity.
- After unlock, unknown IPs answer the security question (keyword match), then choose **Liz** or **Addison**. That IP→name mapping is remembered in `data/known-ips.json`.
- Prefer the unlock form. One-shot links such as `https://lizandadd.com/play?access_token=YOUR_TOKEN` still exchange for a 30-day `HttpOnly` cookie, then continue to identity (avoid posting long-lived token URLs in public channels).
- Failed unlocks are rate-limited and written to `data/audit.log`.
- Treat the access token like a household password: it grants interactive control of the game host through the stream.
- Rotate the token if it is ever shared beyond the two of you.

`PUBLIC_MODE=1` (recommended on the host) refuses to start if no access token is configured.

Public endpoints:

- `GET /api/health` → `{"status":"healthy"}`
- `GET /api/public-status` → awake flag only (no stream details)

#### Cloudflare Tunnel + loopback Node (recommended)

```text
BIND_HOST=127.0.0.1
TRUST_PROXY=loopback
PUBLIC_MODE=1
PUBLIC_PLAY_URL=https://lizandadd.com/play
```

`cloudflared` connects outbound to Cloudflare and proxies to `127.0.0.1:3000`. `TRUST_PROXY=loopback` lets Express honor forwarded HTTPS so session cookies get the `Secure` flag. Do not port-forward 3000/8080/Sunshine.

#### Optional private Tailscale HTTPS (admin / LAN)

For admin-only access without the public domain, bind Node to loopback and use Tailscale Serve:

```powershell
tailscale serve --https=443 http://127.0.0.1:3000
```

This remains tailnet-only unless you enable Funnel. Prefer Cloudflare Tunnel for lizandadd.com player access.

#### Optional Caddy reverse proxy

If you already terminate TLS yourself (and can open port 443 cleanly), Caddy can reverse-proxy to `127.0.0.1:3000` instead of Cloudflare Tunnel. Keep the same token gate and `PUBLIC_MODE=1`.

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

## Play Game

Once the host stack and Cloudflare Tunnel are running:

1. Open **https://lizandadd.com** in any browser (no client apps to install).
2. Tap **Enter the Arcade** (goes to `/play`). Unlock with the shared access token, answer the security question if asked, then choose **Liz** or **Addison**.
3. Use **Start Cat Chess** if the game is not already running.
4. Click **Connect Stream** / **Start Stream**. Mouse and keyboard go into the game through the embedded Moonlight page.
5. For split-screen two-player pads, attach one controller per device before connecting. Enjoy **Cat Chess**!

## Website links and embeds

The public landing already links into `/play`. For a button elsewhere:

```html
<a href="https://lizandadd.com/play">Play Cat Chess</a>
```

Prefer opening `/play` in a top-level tab. Same-origin embeds of `/play?embed=1` work when `ALLOWED_EMBED_ORIGINS` includes the parent origin; cross-site iframes may block the session cookie — use the link instead.
