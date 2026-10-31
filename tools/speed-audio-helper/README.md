# Speed-audio helper

An optional companion service. It improves how Playlet sounds at playback speeds other than 1x.

## Why

Roku's `playbackSpeed` time-stretcher processes the left and right channels separately. With stereo audio at
1.25x or 1.5x, the same sound reaches each ear up to about ±10 ms apart. Which ear hears it first changes from
sound to sound. About 15% of short sounds reach only one ear, so voices seem to jump between left and right.

Mono audio comes out of the stretcher identical in both ears. YouTube offers no mono streams, and a Roku app
can't decode or re-encode audio. So this helper runs on another computer on the same network. It converts the
video's AAC track to mono AAC and serves it to Playlet as DASH segments.

## Behaviour

- **Off by default.** Playlet uses the helper only when **Settings → Playback defaults → Speed audio helper** is
  set, for example `http://192.168.1.10:8098`. The setting is per Roku device.
- **Only away from 1x.** At 1x, Playlet plays the video's normal stereo audio. Choosing another speed
  mid-video reloads the stream at the current position, which takes about one second. A video that starts at
  a non-1x default speed uses the helper from the start.
- **Falls back.** If the helper doesn't answer its health check within 1.5 s, Playlet uses the video's own
  audio, as it would without a helper. Live streams, DRM-protected audio and Invidious-proxied streams always
  use the video's own audio.

## Running it

It needs Python 3 (standard library only) and `ffmpeg`.

```bash
python3 helper.py   # listens on :8098
curl http://localhost:8098/health
```

For a background service with systemd user units:

```bash
mkdir -p ~/playlet-speed-audio && cp helper.py ~/playlet-speed-audio/
cp playlet-speed-audio.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now playlet-speed-audio
loginctl enable-linger "$USER"   # keep it running after logout
```

## Environment variables

| Variable | Default | |
|---|---|---|
| `PLAYLET_SPEED_AUDIO_PORT` | `8098` | Listening port |
| `PLAYLET_SPEED_AUDIO_CACHE` | `~/.cache/playlet-speed-audio` | Transcoded segments; cleared at start |
| `PLAYLET_SPEED_AUDIO_CACHE_ENTRIES` | `12` | Videos kept; least recently used are evicted |
| `PLAYLET_SPEED_AUDIO_BITRATE` | `96k` | Mono AAC bitrate |

## How it works

On the first request for a video, the helper downloads the YouTube AAC stream in 2 MB range requests.
googlevideo throttles a single long request to about 2x realtime but not short ranges. It pipes the stream
into one ffmpeg, which writes 4-second mono segments, at roughly 80-200x realtime.

A request far beyond the transcode front (a seek) starts a second transcode from the matching `sidx`
fragment. Its segment timestamps are rewritten to the real position when served.

Only `*.googlevideo.com` sources are accepted. The helper has no authentication, so run it only on a trusted
home network.
