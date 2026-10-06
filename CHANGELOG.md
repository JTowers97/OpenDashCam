# Changelog

## App 2.0.1 · Server 2.0.1
- **Fixed (server):** an unexpected error could stop the server until Docker restarted it (seen as a 502 from a reverse
  proxy). Such errors are now logged to data/logs/errors.log and listed in Background work, and the server keeps running
- **Fixed (server):** a share link could stay "Waiting": background jobs ran one at a time across the whole server, so a
  long memory card import held up blurring; a blur job waited forever if the ML container restarted; and links being
  prepared during a server restart were never finished. Imports and ML work now run in separate lanes, blur jobs fail with a
  clear message if the ML container forgets them or stops making progress, and interrupted share links resume after a restart
- **Server:** Background work (web app → Background, and Command Center → More): jobs with progress and their place in
  line, what the ML container is doing right now and its blur queue, footage analysis backlogs, Viofo imports in progress,
  and (admins) recent unexpected errors
- **App:** Command Center's map can show a car's route on any day: choose the car, then step through days or pick a date;
  with the distance and time span

## App 2.0.1 · Server 2.0.1
- **Server + App:** Background work (web: Background; app: Command Center → More): jobs with progress or their place in
  line, what the ML container is doing and its blur queue, footage waiting for analysis, imports, and (admins) recent
  unexpected errors
- **Fixed (server):** an unexpected error could stop the server until Docker restarted it (seen as a 502 from the
  reverse proxy). It's now logged (Background work and `data/logs/errors.log`) and the server keeps running
- **Fixed (server):** a share link could stay "Waiting": jobs ran one at a time, so a memory card import held up
  blurring; a blur job the ML container had forgotten (after it restarted) was waited for forever; and links being
  prepared during a server restart were never finished. Imports and blurring now run separately, forgotten or stalled
  blur jobs fail with a clear message, and interrupted links are prepared again after a restart
- **App:** Command Center's map can show a car's route on any day: choose the car, then the day (arrows or a date picker)

## App 2.0.0 · Server 2.0.0
- **App:** first-run setup asks how the phone will be used (as a dashcam, to manage your ODC Server, or both) and
  covers what each needs: permissions and battery, the main recording features, pairing with your ODC Server, "Dashcam
  only", Command Center sign-in and how alerts arrive (UnifiedPush with an ntfy install link, or a direct connection),
  and which mode the app opens in
- **App:** Settings reorganized into categories (Dashcam Mode, Backup, Command Center, App, About and help), each with a
  one-line summary, plus a search box that finds any setting
- **App:** choose which mode the app opens in (Settings → App), and "Dashcam only" for phones that live in the car:
  Command Center is hidden and signed out, so the phone holds no access to the account
- **App:** Command Center has the rest of the server: share links (with blurring), incident reports saved to Downloads,
  plates in a clip (tap to jump there), deleting clips, the license plate log, shared links, signed-in devices, and for
  admins, people and server settings
- **App + Server:** remote settings for dashcam phones from Command Center or the web app: changes apply the next time
  the phone checks in, with a notification on the phone; only an allowlist of settings (no audio, privacy zones or
  passwords); in the activity log

## App 1.9.0 · Server 1.9.0
- **App:** Command Center's everyday screens, built into the app: Alerts, Timeline (with a calendar and a car filter),
  Map (your cars' positions, with live view), Trips (route map, driving events and clips), and Cars (cameras and their
  footage, add a car, disconnect a phone, and pair a new dashcam phone by showing its QR code). Search by place, by
  what's in the video, or by plate. Clips play from the server and can be locked or unlocked. Live view shows each
  camera's pictures in the app. Back returns through what you opened
- **Server:** checked that everything Command Center uses works with the app's sign-in

## App 1.8.1 · Server 1.8.1
- **Fixed:** the date/time stamp was sometimes read as a license plate, and blurred when blurring plates. Plates are no
  longer read or blurred where a clip's stamp is: the bottom-left corner on ODC phone footage with the stamp on (also
  assumed for clips uploaded before this version), the bottom strip on Viofo footage. Readings of stamps already in
  the plate log are removed when the server updates
- **App:** tells the server whether the date/time stamp is on when uploading a clip

