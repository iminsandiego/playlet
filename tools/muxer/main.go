package main

import (
    "bufio"
    "bytes"
    "context"
    "crypto/sha256"
    "encoding/hex"
    "errors"
    "fmt"
    "io"
    "log"
    "net/http"
    "os"
    "os/exec"
    "path/filepath"
    "strconv"
    "strings"
    "sync"
    "sync/atomic"
    "time"

    "github.com/joho/godotenv"
)

type Config struct {
    ListenAddr       string
    SourceBase       string
    CacheDir         string
    CacheTTL         time.Duration
    YtDlpPath        string
    FfmpegPath       string
    YtDlpJsRuntime   string
    DefaultContainer string
    DashSegmentDur   time.Duration
    DashReadyTimeout time.Duration
    DashTranscode    bool
    MaxVideoTbrKbps  int
    MaxVideoFps      int
}

type muxer struct {
    cfg         Config
    mu          sync.Mutex
    active      map[string]*dashJob
    lastCleanup time.Time
    reqCounter  uint64
}

type dashJob struct {
    key          string
    dir          string
    manifestPath string
    completePath string
    started      time.Time
    done         chan struct{}
    err          error
    ctx          context.Context
    cancel       context.CancelFunc
    waiters      int32
    cancelOnce   sync.Once
    served       uint32
}

func main() {
    cfg := loadConfig()

    ytPath, err := ensureExecutable(cfg.YtDlpPath)
    if err != nil {
        log.Fatalf("yt-dlp not found: %v", err)
    }
    ffPath, err := ensureExecutable(cfg.FfmpegPath)
    if err != nil {
        log.Fatalf("ffmpeg not found: %v", err)
    }
    if err := os.MkdirAll(cfg.CacheDir, 0755); err != nil {
        log.Fatalf("failed to create cache dir: %v", err)
    }

    log.Printf("yt-dlp path: %s", ytPath)
    log.Printf("ffmpeg path: %s", ffPath)
    log.Printf("config listen=%s cache_dir=%s cache_ttl=%s container=%s source_base=%s js_runtime=%s dash_seg=%s dash_ready_timeout=%s dash_transcode=%t max_video_tbr_kbps=%d max_video_fps=%d", cfg.ListenAddr, cfg.CacheDir, cfg.CacheTTL, cfg.DefaultContainer, cfg.SourceBase, cfg.YtDlpJsRuntime, cfg.DashSegmentDur, cfg.DashReadyTimeout, cfg.DashTranscode, cfg.MaxVideoTbrKbps, cfg.MaxVideoFps)

    m := newMuxer(cfg)

    mux := http.NewServeMux()
    mux.HandleFunc("/health", handleHealth)
    mux.HandleFunc("/mux", m.handleMux)
    mux.HandleFunc("/dash", m.handleMux)
    mux.Handle("/dash/", http.StripPrefix("/dash/", http.FileServer(http.Dir(cfg.CacheDir))))

    server := &http.Server{
        Addr:              cfg.ListenAddr,
        Handler:           mux,
        ReadHeaderTimeout: 10 * time.Second,
    }

    log.Printf("muxer listening on %s", cfg.ListenAddr)
    log.Fatal(server.ListenAndServe())
}

func loadConfig() Config {
    loadDotEnv()

    defaultJsRuntime := "node"
    jsRuntime := strings.TrimSpace(os.Getenv("MUXER_YTDLP_JS_RUNTIME"))
    if jsRuntime == "" {
        jsRuntime = defaultJsRuntime
    }

    dashReadyTimeoutSeconds := getEnvInt("MUXER_DASH_READY_TIMEOUT_SECONDS", 60)
    if dashReadyTimeoutSeconds <= 0 {
        dashReadyTimeoutSeconds = 60
    }

    cfg := Config{
        ListenAddr:       getEnv("MUXER_LISTEN_ADDR", ":8787"),
        SourceBase:       getEnv("MUXER_SOURCE_BASE", "https://www.youtube.com/watch?v="),
        CacheDir:         getEnv("MUXER_CACHE_DIR", "./cache"),
        CacheTTL:         time.Duration(getEnvInt("MUXER_CACHE_TTL_SECONDS", 600)) * time.Second,
        YtDlpPath:        getEnv("MUXER_YTDLP_PATH", "yt-dlp"),
        FfmpegPath:       getEnv("MUXER_FFMPEG_PATH", "ffmpeg"),
        YtDlpJsRuntime:   jsRuntime,
        DefaultContainer: strings.ToLower(getEnv("MUXER_CONTAINER", "webm")),
        DashSegmentDur:   time.Duration(getEnvInt("MUXER_DASH_SEGMENT_SECONDS", 4)) * time.Second,
        DashReadyTimeout: time.Duration(dashReadyTimeoutSeconds) * time.Second,
        DashTranscode:    getEnvBool("MUXER_DASH_TRANSCODE", true),
        MaxVideoTbrKbps:  getEnvInt("MUXER_MAX_VIDEO_TBR_KBPS", 40000),
        MaxVideoFps:      getEnvInt("MUXER_MAX_VIDEO_FPS", 30),
    }

    if cfg.DefaultContainer != "webm" && cfg.DefaultContainer != "mkv" {
        cfg.DefaultContainer = "webm"
    }

    return cfg
}

