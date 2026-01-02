## Playback speed (Roku / Playlet) — WIP handoff notes

Goal: implement experimental playback speed by **rewriting streaming timing via Playlet’s on-device web server** (no native Roku `playbackRate`).

This branch contains both Phase A and Phase B experiments. **Phase B is incomplete / not yet proven working**.

### What we attempted / implemented

- **Preference plumbing**
  - Added preference key `playback.speed` (string, default `"1.0"`, hidden).
  - `VideoContentJob` reads `playback.speed` and appends `speed=<value>` to `/api/dash` URLs (non-DRM only).

- **Player UI**
  - Added a `SpeedButton` to the player bar.
  - Added a `SpeedSelector` modal screen to pick speed.
  - Added focus-return plumbing via `returnFocusNode` (used by `AppController.PopScreen()`).

- **DRM gating**
  - Speed should be disabled for DRM.
  - Fixed prior behavior where stale `content.drmParams` could persist across videos and incorrectly disable speed:
    - `VideoContentJob` clears `contentNode.drmParams` at the start of job execution.
  - Updated DRM detection in the player to be less pessimistic and log why speed is disabled.

- **Phase A: manifest-only scaling (DASH)**
  - `DashRouter` parses `speed` and passes it into `DashManifest`.
  - `DashManifest` scales `mediaPresentationDuration` and `SegmentTimeline` durations by \(1/speed\).
  - Outcome: **MPD metadata changes did NOT produce real faster playback on Roku** (still felt 1.0x).

- **Phase B: media proxy + fMP4 timestamp rewriting (DASH only)**
  - Added `/api/media` (`MediaRouter`) to proxy segment requests and rewrite CMAF/fMP4 timing:
    - Fragment (`moof`): `tfdt` base decode time; `tfhd` default sample duration (when present); `trun` sample durations; `trun` composition time offsets.
    - Init (`moov/mvex/trex`): `default_sample_duration` (important for some streams).
  - `DashManifest` already wraps SegmentTemplate URLs through `/api/media` when `speed != 1.0`:
    - `initialization` and `media` URLs become `/api/media?url=<encodedBaseUrl>&sq=<...>&speed=<...>&kind=init|seg`
  - Added an INFO log in `/api/media` (“Media proxy: kind=…, speed=…, range=…”).

### What is still broken / unresolved

- **SpeedSelector still “breaks UI” / remote becomes unresponsive**
  - Pressing the Speed button pushes `SpeedSelector` (logs confirm `Opening SpeedSelector`, selector `Init`, selector `OnFocusChange`, etc.).
  - In debug builds, we previously hit a debugger break due to using `NodeSetFocus()` inside a boolean expression; that line was rewritten, but the user still reports the UI can become unresponsive and requires the Home button to exit.
  - Next step: treat this as a focus/key handling issue and make the selector robust:
    - ensure focus reliably lands on `speedList` and never traps focus on the container,
    - ensure `OnKeyEvent` does not swallow keys when not handling them,
    - compare behavior to `QualitySelector` which is known-good.

- **Playback speed not proven working**
  - Phase A manifest-only scaling did not change real playback rate.
  - Phase B requires that Roku actually requests SegmentTemplate (`sq=`) init+segments via `/api/media`.
  - Some videos only have SegmentBase (`initRange`/`indexRange`) streams; attempting to force “OTF-only” caused the MPD to have no usable A/V and Roku failed with:
    - `malformed data` / `demux.dash: Format has no audio or video`
  - Current mitigation: `DashManifest` detects whether OTF/post-live segments exist; if not, it logs and **falls back to 1.0x** even if speed was requested.

### How to pick test content that can exercise Phase B

- Innertube marks OTF formats as `type = "FORMAT_STREAM_TYPE_OTF"` → Playlet maps this to `format.isTypeOTF=true`.
- Innertube marks post-live DVR via `videoDetails.isPostLiveDvr=true`.
- In logs, look for either:
  - `Fetching OTF segment info`
  - `Fetching Post-Live DVR info`

Prefer:
- currently live streams (LIVE),
- recently-ended live streams with DVR (“past live”).

### Recommended next steps (to resume later)

1. **Make Phase B work for SegmentBase streams**
   - Either:
     - implement `/api/media` support for SegmentBase by proxying the `BaseURL` media file and correctly handling `Range` + rewriting timing while preserving correct `Content-Range`/`206`, or
     - restructure the MPD to avoid SegmentBase for these streams (if possible), or
     - detect unsupported streams and clearly indicate “speed unsupported for this video” in UI.

2. **Fix Range handling in `/api/media`**
   - Current behavior rewrites only when Range starts at 0 and buffers the whole upstream response into memory/temp file.
   - For real use, need robust `Range`/`206` pass-through, and ideally streaming (not full-buffer).

3. **Add proof-of-effect instrumentation**
   - Add stats overlay line that measures “wall clock delta vs position delta” to show real effective speed.

4. **Remove debug-only logs / temporary hardcodes**
   - `VideoContentJob.GetForcedPlaybackSpeed()` was used to force speeds for testing; should be disabled once UI works.

