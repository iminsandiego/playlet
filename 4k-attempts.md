# 4K Playback Attempts (Playlet + muxer)

Last updated: 2025-12-29 11:05 (approx; local time from logs)

This file summarizes the 4K playback work and experiments described in this chat (Playlet app + `tools/muxer`).

## Goal

- Confirm whether Playlet is actually receiving 4K (resolution/bitrate).
- Make Roku reliably play 4K sources when native 4K DASH codecs (AV1/HEVC) are not available.
- Preferably do this without the muxer long term, but use the muxer as a practical bridge.

## Baseline State (before changes)

- Playlet 4K strategy: use native DASH only when the device supports **AV1 or HEVC via DASH**; otherwise fall back to an external muxer for 4K.
- Muxer was delivering **live** VP9+Opus repackaged as **WebM**.
  - Symptom: video could play “live”, but **scrubbing/seeking didn’t work** (expected for a live pipe).
  - Uncertainty: hard to confirm if stream was truly 4K and what bitrate was being served.

## Attempt Timeline (from logs / chat context)

- 2025-12-28 ~18:06: initial muxer runs (`muxerlog.txt` shows `muxer listening on :8787` and `/dash?...quality=2160p`).
- 2025-12-28 ~23:30: first HLS endpoint test (`/mux?container=hls...`).
- 2025-12-29 ~09:24: Playlet starts requesting `/mux.m3u8?...container=hls...` and Roku reports `no valid bitrates` due to `init.mp4` 404.
- 2025-12-29 ~10:15–10:18: muxer serves `init.mp4` and `segment_*.m4s` with HTTP 200, but Roku stays in a “buffering / duration growing” state.

## Changes Tried (what/why/outcome)

### 1) Add muxer diagnostics (bitrate + resolution + throughput)

- **What changed**
  - `tools/muxer/main.go`: `yt-dlp` now prints a parseable `META ...` line with selected `format_id`, `width/height`, `fps`, and `tbr`.
  - `tools/muxer/main.go`: muxer logs the chosen stream selection and adds response headers:
    - `X-Muxer-Video-Resolution`
    - `X-Muxer-Video-Tbr-Kbps`
    - `X-Muxer-Format-Id`
  - `tools/muxer/main.go`: live stream logs periodic output throughput (avg + window kbps).
- **Why**
  - Needed confirmation that the muxer is actually selecting a 4K stream and roughly what bitrate it represents.
- **Outcome**
  - Success for visibility: `yt-dlp` logs showed 3840x2160 selections and `tbr_kbps` values (e.g. ~15–25 Mbps depending on video).
  - Did not solve scrubbing; only improved observability.

### 2) Introduce muxer HLS endpoint and have Playlet prefer it for 4K

- **What changed**
  - `tools/muxer/main.go`: added `/hls` endpoint and allowed `container=hls` to route to it.
  - `playlet-lib/src/components/VideoPlayer/VideoContentJob.bs`: Playlet now tries muxer HLS first for 4K, with WebM as fallback.
- **Why**
  - Roku’s published constraints indicate VP9 isn’t usable via DASH; VP9 is expected to work via HLS packaging.
- **Outcome**
  - Initial HLS behavior didn’t play; led to deeper muxer fixes below.

### 3) Fix muxer HLS lifecycle / cleanup so output isn’t deleted mid-playback

- **What changed**
  - `tools/muxer/main.go`: removed the “waiters” cleanup logic that could delete HLS output shortly after redirect.
  - `tools/muxer/main.go`: added `.access` touch on segment/manifest requests and made cache cleanup respect `.access`.
- **Why**
  - The original code treated only the initial `/hls` request as “active”, so the job could be cancelled/deleted while the Roku player was still fetching segments.
- **Outcome**
  - Prevented premature deletion; still didn’t fix playback.

### 4) Stop redirecting the initial HLS request; serve manifest directly and rewrite URIs

- **What changed**
  - `tools/muxer/main.go`: instead of `302` redirecting to `/hls/hls-<key>/index.m3u8`, the muxer now **serves the manifest content directly** and rewrites segment URIs to absolute `/hls/hls-<key>/...`.
  - Added explicit endpoints `GET /mux.m3u8` and `GET /hls.m3u8` to help Roku identify the format.
- **Why**
  - Logs showed Roku often **did not follow the redirect** reliably for the initial HLS URL.
  - Roku format detection seems more reliable when the URL ends in `.m3u8`.
- **Outcome**
  - Roku began requesting the HLS files, but further issues appeared with segment format and init file generation.

### 5) Switch HLS segment format from TS to CMAF/fMP4 and transcode audio to AAC

- **What changed**
  - `tools/muxer/main.go`: HLS generation moved to:
    - `#EXT-X-MAP:URI="init.mp4"`
    - `.m4s` segments (`-hls_segment_type fmp4`)
    - audio transcoded to AAC (`-c:a aac -b:a 192k -ac 2`)