func loadDotEnv() {
    paths := []string{".env", filepath.Join("..", ".env")}
    for _, path := range paths {
        if _, err := os.Stat(path); err == nil {
            if err := godotenv.Load(path); err != nil {
                log.Printf("failed to load %s: %v", path, err)
            } else {
                log.Printf("loaded env file %s", path)
            }
            return
        }
    }
}

func newMuxer(cfg Config) *muxer {
    return &muxer{
        cfg:    cfg,
        active: make(map[string]*dashJob),
    }
}

func handleHealth(w http.ResponseWriter, r *http.Request) {
    w.WriteHeader(http.StatusOK)
    _, _ = w.Write([]byte("ok"))
}

func (m *muxer) handleMux(w http.ResponseWriter, r *http.Request) {
    reqID := atomic.AddUint64(&m.reqCounter, 1)
    logPrefix := fmt.Sprintf("req=%d", reqID)
    log.Printf("%s start method=%s remote=%s url=%s", logPrefix, r.Method, r.RemoteAddr, r.URL.String())
    defer log.Printf("%s done", logPrefix)

    if r.Method != http.MethodGet {
        http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
        return
    }

    m.maybeCleanup()

    q := r.URL.Query()
    urlParam := strings.TrimSpace(q.Get("url"))
    v := strings.TrimSpace(q.Get("v"))
    quality := strings.TrimSpace(q.Get("quality"))
    container := strings.ToLower(strings.TrimSpace(q.Get("container")))
    if container == "" {
        container = m.cfg.DefaultContainer
    }
    if container != "webm" && container != "mkv" {
        http.Error(w, "container must be webm or mkv", http.StatusBadRequest)
        return
    }

    sourceURL, err := m.buildSourceURL(urlParam, v)
    if err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    height := parseQuality(quality)
    is4k := height >= 2160
    log.Printf("%s source=%s height=%d is4k=%t container=%s", logPrefix, sourceURL, height, is4k, container)

    if is4k {
        w.Header().Set("X-Muxer-Cache", "bypass")
        log.Printf("%s dash disabled; using live mux is4k=%t ttl=%s", logPrefix, is4k, m.cfg.CacheTTL)
        m.streamLive(w, r, sourceURL, height, container, logPrefix)
        return
    }

    w.Header().Set("X-Muxer-Cache", "bypass")
    log.Printf("%s cache bypass is4k=%t ttl=%s", logPrefix, is4k, m.cfg.CacheTTL)
    m.streamLive(w, r, sourceURL, height, container, logPrefix)
}

func (m *muxer) buildSourceURL(urlParam, v string) (string, error) {
    if urlParam != "" {
        return urlParam, nil
    }
    if v == "" {
        return "", errors.New("missing url or v query parameter")
    }
    return m.cfg.SourceBase + v, nil
}

func (m *muxer) dashPaths(key string) (string, string, string) {
    dir := filepath.Join(m.cfg.CacheDir, key)
    manifestPath := filepath.Join(dir, "manifest.mpd")
    completePath := filepath.Join(dir, ".complete")
    return dir, manifestPath, completePath
}

func (m *muxer) isDashFresh(manifestPath, completePath string) bool {
    if m.cfg.CacheTTL <= 0 {
        return false
    }
    if _, err := os.Stat(manifestPath); err != nil {
        return false
    }
    info, err := os.Stat(completePath)
    if err != nil {
        return false
    }
    return time.Since(info.ModTime()) < m.cfg.CacheTTL
}

func (m *muxer) maybeCleanup() {
    if m.cfg.CacheTTL <= 0 {
        return
    }

    m.mu.Lock()
    if time.Since(m.lastCleanup) < 2*time.Minute {
        m.mu.Unlock()
        return
    }
    m.lastCleanup = time.Now()
    m.mu.Unlock()

    m.cleanupCache()
}

