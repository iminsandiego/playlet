// Uses the real remote/menu path and measures media seconds per monotonic wall-clock second.
// Runs against an already installed full dev app; never deploys or clears the login/registry.
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { Button, Key, check, ecp, expectField, expectPred, field, finish, group, launchVod, odc, press, revealChrome } from './vpd-player-harness';
import { measurePlaybackRate, RATE_TOLERANCE, RateSample } from './playback-rate';

const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const timingEvidence: Array<{ requestedSpeed: number; phase: string; ecp: RateSample[]; native: RateSample[]; videoFormats: string[]; audioFormats: string[] }> = [];
let decoderEvidence: unknown;
let audioEvidence: unknown;
// Cover every option, the reported 1.25x choice first, and decreasing transitions after 2x.
const SEQUENCE = process.env.PLAYLET_SPEED_SEQUENCE
    ? process.env.PLAYLET_SPEED_SEQUENCE.split(',').map(Number)
    : [1, 1.25, 1.5, 1.75, 2, 1.25, 0.75, 0.5, 0.25, 1];
if (!SEQUENCE.length || SEQUENCE.some(speed => !SPEEDS.includes(speed))) {
    throw new Error('PLAYLET_SPEED_SEQUENCE must contain supported comma-separated speeds');
}

async function selectSpeed(speed: number, state = 'playing', onSelect?: () => void) {
    await revealChrome();
    if (await field('#buttonRow.rowFocused') !== true) await press(Key.Up);
    for (let i = 0; i < 10 && await field('#buttonRow.focusedIndex') !== Button.speed; i++) {
        const index = await field<number>('#buttonRow.focusedIndex');
        if (typeof index !== 'number') throw new Error('Player button focus is unavailable');
        await press(index < Button.speed ? Key.Right : Key.Left);
        // ECP acknowledges receipt before SceneGraph handles the key. Wait before deciding the next key.
        await ecp.sleep(250);
    }
    await expectField('#buttonRow.focusedIndex', Button.speed);
    await press(Key.Ok);
    const options = await field<Array<{ value: string }>>('#playerSpeedSelector.options');
    if (JSON.stringify(options?.map(o => Number(o.value))) !== JSON.stringify(SPEEDS)) {
        throw new Error(`Unexpected speed menu: ${JSON.stringify(options)}`);
    }
    const target = SPEEDS.indexOf(speed);
    for (let i = 0; i < 8 && await field('#speedList.itemFocused') !== target; i++) {
        const focused = await field<number>('#speedList.itemFocused');
        if (typeof focused !== 'number') throw new Error('Speed menu did not open');
        const next = focused + (focused < target ? 1 : -1);
        await press(focused < target ? Key.Down : Key.Up);
        await expectField('#speedList.itemFocused', next);
        if (await field('#speedList.itemFocused') !== next) throw new Error('Speed focus did not acknowledge the key');
    }
    await expectField('#speedList.itemFocused', target);
    onSelect?.(); // start timing before OK, not after the menu/decoder has had time to settle
    await press(Key.Ok);
    await expectField('#VideoPlayer.playbackSpeed', speed);
    if (await field('#VideoPlayer.playbackSpeed') !== speed) throw new Error(`Selected ${speed}x did not reach the Video node`);
    await expectField('#buttonRow.speedLabel', `${speed}x`);
    await expectField('#VideoPlayer.state', state);
    // RadioButtonList may not emit checkedItem when OK reselects the current speed. Dismiss that menu.
    await ecp.sleep(250);
    if (await field('#Chrome.opacity') === 0) {
        try {
            if (await odc.hasFocus({ base: 'scene', keyPath: '#speedList' })) await press(Key.Back);
        } catch { /* selector already removed */ }
    }
    if ((await field<number>('#Chrome.opacity') ?? 0) > 0) await press(Key.Back);
}

