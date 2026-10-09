// The oracle deliberately uses media progress, never the requested playbackSpeed field.
export type RateSample = { wallSeconds: number; mediaSeconds: number };

export function measurePlaybackRate(samples: RateSample[]) {
    if (samples.length < 20) throw new Error('Too few playback samples');
    const elapsed = samples.at(-1)!.wallSeconds - samples[0].wallSeconds;
    if (elapsed < 20) throw new Error('Playback measurement must span at least 20 seconds');
    for (let i = 0; i < samples.length; i++) {
        const sample = samples[i];
        if (!Number.isFinite(sample.wallSeconds) || !Number.isFinite(sample.mediaSeconds)) {
            throw new Error('Non-finite playback sample');
        }
        if (i > 0 && (sample.wallSeconds <= samples[i - 1].wallSeconds
            || sample.wallSeconds - samples[i - 1].wallSeconds > 2
            || sample.mediaSeconds < samples[i - 1].mediaSeconds)) {
            throw new Error('Discontinuous playback measurement (seek or sampling gap)');
        }
    }
    const meanWall = samples.reduce((sum, s) => sum + s.wallSeconds, 0) / samples.length;
    const meanMedia = samples.reduce((sum, s) => sum + s.mediaSeconds, 0) / samples.length;
    const variance = samples.reduce((sum, s) => sum + (s.wallSeconds - meanWall) ** 2, 0);
    const rate = samples.reduce((sum, s) => sum + (s.wallSeconds - meanWall) * (s.mediaSeconds - meanMedia), 0) / variance;
    const residual = Math.max(...samples.map(s => Math.abs(s.mediaSeconds - meanMedia - rate * (s.wallSeconds - meanWall))));
    // Position updates may be quantized to a second. Larger jumps/stalls invalidate the window.
    if (residual > 1.5) throw new Error(`Unstable playback window (rate ${rate.toFixed(3)}x, maximum residual ${residual.toFixed(3)}s)`);
    return { rate, elapsed, residual };
}

// Less than half the 0.25x step: neighboring menu settings cannot pass as one another.
export const RATE_TOLERANCE = 0.06;
