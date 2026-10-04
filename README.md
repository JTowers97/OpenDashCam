# Open Dash Cam

**Turn any Android phone into a dashcam.** Open Dash Cam (ODC) records the road, protects the clips that
matter, and backs them up to storage you control: a network share, or your own self-hosted ODC Server
with a timeline, live map, trips and search.

Free and open source. No accounts, no cloud, no ads, no tracking.

- **App** (`app/`): Android 10 or newer. GPL-3.0
- **Server** (`server/`): self-hosted with Docker. AGPL-3.0. See [server/README.md](server/README.md)

## Features

### Recording
- Rear camera, front camera, or **both at once** on phones that support it
- Resolution, frame rate, quality and H.265/H.264, limited to what your phone's camera can do; ODC
  steps settings down automatically if the camera rejects them
- **Crash-resistant recording:** clips are saved continuously as they record (fragmented MP4), so a crash or
  sudden power loss costs at most about a second of video
- **Loop recording** in exact 1, 3 or 5-minute clips, with a storage limit and a warning before it's reached
- **Lock** clips so they're never replaced; **impact detection** locks the clips before, during and
  after a jolt
- Always records in landscape; the recording screen dims to minimum brightness (tap to wake) or you
  can turn the screen off. ODC checks whether your phone keeps recording with the screen off and tells you
- Optional **date/time stamp burned into the video**, with speed and GPS coordinates if you like
- Clock corrected automatically using GPS time (or your ODC Server), so timestamps are accurate and
  multiple phones in one car line up
- Audio off by default
- Save footage to internal storage, an SD card or another external drive

### Parking mode
- Switches on automatically when the phone stops charging
- **Continuous** (720p), **motion-activated** (keeps only clips with motion, plus the moments before
  and after) or **time-lapse** (one frame every 1, 2 or 5 seconds)
- Stops cleanly at a battery level you choose (2–50%) so clips are never corrupted, and resumes when
  charging starts again
- Overheating protection: alerts you, lowers quality, and pauses only if the phone gets dangerously hot

### Location
- Optional **GPS and speed logging** saved with each clip (GPX), using the phone's own location service
  (no Google Play Services needed)
- Optional subtitle file with date, time and speed (players like VLC can show or hide it)
- **Privacy zones**, drawn on a map, where no location is logged and parking mode can be switched off
  (e.g. at home)
- **Tracking-only mode** (with an ODC Server): reports the car's position and speed in the background
  without recording; positions are kept on the phone and sent later when there's no connection
- mph or km/h, detected from your region

### Auto-start
- Start recording when charging begins and/or when the phone connects to your car's Bluetooth

### Backup and privacy
- Back up to an **SMB share** (NAS or computer) and/or an **ODC Server**
- Wi-Fi only by default; optional cellular uploads with a monthly limit; optional "only while charging"
- Uploads resume after interruptions and are verified with SHA-256 before a clip counts as backed up
- Choose to keep or delete the phone copy after upload; locked clips and clips you mark "Keep on
  phone" always stay
- **Encrypt** clips on the phone whenever you like, and/or encrypt SMB uploads (AES-256-GCM with your
  passphrase). Decrypt with `tools/odc_decrypt.py`

### ODC Server (optional, self-hosted)
- Timeline of all footage with thumbnails, sorting and filters, playable in any browser
- Live map of each car, route history and automatically detected trips with place names
- **Map View** of your clips in the app: see where each clip was recorded and play it
- **All cameras** in the app: play a car's cameras side by side, in sync, streamed from the server
- **Synced playback** of all of a car's cameras side by side
- Sharing with family members, two-factor sign-in, alerts as browser notifications or via ntfy
- Retention per car and storage limits per person; play phone-encrypted clips with your passphrase
- **Smart search** ("white pickup truck", "bridge", "snow") and optional **license plate search and
  plate log**, running on your server
- See [server/README.md](server/README.md)

## Install

Download the latest APK from the [Releases](../../releases) page and open it on your phone. Android
will ask you to allow installing apps from your browser or file manager.

### Setting up
The first launch walks you through permissions, battery settings and a quick check of what your
phone's cameras can do, then lets you use recommended defaults or customize.

