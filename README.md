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
- **Loop recording** in 1, 3 or 5-minute clips, with a storage limit and a warning before it's reached
- **Lock** clips so they're never replaced; **impact detection** locks the clips before, during and
  after a jolt
- Always records in landscape; the recording screen dims to minimum brightness (tap to wake) or you
  can turn the screen off
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
- Optional subtitle file with date, time and speed that most video players show over the clip
- **Privacy zones** where no location is logged and parking mode can be switched off (e.g. at home)
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
- **Synced playback** of all of a car's cameras side by side
- Sharing with family members, two-factor sign-in, alerts to your phone via ntfy
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

## Permissions

| Permission | Why | When it's requested |
| --- | --- | --- |
| Camera | Recording | Setup |
| Notifications | Recording status and alerts | Setup |
| Microphone | Audio recording | Only if you turn audio on |
| Location | GPS/speed logging, privacy zones, live map | Only if you turn GPS logging on |
| Nearby devices (Bluetooth) | Auto-start with your car's Bluetooth | Only if you turn that on |
| Display over other apps | Lets auto-start open ODC from the background | Only if you use auto-start |
| Unrestricted battery | Keeps recording reliable | Setup |

ODC only uses location while it's open or recording.

## Known limitations

- Clips are standard MP4. A sudden power loss can damage the clip being written; the battery cutoff
  prevents this in normal parking use
- Clip length is approximate: clips are split by file size, so quiet scenes can run a little longer
- The speed overlay is a subtitle file, not burned into the video
- Motion-activated parking keeps the camera running at a low frame rate; time-lapse uses the least battery
- Privacy zones are added at your current location (no map editor yet)

## Roadmap

- **Tracking-only mode:** run in the background without recording and report the car's position and
  speed to your ODC Server (available only once an ODC Server is connected)
- Crash-resistant recording (fragmented MP4) and a burned-in date/time/speed overlay
- Drawing privacy zones on a map
- Recording upright-mounted phones in landscape (cropped)

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
