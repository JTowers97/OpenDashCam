# Changelog

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
