# Open Dash Cam Server

A self-hosted home for your [Open Dash Cam](../README.md) footage: a photo-library-style timeline, a
live map, trips, synced multi-camera playback, sharing and search. One Docker container and a
built-in database; an optional second container adds smart search.

## Features

- **Timeline:** thumbnails grouped by day; sort by date, size, car, camera or location; filter locked,
  impact and parking clips; play in any browser (H.265 clips are converted to H.264 automatically for
  browsers that can't play H.265; originals are kept)
- **Synced playback:** all of a car's cameras side by side on one clock, moving through consecutive
  clips, with speed and a moving marker on the map; 1×–8× speed
- **Map:** live position of each car while ODC is recording or in tracking-only mode, last-seen
  position otherwise, and route history by day (OpenStreetMap data via OpenFreeMap; any MapLibre style works)
- **Trips:** detected automatically from GPS tracks and named by place ("Springfield, IL → Chicago, IL");
  split and merge trips; optional **commute learning** names trips "Home → Work" and keeps a short stop
  from splitting a commute
- **Search:** by place, car and camera names; optionally by what's in the video ("white pickup truck",
  "bridge", "snow") and by license plate, with an optional plate log
- **Uploads:** resumable; the server recomputes each clip's SHA-256 and rejects damaged uploads
- **Cars and cameras:** each phone belongs to one car; connect phones with a single-use QR code that
  expires in 10 minutes; disconnect a phone at any time (its footage stays)
- **People:** the first account is the admin; admins add people; a car's owner shares it as *view* or
  *manage*. Admins don't automatically see other people's footage. Optional two-factor sign-in with
  recovery codes
- **Cameras that disagree** on location or speed: alert (default), use one camera as the source of
  truth, or average them, with adjustable thresholds
- **Alerts** via [ntfy](https://ntfy.sh): impacts, overheating, low phone storage, battery cutoff, a
  camera going offline, cameras disagreeing, server storage near its limit
- **Security:** built-in HTTPS, security headers, optional HTTPS-only mode, a list of signed-in devices
  (sign out others), and an activity log of sign-ins, sharing and account changes, settings changes,
  deletions and every look at license plate data (admins see everyone's; others see their own)
- **Database backups:** a daily copy of the database in `data/backups` (time and number kept are adjustable),
  plus "Back up now" and downloads in Settings
- **Display and accessibility:** each person can choose dark or light theme (or follow the device), an accent
  color, larger text, high contrast and reduced motion (Settings → Display). Works with keyboards and screen readers
- **Live view:** on the Map or Cars page, see what a car's cameras see right now (1–2 pictures a second, each
  camera side by side). Works while ODC is recording on a phone in the car with **Allow live view** turned on in
  the app (off by default); it works over mobile data, with no ports to open on the phone's side. Sessions last
  2 minutes unless extended (up to 15), and end when nobody is watching. The phone shows a notification while
  being watched; owners are notified when someone else starts a live view; only owners and managers can use it,
  and every live view is in the activity log
- **Plates in a clip:** with license plate reading on, the clip player's **Plates** button lists the plates read
  in that clip, with a cropped image and the moment each appears (click to jump there)
- **Arrival alerts:** mark places on the Map (Alert places) and get a notification when a car arrives or
  leaves. Each person's places and alerts are their own
- **Speed alerts:** per car, when it stays above a speed you set for at least 10 seconds (needs live
  location or tracking-only mode on the phone)
- **Impact snapshots:** impact alerts include a photo from the moment of the impact (in browser
  notifications, ntfy and the Events page)
- **Driving events** (optional, Settings): hard braking, hard acceleration and sharp turns, found in the
  GPS tracks recorded with clips and shown in Events and on trips. Only as reliable as the phone's GPS and
  mounting: treat them as hints
- **Share links:** share a clip, or part of it, through a link that works without an account and expires
  after 1 hour, 1 day, 7 days or 30 days. Optionally allow downloading, and blur license plates and/or
  faces first. Links don't reveal the car, the account or the location. Manage them in Settings → Shared links
- **Incident reports:** from an impact event or any moment in a clip, one ZIP with every camera's footage
  around it (trimmed; optionally blurred), a printable report (summary, route map, speed graph, events,
  your notes) and the GPS track
- **Retention** (off by default): maximum total footage size and/or maximum age for the server, per car
  (including "keep forever"), and a storage limit per person across the cars they own; locked clips
  are always kept
- **Browser notifications:** alerts appear as notifications from your browser, even with ODC closed
  (Settings → Notifications in this browser; needs HTTPS). Each person gets alerts for the cars they can see
- **Encrypted clips:** clips encrypted on the phone play in the web app after you enter the passphrase.
  It isn't stored, and the decrypted copy is deleted an hour after use

Everything runs on your machine. Place names, smart search and plate reading are all computed locally.

## Install

Requires Docker (Docker Desktop on Windows and macOS). From the `server` folder:

1. Copy `docker-compose.example.yml` to `docker-compose.yml` and edit it:
   - `ports`: written as `HOST:CONTAINER`. Change the left number to use a different port; keep `8080`
     on the right
   - `ODC_PUBLIC_URL`: the address **phones** will use to reach the server. It goes into the pairing QR
     code, so it can't be `localhost`. On a home network, use the computer's LAN IP (e.g.
     `http://192.168.1.50:8080`)
   - `TZ`: your time zone
2. Start it:
   ```
   docker compose up -d --build
   ```
3. Open `http://localhost:8080` (or your chosen port). Setup walks you through creating the admin
   account, choosing defaults or custom settings, adding a car, and connecting a phone (in ODC:
   Settings → ODC Server → Scan pairing code)

Your `docker-compose.yml` is yours: updates never overwrite it.

### Windows firewall
If a phone can't connect, allow the port through Windows Defender Firewall (PowerShell as administrator,
with your network set to *Private*):
```
New-NetFirewallRule -DisplayName "Open Dash Cam" -Direction Inbound -Protocol TCP -LocalPort 8080 -Action Allow -Profile Private
```
A quick test: open `http://YOUR-IP:PORT` in the phone's browser. If the sign-in page loads, pairing will work.

