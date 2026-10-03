# Changelog

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