func (m *muxer) cleanupCache() {
    entries, err := os.ReadDir(m.cfg.CacheDir)
    if err != nil {
        log.Printf("cache cleanup read error: %v", err)
        return
    }

    activeKeys := map[string]struct{}{}
    m.mu.Lock()
    for key := range m.active {
        activeKeys[key] = struct{}{}
    }
    m.mu.Unlock()

    cutoff := time.Now().Add(-m.cfg.CacheTTL)
    for _, entry := range entries {
        name := entry.Name()
        fullPath := filepath.Join(m.cfg.CacheDir, name)
        if entry.IsDir() {
            if _, ok := activeKeys[name]; ok {
                continue
            }
            completePath := filepath.Join(fullPath, ".complete")
            if info, err := os.Stat(completePath); err == nil {
                if info.ModTime().Before(cutoff) {
                    _ = os.RemoveAll(fullPath)
                }
                continue
            }
            if info, err := entry.Info(); err == nil {
                if info.ModTime().Before(cutoff) {
                    _ = os.RemoveAll(fullPath)
                }
            }
            continue
        }
        info, err := entry.Info()
        if err != nil {
            continue
        }

        if strings.HasSuffix(name, ".complete") {
            if info.ModTime().Before(cutoff) {
                _ = os.Remove(fullPath)
                _ = os.Remove(strings.TrimSuffix(fullPath, ".complete"))
            }
            continue
        }

        if info.ModTime().Before(cutoff) {
            completePath := fullPath + ".complete"
            if _, err := os.Stat(completePath); err != nil {
                _ = os.Remove(fullPath)
            }
        }
    }
}

func (m *muxer) getOrStartDashJob(key, dir, manifestPath, completePath, sourceURL string, height int) (*dashJob, bool) {
    m.mu.Lock()
    if job, ok := m.active[key]; ok {
        m.mu.Unlock()
        return job, false
    }

    job := &dashJob{
        key:          key,
        dir:          dir,
        manifestPath: manifestPath,
        completePath: completePath,
        started:      time.Now(),
        done:         make(chan struct{}),
    }
    job.ctx, job.cancel = context.WithCancel(context.Background())
    m.active[key] = job
    m.mu.Unlock()

    go m.runDashJob(job, sourceURL, height)

    return job, true
}

func (m *muxer) runDashJob(job *dashJob, sourceURL string, height int) {
    start := time.Now()
    logPrefix := fmt.Sprintf("job=%s", shortKey(job.key))
    mode := "dash_webm_copy"
    if m.cfg.DashTranscode {
        mode = "dash_mp4_transcode"
    }
    log.Printf("%s start source=%s height=%d mode=%s", logPrefix, sourceURL, height, mode)
    defer func() {
        m.mu.Lock()
        delete(m.active, job.key)
        m.mu.Unlock()
        close(job.done)
    }()

    _ = os.RemoveAll(job.dir)
    if err := os.MkdirAll(job.dir, 0755); err != nil {
        job.err = err
        log.Printf("%s error: failed to create dash dir: %v", logPrefix, err)
        return
    }
    _ = os.Remove(job.completePath)

    ctx := job.ctx
    if ctx == nil {
        ctx = context.Background()
    }
    videoURL, audioURL, err := m.resolveStreams(ctx, sourceURL, height, logPrefix)
    if err != nil {
        job.err = err
        if errors.Is(err, context.Canceled) || ctx.Err() != nil {
            log.Printf("%s canceled before ffmpeg start", logPrefix)
            _ = os.RemoveAll(job.dir)
            return
        }
        log.Printf("%s error: %v", logPrefix, err)
        return
    }

    if err := runFfmpegToDash(ctx, m.cfg.FfmpegPath, videoURL, audioURL, job.manifestPath, m.cfg.DashSegmentDur, logPrefix, m.cfg.DashTranscode); err != nil {
        if errors.Is(err, context.Canceled) || ctx.Err() != nil {
            log.Printf("%s canceled during ffmpeg", logPrefix)
            _ = os.RemoveAll(job.dir)
            return
        }
        job.err = err
        log.Printf("%s error: %v", logPrefix, err)
        _ = os.RemoveAll(job.dir)
        return
    }

    if err := os.WriteFile(job.completePath, []byte("ok"), 0644); err != nil {
        job.err = err
        log.Printf("%s error: %v", logPrefix, err)
        return
    }

    log.Printf("%s complete duration=%s dir=%s", logPrefix, time.Since(start), job.dir)
}

