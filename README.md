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
   │                                 │ (stream over loopback)    │
   │                                 ▼                           │
   │                       ┌──────────────────┐                  │
   │                       │  moonlight-web-  │                  │
   │                       │  stream (loopback)│                 │
   │                       └──────────────────┘                  │
   │                                 ▲                           │
   │ ┌──────────────────────┐        │                           │
   │ │  Node.js Portal      │ ───────┼─ (Proxy /stream + WS)     │
   │ │  Express :3000       │ ───────┘                           │
   │ │  BIND 127.0.0.1      │                                    │
   └─└──────────┬───────────┘────────────────────────────────────┘
                │ cloudflared tunnel (HTTPS + WebSocket only)
                ▼
   ┌────────────────────────────────────────────────────────────┐
   │              Cloudflare (DNS + HTTPS for lizandadd.com)    │
   └────────────────────────────┬───────────────────────────────┘
                                ▼
   ┌────────────────────────────────────────────────────────────┐
   │                   Client Web Browser                       │
   │  /  public landing  ·  /play gated arcade after unlock     │
   │  Remote stream uses WebSocket data transport (not WebRTC)  │
   └────────────────────────────────────────────────────────────┘
```

**Windows services on a working host**

| Service | Role |
| --- | --- |
| `Cloudflared` | Tunnel → `127.0.0.1:3000` |
| `CozyArcadePortal` | Express portal (NSSM) |
| `MoonlightWeb` | moonlight-web-stream on `127.0.0.1:8080` (NSSM) |
| `sunshine` | Game stream host / encoder |

---

## 📦 Directory Structure

```
├── server.js                      # Express portal, auth/identity, APIs, stream proxy
├── package.json                   # Node dependencies
├── data/
│   └── arcade.secrets.example.json  # Template only (copy to arcade.secrets.json on host)
├── public/
│   ├── landing.html               # Public brand home (no unlock)
│   ├── index.html                 # Gated co-op play UI (/play)
│   ├── style.css
│   └── app.js
└── scripts/
    ├── arcade.config.example.ps1  # Template for Steam Cat Chess path
    ├── launch-game.ps1            # Whitelisted game status/launch helper
    ├── start-arcade.ps1           # Boot orchestrator (portal / Sunshine / Moonlight / game)
    ├── start-portal-service.cmd   # NSSM launcher for CozyArcadePortal (prod env)
    ├── install-portal-service.ps1 # Admin: register CozyArcadePortal via NSSM
    └── install-stream-stack.ps1   # Admin: Sunshine + moonlight-web + MoonlightWeb service
```

Do **not** rely on cloning Sunshine / moonlight-web-stream / NSSM source trees into this repo. Install **release binaries** (winget / GitHub Releases). Source clones are for development only and are gitignored if present.

---

## 🛠️ Deployment Step-by-Step Blueprint

Follow these steps to configure the Windows laptop as a lid-closed headless game appliance. Replace `$ArcadeRoot` with your install path (example: `C:\Cat_Chess_Remote_Player`).

### 1. Virtual Display Driver (Closed Lid)

When a laptop lid is closed, Windows may disable the physical screen and stop useful GPU output for encoding.

1. Download [IddSampleDriver Releases](https://github.com/ge9/IddSampleDriver/releases).
2. Extract to a permanent folder, e.g. `C:\IddSampleDriver\`.
3. Install the certificate: right-click `IddSampleDriver.cer` → **Install Certificate** → **Local Machine** → **Trusted Root Certification Authorities**.
4. Admin PowerShell:
   ```powershell
   pnputil /add-driver C:\IddSampleDriver\IddSampleDriver.inf /install
   ```
5. Set `C:\IddSampleDriver\option.txt` to:
   ```text
   1920, 1080, 60
   ```
6. In **Settings → System → Display**, confirm the virtual monitor. Use **Extend these displays** (or let it become primary when the lid is closed).

---

### 2. Windows Power Management

1. `Win + R` → `control` → **Hardware and Sound** → **Power Options**.
2. **Choose what closing the lid does** → **Do Nothing** (battery and plugged in).
3. Advanced power settings for the active plan:
   * **Sleep → Sleep after** → **Never**
   * **Sleep → Allow hybrid sleep** → **Off**
   * **PCI Express → Link State Power Management** → **Off**

---

### 3. Battery Charge Limit (24/7 AC)

Cap charge ~50–60% when possible (brand tools vary; Samsung often tops out at ~80%).

---

### 4. Publish lizandadd.com (Cloudflare Tunnel)

Players never install Tailscale. Keep Node / moonlight / Sunshine on loopback; Cloudflare Tunnel provides public HTTPS.

#### 4A. Domain on Cloudflare

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a site** → `lizandadd.com` → Free plan.
2. At the registrar (e.g. Namecheap), set nameservers to Cloudflare’s two NS hosts.
3. Wait until the zone is **Active**.

#### 4B. Clean parking DNS (required before tunnel routes)

Cloudflare often imports registrar parking records. Delete these if present (keep MX/TXT if you still want Namecheap email forwarding):

* **A** `@` / `lizandadd.com` pointing at a parking IP (e.g. `192.64.119.239`)
* **CNAME** `www` → `parkingpage.namecheap.com`

If you skip this, `cloudflared tunnel route dns` fails with “record already exists” (code 1003).

#### 4C. Install and authenticate cloudflared

1. Install [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and ensure `cloudflared` is on PATH (open a **new** PowerShell).
2. Log in and create the tunnel:

```powershell
cloudflared tunnel login
cloudflared tunnel create cozy-arcade
cloudflared tunnel list
```

3. Route DNS (after parking records are gone):

```powershell
cloudflared tunnel route dns cozy-arcade lizandadd.com
cloudflared tunnel route dns cozy-arcade www.lizandadd.com
```

4. Write `%USERPROFILE%\.cloudflared\config.yml` (replace `TUNNEL_UUID`):

```yaml
tunnel: TUNNEL_UUID
credentials-file: C:\Users\YOU\.cloudflared\TUNNEL_UUID.json

