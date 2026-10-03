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
- **Map:** live position of each car while ODC is recording, last-seen position otherwise, and route
  history by day (OpenStreetMap data via OpenFreeMap; any MapLibre style works)
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
- **Retention** (off by default): maximum total footage size and/or maximum age; locked clips are kept

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

Footage is analyzed in the background, newest first, at about one frame every 10 seconds of video.
Progress shows on the Search page. The ML container needs about 1.5 GB of RAM. Without a GPU, analysis
takes roughly a second or two per minute of footage on a typical home server; searching is instant.

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

Back up `./data` (stop the container first, or back up `odc.db` together with `odc.db-wal`).

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
