import assert from 'node:assert/strict';
import { test } from 'node:test';
import { measurePlaybackRate, RATE_TOLERANCE } from './playback-rate';

const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const samples = (speed: number) => Array.from({ length: 49 }, (_, i) => ({
    wallSeconds: i * 0.5,
    mediaSeconds: 100 + Math.floor(i * 0.5 * speed),
}));

for (const speed of speeds) {
    test(`measures ${speed}x despite one-second position quantization`, () => {
        const result = measurePlaybackRate(samples(speed));
        assert.ok(Math.abs(result.rate - speed) <= RATE_TOLERANCE);
        for (const other of speeds.filter(value => value !== speed)) {
            assert.ok(Math.abs(result.rate - other) > RATE_TOLERANCE, `${speed}x must not pass as ${other}x`);
        }
    });
}
test('rejects the reported 2x playback when 1.25x was selected', () => {
    assert.ok(Math.abs(measurePlaybackRate(samples(2)).rate - 1.25) > RATE_TOLERANCE);
});
test('rejects short windows, seek jumps, stalls, and invalid samples', () => {
    assert.throws(() => measurePlaybackRate(samples(1).slice(0, 10)));
    const seek = samples(1).map((s, i) => ({ ...s, mediaSeconds: s.mediaSeconds + (i > 24 ? 20 : 0) }));
    assert.throws(() => measurePlaybackRate(seek), /Unstable/);
    const stall = samples(1).map((s, i) => ({ ...s, mediaSeconds: i > 24 ? 112 : s.mediaSeconds }));
    assert.throws(() => measurePlaybackRate(stall), /Unstable/);
    const invalid = samples(1);
    invalid[10].mediaSeconds = NaN;
    assert.throws(() => measurePlaybackRate(invalid), /Non-finite/);
});

test('rejects a stale 2x decoder after selecting 1.25x, even if it eventually settles', () => {
    const stale = samples(1.25).map(s => ({ ...s,
        mediaSeconds: 100 + Math.min(s.wallSeconds, 8) * 2 + Math.max(s.wallSeconds - 8, 0) * 1.25,
    }));
    assert.throws(() => measurePlaybackRate(stale), /Unstable/);
});

test('rejects missing time, nonmonotonic clocks and backward seeks', () => {
    const gap = samples(1).filter(s => s.wallSeconds < 10 || s.wallSeconds > 13);
    assert.throws(() => measurePlaybackRate(gap), /Discontinuous/);
    const clock = samples(1);
    clock[20].wallSeconds = clock[19].wallSeconds;
    assert.throws(() => measurePlaybackRate(clock), /Discontinuous/);
    const backward = samples(1);
    backward[20].mediaSeconds = 100;
    assert.throws(() => measurePlaybackRate(backward), /Discontinuous/);
});
