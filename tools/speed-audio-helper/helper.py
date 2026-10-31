#!/usr/bin/env python3
"""Playlet speed-audio helper: serves a mono copy of a YouTube audio track as DASH segments.

Roku's playbackSpeed time-stretcher processes left and right independently, so stereo audio at 1.25x/1.5x
smears between the ears. Mono input comes out identical in both ears. Playlet cannot downmix on the Roku,
so when a helper is configured it points the audio AdaptationSet of its DASH manifest here.

Endpoints
  GET /health                         -> {"service": "playlet-speed-audio", "version": N}
  GET /probe?v=ID&itag=N&src=URL      -> {"mono": bool, "side_db": float}: is the source effectively mono?
  GET /a/init.mp4?v=ID&itag=N&src=URL -> fMP4 init segment (mono AAC)
  GET /a/{n}.m4s?v=ID&itag=N&src=URL  -> media segment n (1-based), SEGMENT_SECONDS long

The first request for a (video, itag) starts one ffmpeg that downloads the source and writes segments
progressively; requests for segments not written yet wait for them. A request far ahead of the transcode
(a seek) starts a second transcode from that point. Only googlevideo.com sources are accepted.

Requires python3 (stdlib only) and ffmpeg. Configure with environment variables:
  PLAYLET_SPEED_AUDIO_PORT (8098), PLAYLET_SPEED_AUDIO_CACHE (~/.cache/playlet-speed-audio),
  PLAYLET_SPEED_AUDIO_CACHE_ENTRIES (12), PLAYLET_SPEED_AUDIO_BITRATE (96k).
"""
import array, hashlib, json, math, os, re, shutil, struct, subprocess, threading, time, urllib.error, urllib.parse, urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = 2
PORT = int(os.environ.get("PLAYLET_SPEED_AUDIO_PORT", "8098"))
CACHE = os.path.expanduser(os.environ.get("PLAYLET_SPEED_AUDIO_CACHE", "~/.cache/playlet-speed-audio"))
MAX_ENTRIES = int(os.environ.get("PLAYLET_SPEED_AUDIO_CACHE_ENTRIES", "12"))
BITRATE = os.environ.get("PLAYLET_SPEED_AUDIO_BITRATE", "128k")
SAMPLE_RATE = 44100        # output timescale; ffmpeg's AAC keeps the source rate (YouTube AAC is 44.1 kHz)
# Segments are a whole number of AAC frames (172 x 1024 samples = 3.9938 s), matching the manifest's
# SegmentTemplate duration exactly. With 4.000 s the joins drift up to a frame off the advertised grid and
# Roku's player trims/overlaps there, which is audible as clicks.
SEGMENT_SAMPLES = 172 * 1024
SEGMENT_SECONDS = SEGMENT_SAMPLES / SAMPLE_RATE
# ffmpeg counts frames from the encoder's priming frame (pts -1024 samples) and cuts at the first frame whose
# offset from it reaches k * seg_duration. A hair over the exact length makes it cut at frame 172k+1, so
# segment 1 holds priming + 172 frames and every later segment starts exactly at (k-1) * 176128 samples, on
# the manifest grid (valid for ~11000 segments, 12 hours).
SEG_DURATION_ARG = f"{SEGMENT_SECONDS + 0.000002:.6f}"
WAIT_SECONDS = 45          # longest a segment request waits for the transcode
SEEK_AHEAD_SEGMENTS = 20   # a request this far past the transcode front starts a transcode from there
MONO_SIDE_DB = -30.0       # L-R energy this far below L+R in every probed stretch counts as mono
ALLOWED_HOST = re.compile(r"(^|\.)googlevideo\.com$")

_lock = threading.Lock()
_jobs = {}  # key -> Job


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


CHUNK = 2 * 1024 * 1024    # googlevideo throttles one long request to ~2x realtime but not short ranges