func (m *muxer) resolveStreams(ctx context.Context, sourceURL string, height int, logPrefix string) (string, string, error) {
    format := buildFormat(height, m.cfg.MaxVideoTbrKbps, m.cfg.MaxVideoFps)
    args := []string{"-f", format, "-g", "--no-playlist", "--remote-components", "ejs:github"}
    if m.cfg.YtDlpJsRuntime != "" {
        args = append(args, "--js-runtimes", m.cfg.YtDlpJsRuntime)
    }
    args = append(args, sourceURL)

    cmd := exec.CommandContext(ctx, m.cfg.YtDlpPath, args...)
    log.Printf("%s yt-dlp cmd=%s", logPrefix, formatCommand(m.cfg.YtDlpPath, args))
    start := time.Now()
    stdoutPipe, err := cmd.StdoutPipe()
    if err != nil {
        return "", "", fmt.Errorf("yt-dlp stdout pipe error: %v", err)
    }
    stderrPipe, err := cmd.StderrPipe()
    if err != nil {
        return "", "", fmt.Errorf("yt-dlp stderr pipe error: %v", err)
    }

    if err := cmd.Start(); err != nil {
        return "", "", fmt.Errorf("yt-dlp start error: %v", err)
    }

    var stdoutBytes, stderrBytes []byte
    var stdoutErr, stderrErr error
    var wg sync.WaitGroup
    wg.Add(2)
    go func() {
        defer wg.Done()
        stdoutBytes, stdoutErr = io.ReadAll(stdoutPipe)
    }()
    go func() {
        defer wg.Done()
        stderrBytes, stderrErr = io.ReadAll(stderrPipe)
    }()
    wg.Wait()

    waitErr := cmd.Wait()
    duration := time.Since(start)

    if stdoutErr != nil {
        return "", "", fmt.Errorf("yt-dlp stdout read error: %v", stdoutErr)
    }
    if stderrErr != nil {
        return "", "", fmt.Errorf("yt-dlp stderr read error: %v", stderrErr)
    }

    stdoutText := strings.TrimSpace(string(stdoutBytes))
    stderrText := strings.TrimSpace(string(stderrBytes))

    if stderrText != "" {
        log.Printf("%s yt-dlp stderr duration=%s output=%s", logPrefix, duration, truncateLog(sanitizeLog(stderrText), 1200))
    }
    if stdoutText == "" {
        stdoutText = "<empty>"
    }
    log.Printf("%s yt-dlp stdout duration=%s output=%s", logPrefix, duration, truncateLog(sanitizeLog(stdoutText), 1200))

    if waitErr != nil {
        msg := stderrText
        if msg == "" {
            msg = waitErr.Error()
        }
        return "", "", fmt.Errorf("yt-dlp error: %s", msg)
    }

    urls := make([]string, 0, 2)
    scanner := bufio.NewScanner(bytes.NewReader(stdoutBytes))
    for scanner.Scan() {
        line := strings.TrimSpace(scanner.Text())
        if strings.HasPrefix(line, "http") {
            urls = append(urls, line)
        }
    }
    if err := scanner.Err(); err != nil {
        return "", "", fmt.Errorf("yt-dlp output error: %v", err)
    }

    if len(urls) < 2 {
        log.Printf("%s yt-dlp returned %d urls", logPrefix, len(urls))
        return "", "", fmt.Errorf("yt-dlp returned %d urls, expected video and audio", len(urls))
    }

    return urls[0], urls[1], nil
}

func buildFormat(height int, maxVideoTbrKbps int, maxVideoFps int) string {
    heightFilter := ""
    if height > 0 {
        heightFilter = fmt.Sprintf("[height<=%d]", height)
    }

    caps := ""
    if maxVideoTbrKbps > 0 {
        caps += fmt.Sprintf("[tbr<=%d]", maxVideoTbrKbps)
    }
    if maxVideoFps > 0 {
        caps += fmt.Sprintf("[fps<=%d]", maxVideoFps)
    }

    parts := []string{}
    if caps != "" {
        parts = append(parts, fmt.Sprintf("bestvideo%s[ext=webm][vcodec=vp9]%s+bestaudio[ext=webm]", heightFilter, caps))
    }
    parts = append(parts, fmt.Sprintf("bestvideo%s[ext=webm][vcodec=vp9]+bestaudio[ext=webm]", heightFilter))
    if caps != "" {
        parts = append(parts, fmt.Sprintf("bestvideo%s[ext=webm][vcodec*=vp9]%s+bestaudio[ext=webm]", heightFilter, caps))
    }
    parts = append(parts, fmt.Sprintf("bestvideo%s[ext=webm][vcodec*=vp9]+bestaudio[ext=webm]", heightFilter))

    return strings.Join(parts, "/")
}

