# Playlet muxer

Standalone muxing proxy intended for 4k VP9 + Opus streams. Requires ffmpeg and yt-dlp installed on the host.

Note: yt-dlp may require a JavaScript runtime (deno or node) for some YouTube formats. Install one and set MUXER_YTDLP_JS_RUNTIME if you see warnings about a missing JS runtime. The muxer auto-loads `.env` from the repo root when present.

## Run

go run .

# or

go build -o playlet-muxer .

## Configuration

Environment variables:

- MUXER_LISTEN_ADDR (default :8787)
- MUXER_SOURCE_BASE (default https://www.youtube.com/watch?v=)
- MUXER_CACHE_DIR (default ./cache)
- MUXER_CACHE_TTL_SECONDS (default 600)
- MUXER_YTDLP_PATH (default yt-dlp)
- MUXER_FFMPEG_PATH (default ffmpeg)
- MUXER_CONTAINER (webm or mkv, default webm)
- MUXER_YTDLP_JS_RUNTIME (default node; optional override, e.g. deno)
- MUXER_DASH_SEGMENT_SECONDS (default 4)
- MUXER_DASH_READY_TIMEOUT_SECONDS (default 60)
- MUXER_DASH_TRANSCODE (default true; transcodes to H.264/AAC with fMP4 segments for fast start/scrub)
- MUXER_MAX_VIDEO_TBR_KBPS (default 40000)
- MUXER_MAX_VIDEO_FPS (default 30)

## Request

GET /dash?v=VIDEO_ID&quality=2160p

(/mux is an alias for /dash)

Optional parameters:
- url (full source URL instead of v)
- container (webm or mkv)

## Behavior

- 4k (quality >= 2160): generates DASH manifest + WebM segments in cache; manifest references segments under `/dash/<key>/`; cache kept for TTL.
- Non-4k: streams live (no cache, no seek).