ingress:
  - hostname: lizandadd.com
    service: http://127.0.0.1:3000
  - hostname: www.lizandadd.com
    service: http://127.0.0.1:3000
  - service: http_status:404
```

5. Test interactively: `cloudflared tunnel run cozy-arcade`

#### 4D. Windows service (LocalSystem — important)

`cloudflared service install` registers the service as **`Cloudflared`** (capital C) under **LocalSystem**. That account does **not** read `%USERPROFILE%\.cloudflared\` unless you copy config there and set the service command line.

**Admin PowerShell** (after interactive `tunnel run` works):

```powershell
cloudflared service install

$sysCf = "C:\Windows\System32\config\systemprofile\.cloudflared"
$uid = "TUNNEL_UUID"   # from tunnel list / create
$userCf = "$env:USERPROFILE\.cloudflared"
$exe = "$env:LOCALAPPDATA\cloudflared\cloudflared.exe"

New-Item -ItemType Directory -Force -Path $sysCf | Out-Null
Copy-Item "$userCf\$uid.json" "$sysCf\$uid.json" -Force
Copy-Item "$userCf\cert.pem" "$sysCf\cert.pem" -Force -ErrorAction SilentlyContinue

@"
tunnel: $uid
credentials-file: C:\Windows\System32\config\systemprofile\.cloudflared\$uid.json

ingress:
  - hostname: lizandadd.com
    service: http://127.0.0.1:3000
  - hostname: www.lizandadd.com
    service: http://127.0.0.1:3000
  - service: http_status:404
"@ | Set-Content -Path "$sysCf\config.yml" -Encoding ASCII

sc.exe config Cloudflared binPath= "$exe --config=$sysCf\config.yml tunnel run"
Restart-Service Cloudflared -Force
Get-Service Cloudflared
cloudflared tunnel info cozy-arcade
```

Success: service **Running**, and `tunnel info` shows **active connector(s)** (not “does not have any active connection”).

If the service sticks in **StopPending**, kill `cloudflared` processes or reboot, then `sc.exe start Cloudflared`.

5. Do **not** port-forward 3000, 8080, or Sunshine. Optional: Tailscale on the **host only** for admin access.

---

### 5. Node.js Portal + NSSM

#### A. Node.js

Install from [nodejs.org](https://nodejs.org/) (LTS preferred).

If PowerShell blocks `npm.ps1` (“running scripts is disabled”), use `npm.cmd` or:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

#### B. Project + secrets

```powershell
cd $ArcadeRoot
npm.cmd install
Copy-Item .\data\arcade.secrets.example.json .\data\arcade.secrets.json
notepad .\data\arcade.secrets.json
```

Fill `accessToken`, security question / keywords, optional Discord webhook, and `publicPlayUrl` (`https://lizandadd.com/play`).