func runFfmpegToDash(ctx context.Context, ffmpegPath, videoURL, audioURL, outputPath string, segmentDur time.Duration, logPrefix string, transcode bool) error {
    segSeconds := int(segmentDur.Seconds())
    if segSeconds <= 0 {
        segSeconds = 4
    }

    args := []string{
        "-hide_banner",
        "-loglevel", "warning",
        "-nostats",
        "-y",
        "-i", videoURL,
        "-i", audioURL,
        "-map", "0:v:0",
        "-map", "1:a:0",
    }

    dashSegmentType := "webm"
    initName := "init-stream$RepresentationID$.webm"
    mediaName := "chunk-stream$RepresentationID$-$Number%05d$.webm"

    if transcode {
        gop := segSeconds * 30
        if gop <= 0 {
            gop = 120
        }
        forceKey := fmt.Sprintf("expr:gte(t,n_forced*%d)", segSeconds)
        args = append(args,
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-profile:v", "high",
            "-level:v", "5.1",
            "-pix_fmt", "yuv420p",
            "-g", strconv.Itoa(gop),
            "-keyint_min", strconv.Itoa(gop),
            "-sc_threshold", "0",
            "-force_key_frames", forceKey,
            "-c:a", "aac",
            "-b:a", "192k",
            "-ac", "2",
        )
        dashSegmentType = "mp4"
        initName = "init-stream$RepresentationID$.mp4"
        mediaName = "chunk-stream$RepresentationID$-$Number%05d$.m4s"
    } else {
        args = append(args, "-c", "copy")
    }

    args = append(args,
        "-f", "dash",
        "-dash_segment_type", dashSegmentType,
        "-seg_duration", strconv.Itoa(segSeconds),
        "-use_template", "1",
        "-use_timeline", "1",
        "-streaming", "1",
        "-adaptation_sets", "id=0,streams=v id=1,streams=a",
        "-init_seg_name", initName,
        "-media_seg_name", mediaName,
        "-progress", "pipe:1",
        outputPath,
    )

    cmd := exec.CommandContext(ctx, ffmpegPath, args...)
    log.Printf("%s ffmpeg cmd=%s", logPrefix, formatCommand(ffmpegPath, args))
    start := time.Now()
    stdoutPipe, err := cmd.StdoutPipe()
    if err != nil {
        return fmt.Errorf("ffmpeg stdout pipe error: %v", err)
    }
    stderrPipe, err := cmd.StderrPipe()
    if err != nil {
        return fmt.Errorf("ffmpeg stderr pipe error: %v", err)
    }

    if err := cmd.Start(); err != nil {
        return fmt.Errorf("ffmpeg start error: %v", err)
    }

    var stderr bytes.Buffer
    const ffmpegStderrMax = 64 * 1024
    var wg sync.WaitGroup
    wg.Add(2)

    var lastProgress int64
    var progressSeen uint32
    atomic.StoreInt64(&lastProgress, start.UnixNano())

    progressStop := make(chan struct{})

    go func() {
        defer wg.Done()
        readFfmpegProgress(stdoutPipe, logPrefix, &lastProgress, &progressSeen)
    }()
    go func() {
        defer wg.Done()
        scanner := bufio.NewScanner(stderrPipe)
        for scanner.Scan() {
            line := scanner.Text()
            appendLimited(&stderr, line+"\n", ffmpegStderrMax)
            log.Printf("%s ffmpeg stderr: %s", logPrefix, truncateLog(sanitizeLog(line), 1200))
        }
        if err := scanner.Err(); err != nil {
            log.Printf("%s ffmpeg stderr read error: %v", logPrefix, err)
        }
    }()
    go func() {
        ticker := time.NewTicker(10 * time.Second)
        defer ticker.Stop()
        for {
            select {
            case <-progressStop:
                return
            case <-ticker.C:
                last := time.Unix(0, atomic.LoadInt64(&lastProgress))
                since := time.Since(last)
                if since >= 10*time.Second {
                    if atomic.LoadUint32(&progressSeen) == 0 {
                        log.Printf("%s ffmpeg progress waiting for first update elapsed=%s", logPrefix, time.Since(start))
                    } else {
                        log.Printf("%s ffmpeg progress stale last_update=%s", logPrefix, since)
                    }
                }
            }
        }
    }()

    waitErr := cmd.Wait()
    close(progressStop)
    wg.Wait()
    duration := time.Since(start)

    if waitErr != nil {
        msg := strings.TrimSpace(stderr.String())
        if msg == "" {
            msg = waitErr.Error()
        }
        log.Printf("%s ffmpeg error duration=%s output=%s", logPrefix, duration, truncateLog(sanitizeLog(msg), 1200))
        return fmt.Errorf("ffmpeg error: %s", msg)
    }

    if stderr.Len() > 0 {
        log.Printf("%s ffmpeg ok duration=%s output=%s", logPrefix, duration, truncateLog(sanitizeLog(stderr.String()), 1200))
    } else {
        log.Printf("%s ffmpeg ok duration=%s", logPrefix, duration)
    }

    return nil
}