async function measure(speed: number, phase = 'transition') {
    // Include the transition: a stale 2x rate or a freeze immediately after choosing 1.25x must not be hidden.
    const samples: RateSample[] = [];
    const evidence = { requestedSpeed: speed, phase, ecp: samples, native: [] as RateSample[], videoFormats: [] as string[], audioFormats: [] as string[] };
    timingEvidence.push(evidence);
    let delayedResponses = 0;
    const start = performance.now();
    do {
        const before = performance.now();
        const media = await ecp.getMediaPlayer();
        const after = performance.now();
        if (media.format?.audio && !evidence.audioFormats.includes(media.format.audio)) evidence.audioFormats.push(media.format.audio);
        const segment = media.stream_segment;
        if (process.env.PLAYLET_SPEED_AUDIO_BITRATE && segment?.segment_type === 'audio'
            && Number(segment.bitrate) !== Number(process.env.PLAYLET_SPEED_AUDIO_BITRATE)) {
            throw new Error(`Audio representation changed: bitrate=${segment.bitrate}`);
        }
        if (segment?.segment_type === 'video') {
            const dimensions = `${segment.width}x${segment.height}`;
            if (!evidence.videoFormats.includes(dimensions)) evidence.videoFormats.push(dimensions);
        }
        if (media.error || media.state !== 'play' || media.plugin?.id !== 'dev') {
            throw new Error(`Invalid ${speed}x measurement: state=${media.state}, error=${media.error}, app=${media.plugin?.id}`);
        }
        if (after - before > 250) {
            // A Wi-Fi latency spike has an uncertain sampling instant. Discard that sample, not a playback
            // failure. The oracle still requires >=20s of data with no gap above 2s, so outages cannot pass.
            delayedResponses++;
            if (after - before > 2000) throw new Error('ECP unavailable for over 2s; rate measurement is inconclusive');
            continue;
        }
        const position = media.position?.number;
        if (typeof position !== 'number') throw new Error('No numeric ECP media position');
        samples.push({ wallSeconds: ((before + after) / 2 - start) / 1000, mediaSeconds: position / 1000 });
        if (process.env.PLAYLET_SPEED_COMPARE_NATIVE === '1') {
            const nativePosition = await field<number>('#VideoPlayer.position');
            if (typeof nativePosition !== 'number') throw new Error('No numeric SceneGraph position');
            evidence.native.push({ wallSeconds: (performance.now() - start) / 1000, mediaSeconds: nativePosition });
        }
        await ecp.sleep(500);
    } while (performance.now() - start < 24_500);
    if (delayedResponses) console.log(`Excluded ${delayedResponses} delayed ECP response(s) from timing`);
    let result: ReturnType<typeof measurePlaybackRate>;
    try {
        result = measurePlaybackRate(samples);
    } catch (error) {
        console.log('Playback samples (wall seconds, media seconds):', JSON.stringify(samples));
        throw error;
    }
    check(`${speed}x advances at the selected rate`, Math.abs(result.rate - speed) <= RATE_TOLERANCE,
        `measured=${result.rate.toFixed(3)}x, window=${result.elapsed.toFixed(1)}s, tolerance=±${RATE_TOLERANCE}x`);
}