## App 1.8.0 · Server 1.8.0
- **App:** Command Center (first part): sign in to your ODC Server (two-factor supported) to see your cars and alerts,
  and get alerts as notifications with their photo; tapping one opens the alert and plays the clip from that moment.
  Dashcam Mode stays the default; Command Center can be made the default. Protected by the app lock
- **App:** alert delivery without Google services: UnifiedPush (through a distributor app such as ntfy) or a direct
  connection to the server; choose which alerts you get; send a test alert
- **Server:** app sign-ins (a year, listed in Signed-in devices), a notification inbox per person, the app's direct
  connection, alert choices per person (also in the web app: Settings → Alerts I get), and finding the clip for an alert

## App 1.7.0 · Server 1.7.0
- **App:** optional spoken feedback ("Recording started", "Parking mode", "Impact detected", battery and heat pauses),
  played like navigation directions so it comes through the car's speakers and briefly lowers music
- **App:** optional upload of impact and locked clips over mobile data while other backups wait for Wi-Fi: right after an
  impact, again as the locked clips finish, and when you lock a clip (counts toward the monthly mobile data limit)
- **Server:** optional weekly summary per person: each car's trips, distance, driving time, alerts and footage, at a
  chosen day and time, with a preview
- **Server:** live view of a Viofo dashcam on your network, next to any phones in the car (its RTSP stream, relayed while
  someone is watching; shows why if the stream can't be reached)
- **Server:** saving one set of preferences no longer resets the others

## Server 1.6.1 (app 1.6.1: no changes, version aligned)
- **Improved (server):** plate and face blurring finds far more: plates are also searched in overlapping
  full-resolution tiles with a larger model and a lower threshold, faces at full resolution plus a magnified view of
  the middle of the picture; detection runs 10 times a second and each region stays covered across neighboring
  detections; blurred areas are larger. Adjustable for speed (see the server README). Blurred share links offer a
  preview with a reminder to check before sending
- **Server:** import a dashcam's memory card: copy its files into `data/import` or upload them from the browser,
  then import into a car (GPS, event recordings locked, parking marked, one camera per lens; anything already on
  the server skipped, including across Wi-Fi and card imports)
- **Server:** Viofo Wi-Fi import shows progress and transfer speed, and can be limited to chosen lenses; the docs
  recommend turning the camera's parking mode off (Viofo turns Wi-Fi off in parking mode)
- **Server:** cameras on the Cars page show their footage; disconnected phones are marked and disappear once their
  footage is gone; "Delete with footage" removes a disconnected phone or a dashcam camera with its clips (GPS
  history and trips are kept)
- **Improved (server):** Viofo import accepts more file name styles (falling back to the time the camera reports for
  each file), and the status says why nothing was imported (no recordings, unreadable names, or the newest recording
  waiting until the camera starts the next one)
- **Fixed (server):** blurring could be offered when the ML container couldn't see the footage (its data folder not
  mounted), and then fail. The server now checks this, and the blur options explain how to fix it

## App 1.6.0 · Server 1.6.0
- **App:** optional app lock (fingerprint, face or screen lock) for clips, maps, the parking spot and settings,
  relocking after a chosen time; the recording screen is never locked
- **App:** themes (dark, light or follow the phone; six accent colors, or colors from the wallpaper on Android 12+),
  text size and high contrast; the recording screen stays dark for night driving
- **App:** settings switches are now announced with their names by screen readers, and the whole row is tappable
- **Server:** per-person display preferences (theme, accent, text size, high contrast, reduced motion) that follow
  you to any browser
- **Server:** accessibility: proper dialog semantics with focus kept inside and returned afterwards, keyboard-openable
  clips with descriptive labels, a "Skip to content" link, always-visible keyboard focus
- **Google Play:** targets Android 16 (API 36), as Google Play now requires; updated MapLibre, CameraX and the
  Android build tools; builds now include the Android App Bundle (.aab) Google Play needs, and check that all native
  libraries support 16 KB memory pages
- **Project:** added a privacy policy (PRIVACY.md)