func (m *muxer) streamLive(w http.ResponseWriter, r *http.Request, sourceURL string, height int, container string, logPrefix string) {
    ctx := r.Context()
    log.Printf("%s live stream start source=%s height=%d container=%s", logPrefix, sourceURL, height, container)
    videoURL, audioURL, err := m.resolveStreams(ctx, sourceURL, height, logPrefix)
    if err != nil {
        http.Error(w, err.Error(), http.StatusBadRequest)
        return
    }

    args := []string{
        "-hide_banner",
        "-loglevel", "error",
        "-i", videoURL,
        "-i", audioURL,
        "-map", "0:v:0",
        "-map", "1:a:0",
        "-c", "copy",
        "-f", ffmpegContainer(container),
        "pipe:1",
    }

    cmd := exec.CommandContext(ctx, m.cfg.FfmpegPath, args...)
    log.Printf("%s live ffmpeg cmd=%s", logPrefix, formatCommand(m.cfg.FfmpegPath, args))
    stdout, err := cmd.StdoutPipe()
    if err != nil {
        http.Error(w, "failed to start ffmpeg", http.StatusInternalServerError)
        return
    }
    var stderr bytes.Buffer
    cmd.Stderr = &stderr

    if err := cmd.Start(); err != nil {
        http.Error(w, "failed to start ffmpeg", http.StatusInternalServerError)
        return
    }

    w.Header().Set("Content-Type", contentType(container))
    w.WriteHeader(http.StatusOK)
    if flusher, ok := w.(http.Flusher); ok {
        flusher.Flush()
    }

    start := time.Now()
    _, copyErr := io.Copy(w, stdout)
    waitErr := cmd.Wait()
    duration := time.Since(start)

    if ctx.Err() == nil && copyErr != nil {
        log.Printf("%s live copy error: %v", logPrefix, copyErr)
    }
    if ctx.Err() == nil && waitErr != nil {
        log.Printf("%s live ffmpeg error: %v output=%s", logPrefix, waitErr, truncateLog(sanitizeLog(stderr.String()), 1200))
    } else if ctx.Err() == nil && stderr.Len() > 0 {
        log.Printf("%s live ffmpeg output: %s", logPrefix, truncateLog(sanitizeLog(stderr.String()), 1200))
    }
    log.Printf("%s live stream done duration=%s", logPrefix, duration)
}

func (m *muxer) waitForManifest(job *dashJob, timeout time.Duration, logPrefix string) error {
    deadline := time.Now().Add(timeout)
    lastStatusLog := time.Time{}

    for {
        ready, missing, size, readyErr := dashInitSegmentsStatus(job.manifestPath, job.dir)
        if readyErr != nil {
            return readyErr
        }
        if ready {
            return nil
        }

        if m.jobDone(job) {
            if job.err != nil {
                log.Printf("%s dash job error: %v", logPrefix, job.err)
                return job.err
            }
            if len(missing) > 0 {
                log.Printf("%s dash job completed without init segments missing=%s", logPrefix, formatMissing(missing, 6))
                return errors.New("dash job completed without init segments")
            }
            return errors.New("dash job completed without manifest init segments")
        }

        now := time.Now()
        if lastStatusLog.IsZero() || now.Sub(lastStatusLog) >= 5*time.Second {
            status := dashStatus(size, missing)
            log.Printf("%s waiting for dash manifest status=%s size=%d missing_init=%s elapsed=%s", logPrefix, status, size, formatMissing(missing, 6), time.Since(job.started))
            lastStatusLog = now
        }

        if time.Now().After(deadline) {
            status := dashStatus(size, missing)
            log.Printf("%s timeout waiting for dash manifest status=%s size=%d missing_init=%s elapsed=%s", logPrefix, status, size, formatMissing(missing, 6), time.Since(job.started))
            return errors.New("timed out waiting for dash init segments")
        }

        time.Sleep(200 * time.Millisecond)
    }
}

func (m *muxer) jobDone(job *dashJob) bool {
    select {
    case <-job.done:
        return true
    default:
        return false
    }
}

func (m *muxer) addDashWaiter(job *dashJob, logPrefix string) func() {
    atomic.AddInt32(&job.waiters, 1)
    return func() {
        remaining := atomic.AddInt32(&job.waiters, -1)
        if remaining <= 0 && !m.jobDone(job) && job.cancel != nil && atomic.LoadUint32(&job.served) == 0 {
            job.cancelOnce.Do(func() {
                log.Printf("%s canceling dash job key=%s no_waiters", logPrefix, shortKey(job.key))
                job.cancel()
            })
        }
    }
}

func (m *muxer) serveDashManifest(w http.ResponseWriter, r *http.Request, manifestPath, key, logPrefix string) {
    data, err := os.ReadFile(manifestPath)
    if err != nil {
        log.Printf("%s manifest read error: %v", logPrefix, err)
        http.Error(w, "failed to read manifest", http.StatusInternalServerError)
        return
    }

    manifest := string(data)
    baseURL := dashBaseURL(r, key)
    manifest = injectBaseURL(manifest, baseURL)

    w.Header().Set("Content-Type", "application/dash+xml")
    w.Header().Set("Cache-Control", "no-cache")
    w.WriteHeader(http.StatusOK)
    _, _ = w.Write([]byte(manifest))
}

func dashBaseURL(r *http.Request, key string) string {
    scheme := "http"
    if r.TLS != nil {
        scheme = "https"
    }
    return fmt.Sprintf("%s://%s/dash/%s/", scheme, r.Host, key)
}

func injectBaseURL(manifest, baseURL string) string {
    if strings.Contains(manifest, "<BaseURL>") {
        return manifest
    }
    idx := strings.Index(manifest, "<MPD")
    if idx == -1 {
        return manifest
    }
    end := strings.Index(manifest[idx:], ">")
    if end == -1 {
        return manifest
    }
    insertPos := idx + end + 1
    insert := "\n  <BaseURL>" + baseURL + "</BaseURL>"
    return manifest[:insertPos] + insert + manifest[insertPos:]
}

