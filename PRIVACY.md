# Privacy policy

Open Dash Cam is open-source software. **The Open Dash Cam project does not collect, receive or store any of your
data.** There are no accounts with the project, no analytics, no advertising and no tracking. Everything the app
records stays on your phone, or goes to storage you set up and control yourself.

This policy covers the Open Dash Cam Android app and the ODC Server. It applies to the official builds published
from this repository.

## What the app records, and where it goes

| Data | Stored | Sent anywhere? |
| --- | --- | --- |
| Video (and audio, if you turn audio on) | On your phone | Only to backup destinations you configure: your ODC Server and/or your SMB network share |
| Location, speed and heading (if GPS logging is on) | On your phone, with the clips | To your ODC Server if you connect one (live position, tracking-only mode, clip tracks). Never inside privacy zones you set |
| Phone status (battery, temperature, storage) | On your phone | To your ODC Server if you connect one |
| Settings, passphrases, server tokens | On your phone, encrypted where they are secrets | No |

The app sends nothing to the Open Dash Cam project or any third party on its own. It connects only to the
servers you enter (your ODC Server and/or SMB share) and to the map tile service described below.

## Permissions the app asks for

- **Camera:** to record video. Only while recording or showing the camera preview.
- **Microphone:** only if you turn audio recording on.
- **Location:** only if you turn on GPS logging, privacy zones by your location, live location or tracking-only mode.
  "Allow all the time" is only requested if you turn on resuming tracking-only mode after a restart.
- **Notifications:** to show recording status and alerts.
- **Nearby devices / Bluetooth:** only if you choose to start recording when the phone connects to your car's Bluetooth.
- **Battery optimization exemption:** so Android doesn't stop recording in the background.
- **Display over other apps:** only if you allow it, so auto-start (on charging or Bluetooth) can open the recording screen.

## Maps

Map screens load map images and data from OpenFreeMap (tiles.openfreemap.org), which receives your device's IP
address and the map area being viewed, as with any website. This doesn't include your recordings or location history.
Server owners can configure a different map provider.

## The ODC Server

The ODC Server runs on hardware you own and control. Its data (footage, locations, trips, accounts, activity log,
and optional license plate readings) stays on that server. Optional features connect to services you choose:
ntfy or your browser's push service for alerts, an MQTT broker for Home Assistant, Let's Encrypt for HTTPS
certificates, Viofo dashcams on your network, and one-time downloads of open-source models for smart search,
plate reading and face blurring. Whoever runs a server is responsible for how its data is used, including meeting
local laws on recording video, audio and license plates.

## Children

Open Dash Cam isn't directed at children.

## Changes and contact

Changes to this policy are published in this file, in the project's public repository. Questions or concerns: open
an issue in the repository.