### Automatic HTTPS with Let's Encrypt (recommended for access away from home)
The compose file includes an optional HTTPS container (Caddy) that gets a free, publicly trusted
certificate from Let's Encrypt and renews it automatically. Browsers show no warnings, and video
playback in the app works over HTTPS.

You need:
- a domain name (e.g. `odc.example.com`) whose DNS record points to your home's public IP address
- ports **80 and 443** forwarded from your router to the machine running ODC (Let's Encrypt connects to
  port 80 to confirm you control the domain)

Then, in `docker-compose.yml`:
1. In the `caddy` service, set `ODC_DOMAIN=odc.example.com` (your domain)
2. In the `opendashcam` service, set `ODC_PUBLIC_URL=https://odc.example.com` and `ODC_TRUST_PROXY=1`
3. Start with the `https` profile: `docker compose --profile https up -d --build`
   (with smart search too: `--profile ml --profile https`, or `COMPOSE_PROFILES=ml,https` in a `.env` file)

The certificate arrives within a minute or so of the first start; `docker logs opendashcam-https` shows
progress. Re-pair phones (or use "Check connection" in the app) after changing `ODC_PUBLIC_URL`.

If you can't forward ports 80 and 443 (some internet providers block them), Let's Encrypt can instead
verify the domain through your DNS provider's API. Caddy supports this with a DNS add-on for your provider;
see Caddy's documentation on the DNS challenge.

### Built-in HTTPS
The server also listens for HTTPS on port 8443 with its own certificate, created on first start (map the
port in `docker-compose.yml`). Phones trust it automatically: the pairing QR code carries the certificate's
fingerprint, so the app accepts exactly that certificate. Browsers show a one-time warning because the
certificate isn't from a public authority, and the app's video playback can't use it (Android's video
player only accepts publicly trusted certificates); use Let's Encrypt above for that. To use your own certificate, replace `data/tls/cert.pem` and
`data/tls/key.pem` and restart. The fingerprint is shown in Settings → Security and in the server log.

