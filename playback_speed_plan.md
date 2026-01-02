# Playback speed (Roku) — current plan (Option C only)

This document is the **current** plan for experimental playback speed on Roku.

- Historical context and prior decisions live in [`/playback_speed_plan.md`](../playback_speed_plan.md).
- The old plan referenced `VideoPlayerDev`; that component no longer exists. The current player is `playlet-lib/src/components/VideoPlayer/VideoPlayer.{xml,bs}`.

## Decision: Option C only (no native playbackRate)

Roku’s SceneGraph `Video` does not provide a public, reliable `playbackRate` control. The approach is to implement speed by rewriting timing in streaming manifests and (if needed) segment timestamps via Playlet’s on-device web server.

## Research links

- `https://github.com/iBicha/playlet/issues/235`
- `https://community.roku.com/discussions/tv-and-players/roku-playback-speed-options/1104390`
- `https://community.bitmovin.com/t/playback-speed-and-quality-setting-on-roku/1627`
- `https://community.roku.com/discussions/tv-and-players/youtube-app-has-playback-speed-on-only-some-devices/891097`
- `https://community.roku.com/discussions/apps-and-viewing/youtube-on-roku-no-longer-allows-playback-speed-adjustment-like-on-a-browser-/894229`
- `https://support.plex.tv/articles/video-playback-speed-controls/`

## Current implementation targets (today’s repo)

### Preference + UI

- Preference key: `playback.speed` (string, default `"1.0"`, hidden)
  - `playlet-lib/src/config/preferences.json5`
- Selector UI (reused for in-player overlay):
  - `playlet-lib/src/components/Screens/SettingsScreen/SpeedSelector/SpeedSelector.xml`
  - `playlet-lib/src/components/Screens/SettingsScreen/SpeedSelector/SpeedSelector.bs`
- Player wiring:
  - `playlet-lib/src/components/VideoPlayer/VideoPlayer.xml`
  - `playlet-lib/src/components/VideoPlayer/VideoPlayer.bs`
  - `playlet-lib/src/components/VideoPlayer/PlayerUi.bs`
### Stream URL generation (threading `speed` into manifest URLs)

- `playlet-lib/src/components/VideoPlayer/VideoContentJob.bs`
  - `AddDashUrls(...)` builds `/api/dash?...` URLs
  - `AddHlsUrls(...)` builds `/api/hls?...` URLs
### On-device web server (manifest rewrite endpoints)

- Route registration: `playlet-lib/src/components/Web/PlayletWebServer/PlayletWebServer.bs`
- DASH route: `playlet-lib/src/components/Web/PlayletWebServer/Middleware/DashRouter.bs`
- HLS route: `playlet-lib/src/components/Web/PlayletWebServer/Middleware/HlsRouter.bs`
- DASH generator: `playlet-lib/src/components/Services/Dash/DashManifest.bs`
## Phased approach

### Phase A (DASH-first): manifest-only timing scaling

Goal: cheaply test whether Roku honors timing changes in manifests.

- DASH: scale `SegmentTimeline` durations (`S@d`) in `DashManifest` for `SegmentTemplate` cases.
- Update MPD-level duration (`mediaPresentationDuration`) consistently.
- Thread `speed=<rate>` through `VideoContentJob -> /api/dash -> DashManifest`.

**Scope**:
- DASH-first.
- **Disable for DRM** (Widevine): do not offer speed control when DRM is active.

### Phase B (if Phase A does not change real playback rate): media proxy + fMP4 timestamp rewrite

Goal: enforce effective playback speed by rewriting fMP4 timestamps.

- Add `/api/media` proxy endpoint.
- Rewrite segment URLs in the MPD to point to the proxy when `speed != 1.0`.
- Rewrite CMAF fMP4 timing (`moof/tfdt`, `moof/trun`, etc.).

**Important**: the built-in on-device web server does not implement Range/206 natively, so `/api/media` must explicitly handle `Range` requests to avoid full-segment buffering.
