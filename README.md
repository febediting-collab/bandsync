# BandSync 🎵

Synchronized audio playback for live bands — no IEM hardware needed.

## How it works

1. Host uploads an audio file (backing track / click track)
2. All band members open the same URL on their phones
3. Host presses Play — everyone hears it at the exact same time
4. Uses NTP-style clock sync + Web Audio API scheduled playback for ~5-10ms accuracy

## Setup (Local / Rehearsal)

```bash
npm install
node server.js
```

Open `http://YOUR_LOCAL_IP:3000` on all phones (same WiFi network).

## Deploy to Cloud (Recommended)

### Railway (Free tier):
1. Push to GitHub
2. Connect repo to railway.app
3. Deploy — get a public URL
4. Share URL with band

### Render / Fly.io also work fine.

## Tech Stack

- **Server**: Node.js + Express + ws (WebSocket)
- **Client**: Pure HTML/JS, Web Audio API
- **Sync**: NTP round-trip clock sync (10 rounds, median of best 5)
- **Playback**: Scheduled 2 seconds ahead via `audioCtx.start(scheduledTime)`

## Sync Accuracy

| Condition | Expected offset |
|---|---|
| Same device type, good WiFi | ~5-10ms |
| Mixed iOS/Android, good WiFi | ~10-30ms |
| Poor WiFi / mobile hotspot | ~20-50ms |

For click tracks: anything under 30ms is not perceivable.
For melodic backing tracks: aim for under 20ms.
