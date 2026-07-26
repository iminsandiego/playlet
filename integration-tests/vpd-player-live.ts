// VideoPlayerDev live e2e: on the trackbar, OK toggles the HUD without pausing (stock live faithfulness);
// Rewind enters the live-DVR ladder and a committed rewind exposes the contextual Go Live action. Live
// streams are unstable, so this skips cleanly when none is available; DVR assertions are hard whenever the
// selected manifest advertises a rewindable window.
//
//   cd references/playlet-legacy && npx tsx ./integration-tests/vpd-player-live.ts
//   PLAYER_LIVE_ID=<id> npx tsx ./integration-tests/vpd-player-live.ts   # override the stream

import { Key, Mode, Glyph, press, launch, finish, group, field, check, expectField, expectPred, expectSoft, waitFor, frames } from './vpd-player-harness';
import { getLiveVideoId, rejectLiveVideoId } from './live-id';

(async () => {
    // freshly-found live id (search, cached per session), then env override, then a hardcoded fallback.
    const explicitLiveId = process.env.PLAYER_LIVE_ID;
    const LIVE_ID = explicitLiveId || (await getLiveVideoId()) || 'jfKfPfyJRdk';
    console.log(`live id: ${LIVE_ID}`);

    const playing = await launch(LIVE_ID, 45_000);
    if (!playing) {
        if (!explicitLiveId) rejectLiveVideoId(LIVE_ID);
        console.log(`live stream ${LIVE_ID} did not start — skipping`);
        await finish(true);
    }

    const isLive = await field<boolean>('#trickPlayBar.isLive');
    if (isLive !== true) {
        console.log(`stream ${LIVE_ID} is not live (isLive=${isLive}) — skipping`);
        await finish(true);
    }

    group('live resting');
    await expectField('#trickPlayBar.isLive', true);
    await expectField('#VideoPlayer.state', 'playing');

    group('OK reveals the chrome -> trackbar focused by default');
    await press(Key.Ok);
    await expectField('#Chrome.opacity', 1);
    await expectField('#VideoPlayer.state', 'playing'); // reveal doesn't pause
    await expectField('#trickPlayBar.focused', true);

    group('on the bar, OK toggles the HUD without pausing (live faithful)');
    await press(Key.Ok);
    await expectField('#Chrome.opacity', 0);
    await expectField('#VideoPlayer.state', 'playing');

    const canRewind = await field<boolean>('#trickPlayBar.canRewind');
    if (canRewind === true) {
        group('Left/Right use the same fixed ten-second live step as VOD');
        await press(Key.Left);
        await expectField('#trickPlayBar.transportMode', Mode.liveDvr);
        const rewoundCursorMs = (await field<number>('#trickPlayBar.cursorMs')) ?? 0;
        const frozenPositionMs = (await field<number>('#trickPlayBar.positionMs')) ?? 0;
        const rewindDeltaMs = frozenPositionMs - rewoundCursorMs;
        // A position notification can race the ECP key by one device tick; the controller unit spec proves the
        // exact 10,000ms arithmetic, while this device seam allows that reporting skew.
        check('Left moves about ten seconds behind the frozen position', rewindDeltaMs >= 9_000 && rewindDeltaMs <= 12_000, `${rewindDeltaMs}ms`);
        await press(Key.Right);
        await expectField('#trickPlayBar.cursorMs', rewoundCursorMs + 10_000);
        // The live edge advances while transport is frozen, so the symmetric +10s can still leave us roughly
        // one position-notification behind. One more forward step then crosses the moving edge and auto-resumes.
        if ((await field<number>('#trickPlayBar.transportMode')) === Mode.liveDvr) {
            await press(Key.Right);
        }
        await expectField('#trickPlayBar.transportMode', Mode.idle, 8000);
        await expectField('#trickPlayBar.atLiveEdge', true);

        group('physical Rewind uses the ten-second L1 base and moves behind the edge');
        await press(Key.Rewind);
        await expectField('#trickPlayBar.transportMode', Mode.liveDvr);
        await expectPred('#trickPlayBar.glyph', (v) => v !== Glyph.none, 'shows a rewind glyph');
        await expectField('#bifDisplay.visible', true);
        await expectPred('#trickPlayBar.liveOffsetMs', (v) => typeof v === 'number' && v >= 10_000, 'moves at least ten seconds behind live', 4000);

        group('committing the rewind keeps the player behind and exposes Go Live');
        await press(Key.Ok);
        await expectField('#trickPlayBar.transportMode', Mode.idle);
        await waitFor('#VideoPlayer.state', (v) => v === 'playing', 'committed rewind resumes playback', 8000);
        // Two post-seek position notifications are enough to reproduce the startup-calibration regression:
        // without the transport-boundary baseline they absorb the rewind and incorrectly restore LIVE.
        await frames(3500);
        await expectField('#trickPlayBar.atLiveEdge', false);
        await expectPred('#trickPlayBar.liveOffsetMs', (v) => typeof v === 'number' && v >= 4000, 'retains a real time-behind offset');
        await press(Key.Up);
        await expectField('#trickPlayBar.focused', true);
        await expectField('#goLiveAction.visible', true);
        await expectField('#goLiveKeyLabel.text', 'OK');
        await expectPred('#goLiveLabel.text', (v) => typeof v === 'string' && v.length > 0, 'shows the localized Go Live action');
        await expectPred('#goLiveKeyBackground.uri', (v) => typeof v === 'string' && v.includes('white-border'), 'uses only the compact outlined key capsule');

        group('Go Live returns the committed rewind to the edge');
        await press(Key.Ok);
        await expectField('#trickPlayBar.atLiveEdge', true, 8000);
        await expectField('#VideoPlayer.state', 'playing');
        await expectField('#goLiveAction.visible', false);
    } else {
        console.log('  stream manifest has no rewindable DVR window — skipping DVR-only assertions');
    }

    // Pause a live stream, let the edge run on, resume -> you're behind the edge, so the badge swaps "● LIVE" for
    // the time-behind offset. The brain drops off the edge the moment the device reports the user pause
    // (pausing live IS falling behind); the offset reads out once the post-resume duration catch-up lands.
    // Soft: needs a real DVR/pause window and a few seconds of wall clock.
    group('pause -> resume drops off the live edge and shows the offset (soft — needs DVR window)');
    await waitFor('#VideoPlayer.state', (v) => v === 'playing', 'settle the commit-to-live seek before pausing');
    const durBefore = Number(await field('#VideoPlayer.duration'));
    // verified toggle: a single ECP Play can land out of phase (eaten/raced), inverting every check after it.
    const waitState = async (want: string, ms: number) => {
        const t0 = Date.now();
        while (Date.now() - t0 < ms) {
            if ((await field('#VideoPlayer.state')) === want) return true;
            await frames(250);
        }
        return false;
    };
    let paused = false;
    for (let i = 0; i < 2 && !paused; i++) {
        await press(Key.Play); // the play/pause key (on the bar, OK only toggles chrome)
        paused = await waitState('paused', 4000);
    }
    if (!paused) {
        console.log('  ⚠ soft: the live pause never landed (stream/keypress) — skipping the fall-behind checks');
    } else {
        await frames(10000); // let the live edge advance well past the frozen position
        let playing = false;
        for (let i = 0; i < 2 && !playing; i++) {
            await press(Key.Play);
            playing = await waitState('playing', 5000);
        }
        // duration FREEZES while paused and catches up a few seconds AFTER resume; the bar only receives the
        // projection on reveal — so wait for the catch-up BEFORE revealing (reading earlier races it).
        await waitFor('#VideoPlayer.duration', (v) => Number(v) > durBefore + 8, 'the post-resume edge catch-up landed', 15000);
        await press(Key.Ok); // reveal so the bar fields get pushed
        await frames(2500); // the forceLiveBadge reveal-hold (1.6s) releases
        await expectSoft('#trickPlayBar.atLiveEdge', (v) => v === false, 'fell behind the edge after pause');
        await expectSoft('#trickPlayBar.liveOffsetMs', (v) => v > 4000, 'shows a non-trivial time-behind offset');
        const goLiveVisible = await field<boolean>('#goLiveAction.visible');
        if (goLiveVisible === true) {
            group('the focused-bar Go Live action returns to the edge');
            await press(Key.Ok);
            await expectSoft('#trickPlayBar.atLiveEdge', (v) => v === true, 'Go Live restored the live edge', 8000);
            await expectField('#VideoPlayer.state', 'playing');
        } else {
            console.log('  ⚠ soft: stream did not expose the contextual Go Live action — skipping its activation');
        }
    }

    await finish();
})();