## App 1.5.0 · Server 1.5.0
- **Server + App:** live view on demand: watch a car's cameras from the ODC Server while ODC is recording
  (1–2 pictures a second per camera, works over mobile data). Off by default on the phone (Settings → ODC Server →
  Allow live view); the phone shows a notification while watched; owners are notified when someone else watches;
  owners and managers only; sessions end after 2 minutes unless extended, or when nobody is watching
- **Server:** the clip player lists the license plates read in that clip, with crops and their moment (click to jump)
- **Fixed (app):** on narrower screens the Clips title was squeezed into one letter per line by the buttons next to it;
  the buttons now wrap below the title

## Server 1.4.0 (app 1.4.0: no changes, version aligned)
- **Server:** Home Assistant integration over MQTT with discovery: each car's location tracker, speed,
  last seen, phone battery, recording and moving, plus an alert event entity
- **Server:** Viofo dashcam import over Wi-Fi: newest first, resumable downloads, separate cameras per lens,
  event recordings locked, parking recordings marked, GPS read from the video (ExifTool, now in the image)
- **Server:** the car position now carries the GPS accuracy (used by Home Assistant zones)

## App 1.3.0 · Server 1.3.0
- **Server:** arrival alerts: draw places on the Map and get notified when a car arrives or leaves (with a
  margin so GPS jitter at the edge doesn't cause repeat alerts)
- **Server:** speed alerts per car: sustained for 10 seconds, once per stretch of speeding
- **Server:** optional driving events (hard braking, hard acceleration, sharp turns) with a sensitivity
  setting, shown in Events and as markers on trips
- **Server:** impact alerts include a photo: in browser notifications, ntfy and on the Events page
- **Server:** alerts are only sent for recent positions, so late uploads don't trigger stale notifications
- **App:** sends a photo from the moment of an impact (with the date/time stamp) to the ODC Server

## App 1.2.0 · Server 1.2.0
- **Server:** expiring share links for a clip or a trimmed part: no account needed, 1 hour to 30 days,
  optional download, view counts, turn off any time (Settings → Shared links). Links don't reveal the car,
  account or location
- **Server:** incident reports: every camera's footage around a moment, a printable report with summary,
  route map, speed graph, events and notes, and the GPS track, in one ZIP. From impact events or the player
- **Server:** optional blurring of license plates and faces for share links and reports, done by the ML
  container on your server
- **Server:** background jobs with progress for blurring and reports
- **Server:** phone event messages (e.g. impact g-force) are now kept and shown in reports
- **App:** optionally show your own license plate in the date/time stamp
- **Fixed:** optional parts of some web pages could show the word "null"

## App 1.1.0 · Server 1.1.0
- **Server:** getting-started checklist on the Timeline (can be hidden)
- **Server:** calendar view of footage; tap a day to see its clips
- **Server:** bulk actions: select clips to lock, unlock, delete or download as one ZIP (with GPS tracks)
- **Server:** clip trimming: mark start and end while watching, then save a copy as a new locked clip or download it
- **Server:** trip logbook export (CSV) with dates, places, distances and speeds in your units
- **App:** "Where I parked": the last position saved when parking mode starts or recording/tracking stops,
  with directions and sharing (never saved inside privacy zones)
- **App:** Quick Settings tile and home-screen widget to start and stop recording
- **App:** bulk actions in Clips: select clips to lock, unlock, keep on phone, encrypt or delete
- **Project:** no longer includes a LICENSE file, so uploads don't overwrite the repository's full GPLv3 text

## App 1.0.0 · Server 1.0.0
- **Server:** built-in HTTPS with its own certificate; pairing QR codes carry its fingerprint so phones trust exactly it
- **Server:** optional automatic HTTPS with a free Let's Encrypt certificate (Caddy container, renewed
  automatically); with it, video playback in the app works over HTTPS
- **Server:** security headers, optional HTTPS-only mode, signed-in devices (sign out others; changing the
  password signs out other devices), activity log, daily database backups with downloads