func dashInitSegmentsStatus(manifestPath, dir string) (bool, []string, int64, error) {
    info, err := os.Stat(manifestPath)
    if err != nil {
        if os.IsNotExist(err) {
            return false, nil, -1, nil
        }
        return false, nil, 0, err
    }

    size := info.Size()
    if size == 0 {
        return false, nil, size, nil
    }

    data, err := os.ReadFile(manifestPath)
    if err != nil {
        return false, nil, size, err
    }

    initNames := parseInitSegmentNames(string(data))
    if len(initNames) == 0 {
        ids := parseRepresentationIDs(string(data))
        for _, id := range ids {
            initNames = append(initNames, fmt.Sprintf("init-%s.webm", id))
        }
    }

    if len(initNames) == 0 {
        matches, _ := filepath.Glob(filepath.Join(dir, "init-*.webm"))
        for _, match := range matches {
            if info, err := os.Stat(match); err == nil && info.Size() > 0 {
                return true, nil, size, nil
            }
        }
        return false, nil, size, nil
    }

    missing := make([]string, 0, len(initNames))
    for _, name := range initNames {
        initPath := filepath.Join(dir, filepath.FromSlash(name))
        if info, err := os.Stat(initPath); err != nil {
            if os.IsNotExist(err) {
                missing = append(missing, name)
                continue
            }
            return false, nil, size, err
        } else if info.Size() == 0 {
            missing = append(missing, name)
        }
    }

    if len(missing) > 0 {
        return false, missing, size, nil
    }

    return true, nil, size, nil
}

func dashStatus(size int64, missing []string) string {
    if size < 0 {
        return "manifest_missing"
    }
    if size == 0 {
        return "manifest_empty"
    }
    if len(missing) > 0 {
        return "init_segments_missing"
    }
    return "manifest_waiting"
}

func parseRepresentationIDs(manifest string) []string {
    ids := []string{}
    seen := map[string]struct{}{}
    search := 0

    for {
        idx := strings.Index(manifest[search:], "<Representation")
        if idx == -1 {
            break
        }
        idx += search
        end := strings.Index(manifest[idx:], ">")
        if end == -1 {
            break
        }
        tag := manifest[idx : idx+end]
        id := extractAttr(tag, "id")
        if id != "" {
            if _, ok := seen[id]; !ok {
                seen[id] = struct{}{}
                ids = append(ids, id)
            }
        }
        search = idx + end + 1
    }

    return ids
}

func parseInitSegmentNames(manifest string) []string {
    names := []string{}
    seen := map[string]struct{}{}
    search := 0

    for {
        idx := strings.Index(manifest[search:], "<Initialization")
        if idx == -1 {
            break
        }
        idx += search
        end := strings.Index(manifest[idx:], ">")
        if end == -1 {
            break
        }
        tag := manifest[idx : idx+end]
        name := extractAttr(tag, "sourceURL")
        if name != "" {
            if _, ok := seen[name]; !ok {
                seen[name] = struct{}{}
                names = append(names, name)
            }
        }
        search = idx + end + 1
    }

    if len(names) > 0 {
        return names
    }

    search = 0
    for {
        idx := strings.Index(manifest[search:], "<SegmentTemplate")
        if idx == -1 {
            break
        }
        idx += search
        end := strings.Index(manifest[idx:], ">")
        if end == -1 {
            break
        }
        tag := manifest[idx : idx+end]
        init := extractAttr(tag, "initialization")
        if init != "" {
            if strings.Contains(init, "$Bandwidth$") {
                search = idx + end + 1
                continue
            }
            if strings.Contains(init, "$RepresentationID$") {
                ids := parseRepresentationIDs(manifest)
                for _, id := range ids {
                    name := strings.ReplaceAll(init, "$RepresentationID$", id)
                    if _, ok := seen[name]; !ok {
                        seen[name] = struct{}{}
                        names = append(names, name)
                    }
                }
            } else if _, ok := seen[init]; !ok {
                seen[init] = struct{}{}
                names = append(names, init)
            }
        }
        search = idx + end + 1
    }

    return names
}

func extractAttr(tag, key string) string {
    token := key + "="
    idx := strings.Index(tag, token)
    if idx == -1 {
        return ""
    }
    idx += len(token)
    if idx >= len(tag) {
        return ""
    }
    quote := tag[idx]
    if quote != '"' && quote != '\'' {
        return ""
    }
    idx++
    end := strings.IndexByte(tag[idx:], quote)
    if end == -1 {
        return ""
    }
    return tag[idx : idx+end]
}

func contentType(container string) string {
    switch container {
    case "mkv":
        return "video/x-matroska"
    case "webm":
        return "video/webm"
    default:
        return "application/octet-stream"
    }
}