(async () => {
    let initialSpeed: number | undefined;
    let prefs: string | undefined;
    let snapshotTaken = false;
    try {
        await launchVod(process.env.PLAYLET_SPEED_VIDEO_ID ?? 'aqz-KE-bpKQ');
        console.log('Video under test:', await field('#VideoPlayer.content.title'));
        if (process.env.PLAYLET_SPEED_AUDIO_CODEC) {
            const codec = process.env.PLAYLET_SPEED_AUDIO_CODEC;
            if (!['aac', 'ac3', 'eac3'].includes(codec)) throw new Error('Unsupported diagnostic audio codec');
            // Diagnostic control only: restart this content with a codec constraint, never a saved preference.
            await odc.setValue({ base: 'scene', keyPath: '#VideoPlayer.control', value: 'stop' });
            await expectField('#VideoPlayer.state', 'stopped', 15000);
            await odc.setValue({ base: 'scene', keyPath: '#VideoPlayer.content.preferredAudioCodec', value: codec });
            await odc.setValue({ base: 'scene', keyPath: '#VideoPlayer.control', value: 'play' });
            await expectField('#VideoPlayer.state', 'playing', 30000);
            const selected = (await ecp.getMediaPlayer()).format?.audio;
            if (selected !== codec) throw new Error(`Requested codec ${codec}, decoder selected ${selected}`);
        }
        if (process.env.PLAYLET_SPEED_AUDIO_TRACK) {
            const track = process.env.PLAYLET_SPEED_AUDIO_TRACK;
            const tracks = await field<Array<{ Track: string }>>('#VideoPlayer.availableAudioTracks');
            if (!tracks?.some(t => t.Track === track)) throw new Error('Requested diagnostic audio track is unavailable');
            await odc.setValue({ base: 'scene', keyPath: '#VideoPlayer.audioTrack', value: track });
            await expectField('#VideoPlayer.currentAudioTrack', track, 15000);
            if (await field('#VideoPlayer.currentAudioTrack') !== track) throw new Error('Diagnostic track selection was not acknowledged');
            await expectField('#VideoPlayer.state', 'playing', 15000);
        }
        if (process.env.PLAYLET_SPEED_AUDIO_BITRATE) {
            const bitrate = Number(process.env.PLAYLET_SPEED_AUDIO_BITRATE);
            const metadata = await field<{ adaptiveFormats: Array<{ itag: string; type: string; bitrate: string; audioChannels: string; isDrc?: boolean; isVoiceBoost?: boolean }> }>('#VideoPlayer.content.metadata');
            const formats = metadata?.adaptiveFormats.filter(f => Number(f.bitrate) === bitrate);
            if (!formats?.length || formats.some(f => f.audioChannels !== '2')) throw new Error('Expected bitrate does not uniquely establish stereo audio');
            audioEvidence = formats.map(({ itag, type, bitrate, audioChannels, isDrc, isVoiceBoost }) => ({ itag, type, bitrate, audioChannels, isDrc, isVoiceBoost }));
            let observed = false;
            for (let i = 0; i < 40; i++) {
                const segment = (await ecp.getMediaPlayer()).stream_segment;
                if (segment?.segment_type === 'audio' && Number(segment.bitrate) === bitrate) { observed = true; break; }
                await ecp.sleep(250);
            }
            if (!observed) throw new Error('Expected stereo representation not observed in decoder segments');
            console.log('Verified stereo audio:', audioEvidence);
        }
        if (process.env.PLAYLET_SPEED_START_SECONDS) {
            const position = Number(process.env.PLAYLET_SPEED_START_SECONDS);
            if (!Number.isFinite(position) || position < 0) throw new Error('Invalid start position');
            await odc.setValue({ base: 'scene', keyPath: '#VideoPlayer.seek', value: position });
            await expectPred('#VideoPlayer.position', p => p >= position && p < position + 10, 'reaches the sponsor-free test window', 15000);
            await expectField('#VideoPlayer.state', 'playing', 15000);
        }
        const mediaInfo = await ecp.getMediaPlayer();
        decoderEvidence = { format: mediaInfo.format, stream: mediaInfo.stream_segment };
        console.log('Decoder format:', mediaInfo.format, 'Stream:', mediaInfo.stream_segment);
        initialSpeed = await field<number>('#VideoPlayer.playbackSpeed');
        if (typeof initialSpeed !== 'number') throw new Error('Initial speed is unavailable');
        prefs = (await odc.readRegistry({ values: { Playlet: ['user_prefs'] } })).values?.Playlet?.user_prefs;
        snapshotTaken = true;
        for (const speed of SEQUENCE) {
            group(`actual playback at ${speed}x`);
            let observation: Promise<unknown> | undefined;
            await selectSpeed(speed, 'playing', () => {
                observation = measure(speed).catch(error => error);
            });
            // A bad rate must fail the suite without preventing coverage of the remaining menu choices.
            try {
                const error = await observation;
                if (error) throw error;
            }
            catch (error) {
                check(`${speed}x measurement is stable after selection`, false, String(error));
                // Keep the transition failure, but independently check the sustained rate once the stall ends.
                // A successful second window never erases the original failure or turns this suite green.
                if (process.env.PLAYLET_SPEED_RETRY !== '0') {
                    try { await measure(speed, 'sustained-retry'); }
                    catch (retryError) { check(`${speed}x sustained measurement is stable`, false, String(retryError)); }
                }
            }
        }
        // Compare acknowledged pause -> select -> resume with a selection made during active playback.
        for (const speed of process.env.PLAYLET_SPEED_PAUSED === '0' ? [] : [1.25, 2]) {
            group(`${speed}x selected while paused`);
            if (await field('#VideoPlayer.playbackSpeed') !== 1) await selectSpeed(1);
            await press(Key.Play);
            await expectField('#VideoPlayer.state', 'paused');
            await selectSpeed(speed, 'paused');
            await press(Key.Play);
            await expectField('#VideoPlayer.state', 'playing');
            try { await measure(speed); }
            catch (error) { check(`${speed}x resumes at a stable rate after paused selection`, false, String(error)); }
        }
    } catch (error) {
        check('speed measurement completed', false, String(error));
    } finally {
        if (snapshotTaken) {
            try {
                // The test never writes saved preferences. Restore only the transient speed on this video.
                await odc.setValue({ base: 'scene', keyPath: '#VideoPlayer.control', value: 'pause' });
                await odc.setValue({ base: 'scene', keyPath: '#VideoPlayer.playbackSpeed', value: initialSpeed });
                const finalPrefs = (await odc.readRegistry({ values: { Playlet: ['user_prefs'] } })).values?.Playlet?.user_prefs;
                check('saved preferences remain byte-for-byte unchanged', prefs === finalPrefs);
            } catch (error) { check('speed cleanup completed', false, String(error)); }
        }
        if (process.env.PLAYLET_SPEED_REPORT) {
            writeFileSync(process.env.PLAYLET_SPEED_REPORT, JSON.stringify({
                recordedAt: new Date().toISOString(),
                videoId: process.env.PLAYLET_SPEED_VIDEO_ID ?? 'aqz-KE-bpKQ',
                requestedCodec: process.env.PLAYLET_SPEED_AUDIO_CODEC ?? 'default',
                requestedAudioTrack: process.env.PLAYLET_SPEED_AUDIO_TRACK,
                audioEvidence,
                startSeconds: Number(process.env.PLAYLET_SPEED_START_SECONDS ?? 0),
                sequence: SEQUENCE,
                decoder: decoderEvidence,
                measurements: timingEvidence,
            }, null, 2));
        }
    }
    await finish();
})();