def fetch_range(url, first, last):
    """GET bytes first..last (inclusive). Returns (data, total_length or None)."""
    req = urllib.request.Request(url, headers={"Range": f"bytes={first}-{last}", "User-Agent": "Mozilla/5.0"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                data = r.read()
                total = None
                cr = r.headers.get("Content-Range", "")
                if "/" in cr and cr.rsplit("/", 1)[1].isdigit():
                    total = int(cr.rsplit("/", 1)[1])
                return data, total
        except urllib.error.HTTPError as e:
            if e.code == 416:
                return b"", None
            if attempt == 3:
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            if attempt == 3:
                raise
        time.sleep(0.5 * (attempt + 1))
    return b"", None


def parse_index(head):
    """From the start of a fragmented MP4 (YouTube DASH audio): init end offset and sidx fragments
    [(byte_offset, start_seconds)], or None if the layout isn't ftyp/moov/sidx."""
    off, init_end, frags = 0, None, None
    while off + 8 <= len(head):
        size, typ = struct.unpack(">I4s", head[off:off + 8])
        if size < 8 or off + size > len(head):
            break
        if typ == b"moov":
            init_end = off + size
        elif typ == b"sidx":
            ver = head[off + 8]
            timescale = struct.unpack_from(">I", head, off + 16)[0]
            p = off + 20
            if ver == 0:
                ept, first = struct.unpack_from(">II", head, p); p += 8
            else:
                ept, first = struct.unpack_from(">QQ", head, p); p += 16
            count = struct.unpack_from(">H", head, p + 2)[0]; p += 4
            pos, t = off + size + first, ept
            frags = []
            for _ in range(count):
                ref, dur, _sap = struct.unpack_from(">III", head, p); p += 12
                frags.append((pos, t / timescale))
                pos += ref & 0x7FFFFFFF; t += dur
            break
        off += size
    if init_end is None or not frags:
        return None
    return init_end, frags


class Run:
    """One ffmpeg transcode writing segments numbered from `first` into its own directory. The source is
    downloaded in short Range requests and piped in; a run past segment 1 starts at the sidx fragment
    covering its time (after the init bytes) and ffmpeg discards up to the exact start."""

    def __init__(self, job, first):
        self.first = first
        self.dir = os.path.join(job.dir, f"run{first}")
        os.makedirs(self.dir, exist_ok=True)
        start = (first - 1) * SEGMENT_SECONDS
        index = job.index()
        cmd = ["ffmpeg", "-nostdin", "-v", "error"]
        self.feed = None
        if index is not None:
            init_end, frags = index
            frag_off, frag_t = frags[0]
            for off, t in frags:
                if t <= start:
                    frag_off, frag_t = off, t
            prefix = job.head[:init_end] if start > 0 else b""
            self.feed = (job.src, prefix, frag_off if start > 0 else 0, job.total)
            cmd += ["-i", "pipe:0"]
            if start > 0:
                # a pipe can't seek: decode from the fragment start and discard up to the segment's time
                cmd += ["-ss", f"{start - frag_t:.6f}"]
        else:  # unknown layout: let ffmpeg read the URL itself (slower: googlevideo throttles it)
            cmd += ["-reconnect", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "4"]
            if start > 0:
                cmd += ["-ss", str(start)]
            cmd += ["-i", job.src]
        cmd += ["-vn", "-map", "0:a:0", "-ac", "1", "-ar", str(SAMPLE_RATE), "-c:a", "aac", "-aac_coder", "twoloop", "-b:a", BITRATE,
                "-f", "dash", "-seg_duration", SEG_DURATION_ARG, "-use_template", "1", "-use_timeline", "0",
                "-init_seg_name", "init.mp4", "-media_seg_name", "seg-$Number$.m4s",
                "-dash_segment_type", "mp4", os.path.join(self.dir, "out.mpd")]
        self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE if self.feed else subprocess.DEVNULL, stderr=subprocess.PIPE)
        self.started = time.monotonic()
        threading.Thread(target=self._drain, daemon=True).start()
        if self.feed:
            threading.Thread(target=self._pump, daemon=True).start()
        log("transcode start", job.key[:10], "from segment", first, "piped" if self.feed else "direct")

    def _pump(self):
        src, prefix, pos, total = self.feed
        try:
            if prefix:
                self.proc.stdin.write(prefix)
            while total is None or pos < total:
                data, t = fetch_range(src, pos, pos + CHUNK - 1)
                total = total or t
                if not data:
                    break
                self.proc.stdin.write(data)
                pos += len(data)
        except (BrokenPipeError, ValueError):
            pass  # ffmpeg stopped (killed or finished)
        except Exception as e:  # noqa: BLE001 - report and let ffmpeg finish with what it has
            log("download error", repr(e)[:200])
        finally:
            try:
                self.proc.stdin.close()
            except Exception:  # noqa: BLE001
                pass

    def _drain(self):
        err = self.proc.stderr.read().decode(errors="replace").strip()
        rc = self.proc.wait()
        log("transcode done" if rc == 0 else "transcode exit", self.first, f"{time.monotonic() - self.started:.1f}s", rc, err[-300:])

    def done(self):
        return self.proc.poll() is not None

    def local(self, n):
        return n - self.first + 1  # ffmpeg numbers each run from 1

    def path(self, n):
        return os.path.join(self.dir, f"seg-{self.local(n)}.m4s")

    def ready(self, n):
        if n < self.first or not os.path.exists(self.path(n)):
            return False
        # a segment is complete once the next exists, or ffmpeg has finished
        return self.done() or os.path.exists(os.path.join(self.dir, f"seg-{self.local(n) + 1}.m4s"))

    def front(self):
        n = self.first
        while os.path.exists(self.path(n)):
            n += 1
        return n - 1  # highest segment written (possibly still growing)


class Job:
    def __init__(self, key, src):
        self.key, self.src = key, src
        self.dir = os.path.join(CACHE, key)
        self.runs = []
        self.used = time.monotonic()
        self.head = None   # first bytes of the source (init + sidx)
        self.total = None  # source length
        self._index = False
        self._probe = None
        self._probe_lock = threading.Lock()
        os.makedirs(self.dir, exist_ok=True)

    def index(self):
        if self._index is False:
            self._index = None
            try:
                for size in (65536, 1048576):
                    self.head, self.total = fetch_range(self.src, 0, size - 1)
                    self._index = parse_index(self.head)
                    if self._index:
                        break
            except Exception as e:  # noqa: BLE001
                log("index fetch failed", repr(e)[:200])
        return self._index

    def run_for(self, n):
        """The run that has or will produce segment n, starting one if none will reach it soon."""
        self.index()  # network fetch: before taking the shared lock
        with _lock:
            self.used = time.monotonic()
            best = None
            for r in self.runs:
                if r.first <= n and (r.ready(n) or (not r.done() and n - r.front() <= SEEK_AHEAD_SEGMENTS)):
                    if best is None or r.first > best.first:
                        best = r
            if best is None:
                best = Run(self, n if self.runs else 1)
                self.runs.append(best)
            return best

    def init_path(self):
        r = self.run_for(1)
        p = os.path.join(r.dir, "init.mp4")
        return p, r

    def probe(self):
        """Whether the source is effectively mono (L and R identical within MONO_SIDE_DB in every sampled
        stretch). Roku's stretcher keeps identical channels identical, so such videos don't need the helper."""
        with self._probe_lock:
            if self._probe is not None:
                return self._probe
            index = self.index()
            if index is None:
                self._probe = {"mono": False, "reason": "no index"}
                return self._probe
            init_end, frags = index

            def side_db(frac):
                i = min(len(frags) - 2, int(len(frags) * frac))
                if i < 0:
                    return None
                start, end = frags[i][0], frags[i + 1][0] - 1
                data, _ = fetch_range(self.src, start, min(end, start + 400000))
                pcm = subprocess.run(["ffmpeg", "-v", "error", "-i", "pipe:0", "-ac", "2", "-ar", "8000", "-f", "s16le", "-"],
                                     input=self.head[:init_end] + data, capture_output=True).stdout
                a = array.array("h", pcm[: len(pcm) // 4 * 4])
                mid = side = 0.0
                for k in range(0, len(a) - 1, 2):
                    l, r = a[k], a[k + 1]
                    mid += (l + r) * (l + r); side += (l - r) * (l - r)
                return 10 * math.log10(side / mid + 1e-20) if mid > 1e6 else None

            results = [None] * 3
            threads = [threading.Thread(target=lambda j, f: results.__setitem__(j, side_db(f)), args=(j, f))
                       for j, f in enumerate((0.15, 0.5, 0.85))]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            measured = [v for v in results if v is not None]
            worst = max(measured) if measured else 0.0  # nothing measurable: treat as stereo
            self._probe = {"mono": worst < MONO_SIDE_DB, "side_db": round(worst, 1)}
            log("probe", self.key[:10], self._probe)
            return self._probe

    def stop(self):
        for r in self.runs:
            if not r.done():
                r.proc.kill()


def _boxes(buf, off, end):
    while off + 8 <= end:
        size, typ = struct.unpack(">I4s", buf[off:off + 8])
        if size < 8:
            return
        yield off, size, typ
        off += size


def shift_decode_time(data, ticks):
    """Add `ticks` to every tfdt baseMediaDecodeTime (and sidx earliest_presentation_time): a seek run's
    ffmpeg starts its timeline at 0, but Roku must place the segment at its real position."""
    buf = bytearray(data)
    for off, size, typ in _boxes(buf, 0, len(buf)):
        if typ == b"sidx":
            ver = buf[off + 8]
            p = off + 8 + 4 + 4 + 4  # header, version/flags, reference_ID, timescale
            if ver == 0:
                struct.pack_into(">I", buf, p, struct.unpack_from(">I", buf, p)[0] + ticks)
            else:
                struct.pack_into(">Q", buf, p, struct.unpack_from(">Q", buf, p)[0] + ticks)
        elif typ == b"moof":
            for toff, tsize, ttyp in _boxes(buf, off + 8, off + size):
                if ttyp != b"traf":
                    continue
                for doff, dsize, dtyp in _boxes(buf, toff + 8, toff + tsize):
                    if dtyp == b"tfdt":
                        ver = buf[doff + 8]; p = doff + 12
                        if ver == 1:
                            struct.pack_into(">Q", buf, p, struct.unpack_from(">Q", buf, p)[0] + ticks)
                        else:
                            v = struct.unpack_from(">I", buf, p)[0] + ticks
                            if v > 0xFFFFFFFF:
                                raise ValueError("tfdt overflow")
                            struct.pack_into(">I", buf, p, v)
    return bytes(buf)


def get_job(params):
    src = params.get("src", [""])[0]
    host = urllib.parse.urlparse(src).hostname or ""
    if not ALLOWED_HOST.search(host):
        raise ValueError("src must be a googlevideo.com URL")
    v = params.get("v", [""])[0]; itag = params.get("itag", [""])[0]
    key = hashlib.sha1(f"{v}|{itag}|{BITRATE}|{VERSION}".encode()).hexdigest()
    with _lock:
        job = _jobs.get(key)
        if job is None:
            job = _jobs[key] = Job(key, src)
            _evict()
        else:
            job.src = src  # newest signed URL for any new transcode
        return job


def _evict():
    if len(_jobs) <= MAX_ENTRIES:
        return
    for key, job in sorted(_jobs.items(), key=lambda kv: kv[1].used)[: len(_jobs) - MAX_ENTRIES]:
        job.stop(); shutil.rmtree(job.dir, ignore_errors=True); del _jobs[key]
        log("evicted", key[:10])


def wait_for(pred):
    end = time.monotonic() + WAIT_SECONDS
    while time.monotonic() < end:
        if pred():
            return True
        time.sleep(0.05)
    return False


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def send(self, code, body, ctype="application/octet-stream"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        params = urllib.parse.parse_qs(u.query)
        try:
            if u.path == "/health":
                return self.send(200, json.dumps({"service": "playlet-speed-audio", "version": VERSION}).encode(), "application/json")
            if u.path == "/probe":
                return self.send(200, json.dumps(get_job(params).probe()).encode(), "application/json")
            if u.path == "/a/init.mp4":
                job = get_job(params)
                p, r = job.init_path()
                if not wait_for(lambda: os.path.exists(p) and os.path.getsize(p) > 0 and (r.ready(1) or r.done())):
                    return self.send(504, b"init not ready")
                return self.send(200, open(p, "rb").read(), "audio/mp4")
            m = re.fullmatch(r"/a/(\d+)\.m4s", u.path)
            if m:
                n = int(m.group(1))
                job = get_job(params)
                r = job.run_for(n)
                t0 = time.monotonic()
                if not wait_for(lambda: r.ready(n)):
                    log("timeout segment", n, job.key[:10])
                    return self.send(504, b"segment not ready")
                waited = time.monotonic() - t0
                if waited > 1:
                    log(f"segment {n} waited {waited:.1f}s")
                data = open(r.path(n), "rb").read()
                if r.first > 1:  # seek run: move its 0-based timeline to the segment's real position
                    data = shift_decode_time(data, (r.first - 1) * SEGMENT_SAMPLES)
                return self.send(200, data, "audio/mp4")
            return self.send(404, b"not found")
        except ValueError as e:
            return self.send(400, str(e).encode())
        except (BrokenPipeError, ConnectionResetError):
            return


def main():
    os.makedirs(CACHE, exist_ok=True)
    for d in os.listdir(CACHE):  # a restart forgets jobs; clear their files
        shutil.rmtree(os.path.join(CACHE, d), ignore_errors=True)
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    srv.daemon_threads = True
    log(f"playlet speed-audio helper v{VERSION} on :{PORT}, cache {CACHE}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