- **Why**
  - Earlier TS-based HLS output was not valid for VP9 video (ffprobe indicated TS had “bin_data” + Opus, not a usable VP9 video elementary stream).
  - AAC is widely supported and avoids Opus-in-HLS issues on Roku.
- **Outcome**
  - Roku started fetching `init.mp4` but encountered 404 (next item).

### 6) Fix `init.mp4` 404 due to ffmpeg writing outputs to the wrong directory

- **What changed**
  - `tools/muxer/main.go`:
    - `cmd.Dir = job.dir` for ffmpeg HLS job.
    - output names switched to relative (`index.m3u8`, `segment_%d.m4s`) so all artifacts land in `cache/hls-<key>/`.
    - readiness checks require `init.mp4` to exist before serving manifest.
  - Added detailed file-server logging of response status/bytes for `/hls/...`.
- **Why**
  - Roku was requesting `/hls/hls-<key>/init.mp4` but muxer was writing `init.mp4` to the muxer’s working directory, causing 404s and `no valid bitrates`.
- **Outcome**
  - Fixed: Roku started receiving HTTP 200 for `init.mp4` and `segment_*.m4s`.

### 7) “Permanent buffering”: prevent partial segment reads and add codec fallback option

- **Observed symptom**
  - Roku stayed in a buffering-like state; the duration counter “grew” as more segments appeared, then stopped at full length, but playback never started.
  - Muxer logs showed heavy repeated GETs for the same segments (especially `segment_0.m4s`), implying the player could not successfully initialize decode.
- **What changed**
  - `tools/muxer/main.go`:
    - Added `-hls_flags independent_segments+temp_file` so Roku won’t fetch partially-written segments while ffmpeg is still writing them.
    - Added query param `vcodec=vp9|h264`:
      - default remains `vp9`
      - if `h264`, muxer transcodes video to H.264 with forced keyframes aligned to segment boundaries.
    - HLS cache key now includes `vcodec` and a new version suffix.
  - `playlet-lib/src/components/VideoPlayer/VideoContentJob.bs`:
    - Added device checks for `vp9/hls` and `h264/hls`.
    - Playlet selects `vcodec=h264` for muxer HLS when VP9/HLS isn’t reported as supported.
- **Why**
  - Two likely causes of the buffering state:
    1) Roku was reading segments while they were still being written.
    2) The Roku device didn’t actually support VP9 in CMAF HLS on that model/firmware (despite “VP9 is supported in HLS” guidance).
- **Outcome**
  - Implemented, but playback still failed; see Attempt #8.

### 8) HLS `vcodec=h264` (H.264 transcode): still buffers (high CPU)

- **When**
  - 2025-12-29 11:02–11:05 (approx; from `debuglog.txt` + `muxerlog.txt`).
- **What changed**
  - Playlet selected `vcodec=h264` for muxer HLS because `CanDecodeVideo(vp9/hls)` returned false while `CanDecodeVideo(h264/hls)` returned true (`debuglog.txt` ~11:02:39).
  - Playlet requested `http://192.168.1.132:8787/mux.m3u8?vcodec=h264&container=hls&v=-F2Z8gMpfiA&quality=2160p`.
  - Muxer transcoded video to H.264 (`libx264`) while continuing to serve CMAF/fMP4 HLS (`init.mp4` + `.m4s`) with AAC audio.
- **Why**
  - VP9-in-HLS still wasn’t starting playback; H.264-in-HLS is the most broadly supported fallback, at the cost of CPU.
- **Observed behavior**
  - Muxer selected a 4K source (`yt-dlp selection ... width=3840 height=2160 fps=60 tbr_kbps=25907` at ~11:02:44).
  - Roku fetched `init.mp4` and many `.m4s` segments successfully (HTTP 200/206 range requests) (`muxerlog.txt` ~11:03–11:04).
  - Playback never started (UI stayed in a buffering-like state; duration/position advanced as segments appeared, then stalled).
- **Outcome**
  - Still failed to start playback and pegged CPU on the muxer host due to `libx264` transcode.
  - Likely remaining issue: HLS/CMAF packaging expectations on Roku (init/segment structure, timestamps, keyframe alignment, playlist semantics) rather than simply “VP9 vs H.264”.

## Notes / Findings

- The official YouTube Roku app likely uses private/partner playback flows and client attestation; Playlet can’t reliably “force YouTube to provide 4K VP9 as standard public HLS”.
- The muxer approach remains the practical method for 4K on Roku when native 4K DASH codecs aren’t available.
- Roku making back-to-back `.m3u8` requests and many overlapping segment GETs is expected; the muxer was updated to handle this more safely (job sharing + avoiding premature cleanup).