For reliable recording:
- **Allow unrestricted battery use** for ODC when setup asks. On Samsung, Xiaomi, OnePlus, Huawei and
  similar phones, also follow the instructions at [dontkillmyapp.com](https://dontkillmyapp.com)
  (setup links to your phone's page)
- Keep ODC open on screen while driving. Start with the dimmed-screen mode; try screen-off mode on a
  short drive first, since some phones stop background recording
- Mount the phone in landscape

### Where footage is stored
`Android/data/org.opendashcam/files/Movies/ODC/` on the drive you choose. **Uninstalling ODC deletes
this folder**; installing a newer version over the old one keeps it. Copy anything important off the
phone (or turn on backup) before uninstalling.

## Build from source

**With GitHub Actions (no tools needed):** fork this repository; the *Build APK* workflow builds the app
on every push. Download the APK from the workflow run's artifacts. Pushing a tag like `v1.2.3` attaches
the APK to a release.

**With Android Studio:** open the project folder and press Run. Requires JDK 17.

The app shows its version, build number and commit in Settings → About (e.g. `0.4.1 (build 42 · a1b2c3d)`).

Debug builds are signed with a test key that is included in the repository, so new builds install over
old ones. It is public: don't use it for anything you distribute.

### Release signing (for forks that publish builds)

The *Build APK* workflow signs release builds with your own private key once these repository secrets
exist (Settings → Secrets and variables → Actions); until then it publishes the debug build:

| Secret | Value |
| --- | --- |
| `ODC_KEYSTORE_BASE64` | your keystore file, base64-encoded |
| `ODC_KEYSTORE_PASSWORD` | the keystore password |
| `ODC_KEY_ALIAS` | the key alias |
| `ODC_KEY_PASSWORD` | the key password |

Create a key once with `keytool -genkeypair -v -keystore release.jks -keyalg RSA -keysize 4096 -validity 10000 -alias odc`
and encode it with `base64 -w0 release.jks` (Linux/macOS) or
`[Convert]::ToBase64String([IO.File]::ReadAllBytes("release.jks"))` (PowerShell). Keep the file and
passwords safe and private: without them you can never publish an update to installed copies.

**Switching keys:** Android only installs an update signed with the same key as the installed app. Moving
from debug-signed to release-signed builds means uninstalling once, which deletes footage stored on the
phone, so back it up first.

## Permissions

| Permission | Why | When it's requested |
| --- | --- | --- |
| Camera | Recording | Setup |
| Notifications | Recording status and alerts | Setup |
| Microphone | Audio recording | Only if you turn audio on |
| Location | GPS/speed logging, privacy zones, live map, tracking-only mode | Only if you turn one of those on |
| Location "Allow all the time" | Resume tracking-only mode after the phone restarts | Only if you turn that option on |
| Nearby devices (Bluetooth) | Auto-start with your car's Bluetooth | Only if you turn that on |
| Display over other apps | Lets auto-start open ODC from the background | Only if you use auto-start |
| Unrestricted battery | Keeps recording reliable | Setup |

ODC uses location while it's open or recording, and in the background only when you turn on
tracking-only mode (with a notification showing while it runs).

## Known limitations

- If a phone's graphics driver can't run the date/time stamp, ODC records without it rather than not at all
- Motion-activated parking keeps the camera running at a low frame rate; time-lapse uses the least battery

## Roadmap

Planned features, in no particular order:

- **Live view on demand:** look through a car's camera from the ODC Server (for example after an impact
  alert while parked)
- **Impact snapshots:** impact alerts include a photo from that moment
- **Incident reports:** one export with clips from all cameras around an event, a route map, a speed graph,
  time and place, ready for an insurer or police report
- **Expiring share links:** share a clip without an account, through a link that stops working after a set time
- **Optional blurring when sharing or exporting:** separate checkboxes to blur license plates and faces,
  done on the server, off unless you choose them
- **Arrival alerts:** a notification when a car arrives at a place you mark on the map
- **Speed alerts:** a notification when a car goes over a speed you set
- **License plate in the stamp:** optionally show your own car's plate in the date/time stamp
- **Trip logbook export:** trips and distances as a spreadsheet file, for mileage records
- **Driving events (optional):** hard braking, hard acceleration and sharp turns marked on the timeline,
  detected from the phone's GPS and motion sensor. Only as reliable as the phone's sensors and mounting
- **Home Assistant integration:** car location, presence and alerts in Home Assistant
- **Viofo dashcam import:** Viofo cameras on your home Wi-Fi sync their recordings (with GPS) to the ODC
  Server automatically, alongside phone footage
- **Home address for the server:** on your home Wi-Fi the app talks to the ODC Server directly on your
  network (faster uploads), and uses its internet address elsewhere
- **Built-in HTTPS:** the ODC Server can secure connections itself, without a domain or reverse proxy; the
  pairing QR code tells the phone exactly which server to trust
- **Connection security warnings:** clear warnings (not blocks) when a server address uses unencrypted
  `http://` over the internet, and when an SMB share doesn't encrypt traffic, recommending HTTPS and SMB encryption
- **Web security headers:** stricter browser protections for the web app, and HTTPS-only mode once it's
  served over HTTPS
- **Clip trimming:** cut out just the part that matters before sharing or exporting
- **Parking spot:** "Where did I park?" in the app, from the car's last known position
- **Server backups:** scheduled backups of the ODC Server's database (trips, settings, plate log, accounts)
- **Bulk actions:** select many clips at once to lock, delete, encrypt or download, in the app and on the server
- **Signed-in devices:** see where your account is signed in and sign out other devices
- **Audit log:** a record of sign-ins, sharing changes, plate log views and deletions
- **Setup checklist:** a getting-started list on the server's home page for new installs
- **Calendar view:** see at a glance which days have footage, and jump to them
- **App lock (optional):** require your fingerprint, face or screen lock to open clips and settings
- **Custom themes (optional):** choose colors and light/dark appearance in the app and the web app
- **Accessibility settings (optional):** larger text and controls, higher contrast, and screen reader support
- **Quick Settings tile and widget:** start and stop recording from Android's pull-down menu or the home screen
- **Automated security scanning (free tools only):** dependency alerts and update pull requests (Dependabot),
  code scanning (CodeQL) and secret scanning once the repository is public, and an open-source scan of
  the server's Docker image

Suggestions and bug reports are welcome in [Issues](../../issues).

## Legal

Laws on recording audio, filming in public, and reading or logging license plates differ between
countries, states and cities: legal in some places, a grey area in others and illegal in others. You
are responsible for knowing and following the laws where you drive and where your server runs. Audio
recording and license plate features are off by default and show a notice before they can be turned on.
The software is provided without warranty; see the licenses.

## Credits

ZXing (QR scanning), smbj (SMB), Jetpack Compose and CameraX (Android); MapLibre, OpenFreeMap and
OpenStreetMap contributors (maps); GeoNames (place names, CC BY 4.0); OpenAI CLIP via
sentence-transformers (smart search); fast-alpr (license plates).

## License

The Android app and tools are licensed under the [GNU GPL v3](LICENSE). The server is licensed under the
GNU AGPL v3 (see `server/`).