func ffmpegContainer(container string) string {
    switch container {
    case "mkv":
        return "matroska"
    case "webm":
        return "webm"
    default:
        return "matroska"
    }
}

func parseQuality(q string) int {
    if q == "" {
        return 0
    }

    s := strings.ToLower(strings.TrimSpace(q))
    if s == "4k" {
        return 2160
    }

    if strings.Contains(s, "x") {
        parts := strings.Split(s, "x")
        if len(parts) == 2 {
            if h, err := strconv.Atoi(parts[1]); err == nil {
                return h
            }
        }
    }

    s = strings.TrimSuffix(s, "p")
    if n, err := strconv.Atoi(s); err == nil {
        return n
    }

    return 0
}

func cacheKey(sourceURL string, height int, container string) string {
    data := fmt.Sprintf("%s|%d|%s", sourceURL, height, container)
    sum := sha256.Sum256([]byte(data))
    return hex.EncodeToString(sum[:])
}

func shortKey(key string) string {
    if len(key) <= 8 {
        return key
    }
    return key[:8]
}

func formatCommand(path string, args []string) string {
    quoted := make([]string, 0, len(args)+1)
    quoted = append(quoted, strconv.Quote(path))
    for _, arg := range args {
        quoted = append(quoted, strconv.Quote(arg))
    }
    return strings.Join(quoted, " ")
}

func sanitizeLog(value string) string {
    value = strings.ReplaceAll(value, "\r\n", "\n")
    value = strings.ReplaceAll(value, "\n", "\\n")
    value = strings.ReplaceAll(value, "\r", "\\r")
    return value
}

func formatMissing(ids []string, max int) string {
    if len(ids) == 0 {
        return "-"
    }
    if max <= 0 || len(ids) <= max {
        return strings.Join(ids, ",")
    }
    return strings.Join(ids[:max], ",") + fmt.Sprintf(",+%d", len(ids)-max)
}

func truncateLog(value string, max int) string {
    if len(value) <= max {
        return value
    }
    return value[:max] + "...(truncated)"
}

func appendLimited(buf *bytes.Buffer, value string, max int) {
    if max <= 0 || value == "" {
        return
    }
    if len(value) > max {
        value = value[len(value)-max:]
    }
    if buf.Len()+len(value) > max {
        excess := buf.Len() + len(value) - max
        existing := buf.Bytes()
        if excess < len(existing) {
            buf.Reset()
            buf.Write(existing[excess:])
        } else {
            buf.Reset()
        }
    }
    _, _ = buf.WriteString(value)
}

func readFfmpegProgress(r io.Reader, logPrefix string, lastProgress *int64, progressSeen *uint32) {
    scanner := bufio.NewScanner(r)
    values := map[string]string{}
    var lastLog time.Time

    for scanner.Scan() {
        line := strings.TrimSpace(scanner.Text())
        if line == "" {
            continue
        }
        parts := strings.SplitN(line, "=", 2)
        if len(parts) != 2 {
            continue
        }
        key := strings.TrimSpace(parts[0])
        val := strings.TrimSpace(parts[1])
        if key == "" {
            continue
        }
        values[key] = val

        if key == "progress" {
            now := time.Now()
            atomic.StoreInt64(lastProgress, now.UnixNano())
            atomic.StoreUint32(progressSeen, 1)
            if lastLog.IsZero() || now.Sub(lastLog) >= 2*time.Second || val == "end" {
                log.Printf("%s ffmpeg progress state=%s time=%s ms=%s fps=%s bitrate=%s speed=%s size=%s", logPrefix, val, progressValue(values, "out_time"), progressValue(values, "out_time_ms"), progressValue(values, "fps"), progressValue(values, "bitrate"), progressValue(values, "speed"), progressValue(values, "total_size"))
                lastLog = now
            }
            values = map[string]string{}
        }
    }

    if err := scanner.Err(); err != nil {
        log.Printf("%s ffmpeg progress read error: %v", logPrefix, err)
    }
}

func progressValue(values map[string]string, key string) string {
    if val, ok := values[key]; ok && val != "" {
        return val
    }
    return "-"
}

func ensureExecutable(name string) (string, error) {
    return exec.LookPath(name)
}

func getEnv(key, fallback string) string {
    value := strings.TrimSpace(os.Getenv(key))
    if value == "" {
        return fallback
    }
    return value
}

func getEnvInt(key string, fallback int) int {
    value := strings.TrimSpace(os.Getenv(key))
    if value == "" {
        return fallback
    }
    if n, err := strconv.Atoi(value); err == nil {
        return n
    }
    return fallback
}

func getEnvBool(key string, fallback bool) bool {
    value := strings.TrimSpace(os.Getenv(key))
    if value == "" {
        return fallback
    }
    switch strings.ToLower(value) {
    case "1", "true", "yes", "y", "on":
        return true
    case "0", "false", "no", "n", "off":
        return false
    default:
        return fallback
    }
}