- **App:** home address: uses the server's home-network address automatically on home Wi-Fi
- **App:** trusts the server's own certificate (pinned), alongside regular certificates
- **App:** warnings for unencrypted connections (http:// server addresses, SMB shares without encryption)
- **Project:** Dependabot updates, a vulnerability scan of the server image, and CodeQL code scanning
  (runs once the repository is public)

## App 0.9.1
- Fixed: clips recorded with the 0.9.0 engine were rotated 90° and squashed. Recordings now use the camera
  image exactly as the sensor delivers it, as before 0.9.0

## App 0.9.0 · Server 0.9.0
- **App:** crash-resistant recording. Clips are written as fragmented MP4 and saved continuously, so a crash
  or power loss costs at most about a second; clip lengths are now exact. New recording engine (camera →
  GPU → hardware encoder), which also handles the date/time stamp and time-lapse
- **App:** screen-off check: ODC verifies whether recording keeps going whenever the screen is off for 20
  seconds, with a guided test in setup and Settings
- **App:** "All cameras" plays a car's cameras side by side in sync, streamed from the ODC Server
- **App:** optional release signing with your own key in CI
- **Server:** retention per car (including "keep forever") and storage limits per person
- **Server:** play phone-encrypted clips by entering the passphrase (not stored; decrypted copy removed after an hour)
- **Server:** browser notifications (Web Push) for alerts, even with the page closed

## App 0.8.1
- Date and time stamp burned into the video (bottom-left, upright however the phone is mounted), with
  optional speed and GPS coordinates; never shows location inside privacy zones
- The phone's clock is corrected using GPS time, or the ODC Server's time when there's no GPS, for accurate
  clip names, stamps and multi-camera sync

## App 0.8.0 · Server 0.8.0
- **App:** privacy zones are drawn and edited on a map: tap to add, tap a zone to change it, tap again to move it
- **App:** tracking-only mode (with an ODC Server): reports position and speed in the background without
  recording; keeps positions while offline and sends them later; pauses while recording; optionally
  resumes after a restart
- **App:** Map View in Clips (with an ODC Server): clips shown where they were recorded, grouped when close
  together; tap to play
- **Server:** analyze existing footage for smart search and plates by date range or car, retry failures or
  redo analysis; background analysis keeps going until the backlog is done
- **Server:** accepts tracking-only positions, including batches sent late after being offline

## Server 0.7.1
- Fixed: after updating the server, browsers could keep using the old web app for up to an hour, so new
  features and fixes didn't appear until a hard refresh. Updates now show on the next page load
- Units set to "Automatic" also work when the browser's language has no country (falls back to the
  browser's regional format), and the setting shows which units it picked

## App 0.4.1 · Server 0.7.0
- **Server:** optional license plate reading and search, and an optional plate log with a review page
  for each plate: cropped sightings, fix misreads, remove false readings, merge duplicates (likely
  duplicates are suggested), and notes. Readings are kept for the number of days you choose, or forever
- **App:** backup rules (what to upload, after upload, cellular, charging) now apply to the ODC Server and
  SMB alike and can be set when only one of them is used
- **App:** clip thumbnails keep the right shape and orientation

## Server 0.6.0
- Search page: search footage by what's in it (smart search, optional ML container) and by place,
  car and camera names; results open at the matching moment

## Server 0.5.0
- Synced playback of all of a car's cameras
- Place names for clips and trips (GeoNames, looked up on the server)
- Split and merge trips; two-factor sign-in with recovery codes
- Optional commute learning: names trips like "Home → Work" and keeps short stops from splitting a commute
- Fixed: the car marker on the map could stretch across the screen

## App 0.4.0 · Server 0.4.0
- First release of the ODC Server: timeline, live and history map, trips, sharing, alerts, retention
- App: pair with an ODC Server by QR code; back up to the server; live location and status reports;
  browse server clips
- App: version, build number and commit shown in the app

## App 0.3.1
- Encrypt clips on the phone on demand; encrypted clips are marked with a key icon
- Clips and settings can be used in portrait; recording stays landscape

## App 0.3.0
- Backup to SMB shares with resumable, verified uploads; Wi-Fi/cellular rules; encrypted uploads
- Clip browser with thumbnails, filters and backup status

## App 0.2.0
- Motion-activated and time-lapse parking, impact detection, GPS/speed logging, subtitles,
  privacy zones, auto-start on charging or car Bluetooth

## App 0.1.0
- Core recorder: single and dual camera, loop recording, parking mode, battery cutoff, overheating
  protection, dimmed or screen-off recording