**Critical:**

* Edit **`arcade.secrets.json`**, not `arcade.secrets.example.json`.
* Save as **UTF-8 without BOM** (Notepad “UTF-8 with BOM” used to break `JSON.parse`; the portal now strips a BOM, but avoid it anyway).
* Restart `CozyArcadePortal` after any secrets change (token is loaded at process start).

Generate a strong token:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

#### C. Register CozyArcadePortal (recommended)

```powershell
winget install --id NSSM.NSSM -e --accept-package-agreements --accept-source-agreements
# Admin:
powershell -ExecutionPolicy Bypass -File "$ArcadeRoot\scripts\install-portal-service.ps1"
```

That script uses `scripts\start-portal-service.cmd` with:

```text
PORT=3000
BIND_HOST=127.0.0.1
TRUST_PROXY=loopback
PUBLIC_MODE=1
STREAM_TARGET=http://127.0.0.1:8080
PUBLIC_PLAY_URL=https://lizandadd.com/play
```

Token / question / webhook stay in `data\arcade.secrets.json` (preferred over duplicating `ARCADE_ACCESS_TOKEN` in the service env).

Verify: `http://127.0.0.1:3000/` and `https://lizandadd.com/api/health` → `{"status":"healthy"}`.

---

### 6. Secrets & Access Control (reference)

| Field | Purpose |
| --- | --- |
| `accessToken` | Shared unlock password for Liz & Addison |
| `securityQuestion` | Shown for unknown IPs after unlock |
| `acceptedKeywords` | Normalized answers that pass the question |
| `discordWebhookUrl` | Optional Discord invites / notifications |
| `publicPlayUrl` | Link used in Discord invites |

Gate behavior:

* **`/`** — public landing.
* **`/play`**, **`/stream`**, play APIs — unlock + Liz/Addison identity.
* Failed unlocks are rate-limited (`data/audit.log`).
* `PUBLIC_MODE=1` refuses to start without a token.

```text
BIND_HOST=127.0.0.1
TRUST_PROXY=loopback
PUBLIC_MODE=1
PUBLIC_PLAY_URL=https://lizandadd.com/play
```

---

### 7. Cat Chess Steam Path

```powershell
Copy-Item .\scripts\arcade.config.example.ps1 .\scripts\arcade.config.ps1
notepad .\scripts\arcade.config.ps1
```

Set `$GamePath` to the real exe, e.g.:

```powershell
$GamePath = "C:\Program Files (x86)\Steam\steamapps\common\Cat Chess\CatChess.exe"
```

(Steam → Cat Chess → Manage → Browse local files.)

---

### 8. Sunshine + moonlight-web-stream

Use **release builds**, not git clones.

#### Automated install (recommended)

```powershell
# Admin:
powershell -ExecutionPolicy Bypass -File "$ArcadeRoot\scripts\install-stream-stack.ps1"
```

This installs Sunshine (winget), downloads moonlight-web into `C:\Tools\moonlight-web`, binds **`127.0.0.1:8080`**, and registers the **`MoonlightWeb`** NSSM service.

#### Pair Sunshine ↔ Moonlight (manual, once)

1. Sunshine UI: https://localhost:47990 (accept cert; set username/password).
2. Moonlight web: http://127.0.0.1:8080/stream/ → create the first admin user (any username you choose — this is **not** the Sunshine login).
3. Add PC → address **`localhost`**, port **blank**.
4. Pair with the PIN shown in Moonlight into Sunshine.
5. Prove it: launch **Desktop** from Moonlight and confirm you see the host screen.
6. Optional: Sunshine → Troubleshooting → install **ViGEmBus** for virtual pads.

If you forget the Moonlight web password (or used the wrong username remotely), run elevated:

```powershell
powershell -ExecutionPolicy Bypass -File "$ArcadeRoot\scripts\reset-moonlight-login.ps1"
```

Use `-RecreateFirstLogin` only if you want to wipe Moonlight users and create a new admin on the next `/stream/` login (hosts are kept; re-pair if needed).

#### Add Cat Chess as a Sunshine app (recommended)

In Sunshine → **Applications** → Add:

| Field | Value |
| --- | --- |
| Name | Cat Chess |
| Command | `C:\Program Files (x86)\Steam\steamapps\common\Cat Chess\CatChess.exe` |

You can keep or remove the default Steam Big Picture (`steam://open/bigpicture`) entry. Prefer launching **Cat Chess** (or **Desktop** after **Start Cat Chess** in the portal).

#### Boot orchestrator

`scripts\start-arcade.ps1` checks IddSampleDriver, Sunshine, MoonlightWeb, CozyArcadePortal, then launches the configured game.

Startup folder shortcut:

```cmd
powershell.exe -ExecutionPolicy Bypass -File "C:\Cat_Chess_Remote_Player\scripts\start-arcade.ps1"
```

(Adjust the path to your `$ArcadeRoot`.)

#### Verify stream bridge

* http://127.0.0.1:8080/stream/ loads Moonlight (prefix is required).
* After unlock on the portal, stream status should report the bridge reachable (`/api/stream-status`).
* Portal embeds Moonlight at `/stream/`; use Moonlight’s own controls for mouse / keyboard / gamepad.
* **Remote / Cloudflare:** WebRTC UDP cannot traverse the tunnel. The host role defaults to **Data Transport = Web Socket**. If a browser still has old Moonlight settings cached, open Settings in the Moonlight UI and set **Data Transport → Web Socket**, then start the stream again.

---

### Cat Chess split-screen co-op

One game on the host, two local virtual pads. Both players open `/play` and share the same stream.

1. ViGEmBus on the host.
2. One controller per client device before connecting.
3. Prefer native Xbox-style pads; avoid Steam Input merging both into one device.
4. `joy.cpl` should show two controllers when both are connected.
5. **Start Cat Chess** in the portal, then **Connect Stream** on both devices.

---

## Play Game

1. Open **https://lizandadd.com**.
2. **Enter the Arcade** → unlock with `accessToken` → security question if asked → **Liz** or **Addison**.
3. **Start Cat Chess** if needed.
4. **Connect Stream** → Moonlight UI should appear inside the portal (or open `/stream/` in a new tab).
5. In Moonlight, open the host → **Desktop** or **Cat Chess**. Confirm **Data Transport** is **Web Socket** if the session stalls after the UI loads.
6. Play.

---

## Ops cheat sheet

```powershell
Get-Service Cloudflared, CozyArcadePortal, MoonlightWeb, sunshine
cloudflared tunnel info cozy-arcade
Invoke-RestMethod http://127.0.0.1:3000/api/health
Invoke-RestMethod https://lizandadd.com/api/health
# After editing arcade.secrets.json:
Restart-Service CozyArcadePortal
```

| Symptom | Likely fix |
| --- | --- |
| Tunnel service Running but `tunnel info` has no connections | LocalSystem config / `binPath` missing `tunnel run` (section 4D) |
| `route dns` code 1003 | Delete parking A/CNAME for `@` and `www` |
| Unlock “token not recognized” | Using example file; BOM; need restart after edit; wrong field (token ≠ security answer) |
| CozyArcadePortal **Paused** | Check `data\portal-service.err.log` (often secrets / `PUBLIC_MODE`) |
| MoonlightWeb **Paused** / :8080 dead | `C:\Tools\moonlight-web\server\config.json` must include `first_login_create_admin` / `first_login_assign_global_hosts` |
| `npm` blocked in PowerShell | Use `npm.cmd` or fix ExecutionPolicy |
| Public site 502 | Portal not listening on `127.0.0.1:3000` |
| Connect Stream: Moonlight UI never appears | Portal must serve `/stream/` (not redirect-loop); proxy `pathRewrite` must restore `/stream` prefix; hard-refresh `/play`; check `MoonlightWeb` |
| Moonlight login: “Credentials are not Valid” | Wrong **Moonlight** user (not Sunshine admin). Check username via `reset-moonlight-login.ps1` output, or reset password / `-RecreateFirstLogin` |
| Moonlight UI loads, stream hangs / times out | WebRTC blocked by Cloudflare Tunnel — set **Data Transport → Web Socket** (host role should already force this) |

---

## Website links and embeds

```html
<a href="https://lizandadd.com/play">Play Cat Chess</a>
```

Prefer a top-level tab. Same-origin embeds of `/play?embed=1` need `ALLOWED_EMBED_ORIGINS`; cross-site iframes may block the session cookie.