**Home address:** set `ODC_HOME_URL` (or Settings → Security) to the server's address on your home network,
e.g. `https://192.168.1.50:8443`. Phones on your home Wi-Fi use it automatically for faster uploads.

**Unencrypted http://** addresses work, but the app and web app warn about them. We recommend HTTPS,
especially for access away from home. **HTTPS-only mode** (Settings → Security) sends browsers that arrive
over http:// to the secure address and enables HSTS; phones are not redirected.

### Access from anywhere
Put the server behind HTTPS before exposing it to the internet, set `ODC_PUBLIC_URL` to that address
and `ODC_TRUST_PROXY=1`. Caddy example:
```
opendashcam.example.com {
    reverse_proxy opendashcam:8080
}
```
Turning on two-factor sign-in (Settings) is recommended for internet-facing servers.

### Updating
Copy the new version's files over your `server` folder and run `docker compose up -d --build` again.
The database upgrades itself; your data is kept.

## Smart search (optional)

Search footage by what's in it: "white pickup truck", "bridge", "snow", "gas station". Results open at
the moment that matched. This uses an extra container that runs OpenAI's CLIP model on your machine.

1. Make sure your `docker-compose.yml` includes the `opendashcam-ml` service and the `ODC_ML_URL` line
   from `docker-compose.example.yml`
2. Start with the `ml` profile:
   ```
   docker compose --profile ml up -d --build
   ```
   The first build downloads PyTorch; the first start downloads the CLIP model (about 600 MB) into
   `./ml-cache`
3. In the web app: Settings → Smart search → turn it on → Save

Footage already on the server is analyzed in the background as soon as the feature is turned on,
newest first, at about one frame every 10 seconds of video; new clips are analyzed as they arrive.
Progress shows on the Search page and in Settings. **Analyze footage** (Settings) lets you analyze a
specific date range or car first, retry clips that failed, or analyze clips again. The ML container
needs about 1.5 GB of RAM. Without a GPU, analysis
takes roughly a second or two per minute of footage on a typical home server; searching is instant.

## Home Assistant (optional)

ODC can publish each car to Home Assistant over MQTT. Cars appear automatically (MQTT discovery) as
devices with:
- a **location** tracker (works with Home Assistant zones such as "home")
- **speed**, **last seen** and **phone battery** sensors, and **recording** and **moving** binary sensors
- an **alert** event entity for impacts, arrivals and departures, speeding, a camera going offline,
  overheating, battery cutoff and driving events

Setup:
1. In Home Assistant, install an MQTT broker (for example the Mosquitto broker add-on) and the MQTT
   integration, and create a user for ODC.
2. In ODC, open Settings → Home Assistant (MQTT), turn it on, and enter the broker address
   (`mqtt://<broker-ip>:1883`, or `mqtts://` for TLS), username and password. The status line shows
   whether ODC is connected.

The entities show up under Settings → Devices & services → MQTT. Example automation (a notification with
the event details when a car reports an impact):

```yaml
triggers:
  - trigger: state
    entity_id: event.my_car_alert
conditions:
  - condition: state
    entity_id: event.my_car_alert
    attribute: event_type
    state: impact
actions:
  - action: notify.notify
    data:
      message: "Impact: {{ trigger.to_state.attributes.message }}"
```

Location data goes only to your own broker. Topics start with `opendashcam/` (changeable); discovery uses
the `homeassistant/` prefix.

## Viofo dashcam import (optional)

ODC can import recordings from Viofo dashcams with Wi-Fi when the car is home. Each lens (front, rear,
interior) becomes a camera of the car, event (RO) recordings arrive locked, parking recordings are marked as
parking, and the GPS recorded in the video is used for the map, trips, place names and alerts, like phone
footage.

Requirements:
- A Viofo dashcam with Wi-Fi **station mode** (it joins your home Wi-Fi). Keeping station mode on
  automatically may need special firmware from Viofo support
- A fixed address for the camera on your network (a DHCP reservation in your router)
- Power while parked (for example a hardwire kit), so the camera is on when it's in range

Setup: on the Cars page, open the car, enter the camera's address under **Viofo dashcam**, choose which
recordings to import, save, and use **Check camera**. ODC then checks every 2 minutes and imports new
recordings, newest first. Interrupted downloads resume. The newest normal and parking recording is imported
once the camera has started the next one, since it may still be recording.

GPS is read with ExifTool (included in the Docker image). The camera's own file names use its clock; when the
video contains GPS, ODC uses GPS time instead. Tested against Viofo's documented Wi-Fi interface; models and
firmware vary, so check the first imports.

## Blurring plates and faces (optional)

Share links and incident reports can blur license plates and faces. This runs in the ML container (the
same one as smart search), which needs access to the footage: keep the `./data:/data` line in its
`volumes` in `docker-compose.yml`. Faces are found with YuNet (OpenCV), downloaded on first use; plates
with the same detector as plate search. Blurring re-encodes the video and takes roughly as long as the
clip on a typical home server. Detection isn't perfect: check the result before sharing anything
sensitive.

## License plates (optional)

Needs the ML container. Turn on in Settings → License plates.

- **Plate reading and search:** plates are read on your server from frames sampled every 2 seconds at
  full resolution, so you can find every clip showing a plate. Search tolerates common misreads
  (B/8, O/0, S/5, I/1) and one wrong character, and shows how certain each reading is
- **Plate log** (a separate switch): a Plates page listing every plate read, with sighting counts,
  first and last seen, which cars saw it, and your own notes. Each plate has a review page with a cropped
  image of every sighting, where you can fix a misread, remove a false reading, or merge plates that
  are the same vehicle (likely duplicates are suggested). Merges are remembered for future readings
- **Retention:** keep readings for a number of days you choose, or forever. Turning plate reading off
  stops new readings; "Delete all plate data" erases readings, notes and merges

Laws on reading, storing and logging license plates differ between countries, states and cities: it
is legal in some places, a grey area in others and illegal in others. You are responsible for knowing
and following the laws where you drive and where your server runs. Both switches show a notice before
they turn on.

Plate reading uses [fast-alpr](https://github.com/ankandrew/fast-alpr); accuracy depends heavily on the
footage: night, motion blur and distance make plates hard to read.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `ODC_PUBLIC_URL` | from the request | Address phones use; put in pairing QR codes and stream links |
| `ODC_TRUST_PROXY` | `0` | `1` when behind a reverse proxy (uses `X-Forwarded-For` for rate limiting) |
| `ODC_ML_URL` | `http://opendashcam-ml:3003` | Where the optional ML container is |
| `PORT` | `8080` | Port inside the container |
| `TZ` | UTC | Time zone (trip naming and commute learning use local time) |
| `ODC_ML_THREADS` (ML container) | half the CPU cores | CPU threads for analysis |

Everything else is set in the web app under Settings.

## Data and backups

Everything lives in the `./data` folder you mapped to `/data`:
- `odc.db`: the database (SQLite)
- `library/<car>/<camera>/<date>/`: original clips plus their `.gpx` / `.srt` files
- `cache/`: thumbnails and H.264 copies (safe to delete; they're recreated)

The server writes a daily copy of the database to `data/backups` (Settings → Database backups). Copy that
folder to another disk too. Footage isn't in these backups; back up `data/library` separately if you want
a second copy of it.

**Restoring a database backup:** stop the container, copy the backup over `data/odc.db`, delete
`data/odc.db-wal` and `data/odc.db-shm` if present, and start the container again.

## Development

Requires Node.js 22.13+ and ffmpeg; the server has no npm dependencies.

```
ODC_DATA_DIR=./data npm start
npm test
```

The tests start a real server and exercise the phone API, web API, place names, trips, two-factor
sign-in and search. The search tests run the ML service with a built-in stand-in model, so they need
`python3` with `numpy` and `pillow` but no ML downloads.

## License

AGPL-3.0-or-later. Place names: GeoNames (geonames.org), CC BY 4.0. Maps: OpenStreetMap contributors,
OpenFreeMap, MapLibre.
