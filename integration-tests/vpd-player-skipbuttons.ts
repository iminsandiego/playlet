// Simplified transport-row e2e: prove the dedicated +/-10 buttons are gone while Left/Right on the focused
// timeline still provide both seek directions. The filename stays stable for the player-suite runner.

import {
    Key,
    Button,
    Mode,
    field,
    odc,
    press,
    revealChrome,
    launchVod,
    finish,
    group,
    expectField,
    expectPred,
} from './vpd-player-harness';

// This MrBeast upload publishes storyboard frames every 5 seconds. It is the regression fixture for the bug
// where transport incorrectly inherited the publisher's thumbnail cadence instead of using a fixed 10s step.
const CONTENT_ID = 'lVylRtlPOIE';

async function focusPlayButton(): Promise<void> {
    await revealChrome();
    await press(Key.Up);
    await expectField('#buttonRow.focusedIndex', Button.playPause);
}

(async () => {
    await launchVod(CONTENT_ID);

    group('the reduced row has eight controls and no intermediate seek buttons');
    await expectField('#Chrome.opacity', 0, 7000);
    await focusPlayButton();
    await expectField('#buttonRow.buttonCount', 8);
    await press(Key.Left);
    await expectField('#buttonRow.focusedIndex', Button.playPause); // disabled Previous is skipped and clamps
    await press(Key.Right);
    await expectField('#buttonRow.focusedIndex', Button.playbackSettings); // disabled Next is skipped directly

    group('Left/Right use fixed 10-second steps even with 5-second storyboards');
    await odc.setValue({ base: 'scene', keyPath: '#VideoPlayer.seek', value: 60 });
    await expectPred('#VideoPlayer.position', (v) => typeof v === 'number' && v >= 59 && v <= 62, 'settled near 60s', 12_000);
    await revealChrome();
    await press(Key.Down);
    await expectField('#trickPlayBar.focused', true);
    const positionMs = (await field<number>('#trickPlayBar.positionMs')) ?? 0;
    await press(Key.Left);
    await expectField('#trickPlayBar.transportMode', Mode.scrub);
    await expectField('#trickPlayBar.cursorMs', positionMs - 10_000);
    await press(Key.Right);
    await expectField('#trickPlayBar.cursorMs', positionMs);
    await press(Key.Ok);

    group('physical FF and RW use the same fixed 10-second L1 scan base');
    await expectField('#VideoPlayer.state', 'playing', 8000);
    await press(Key.Play);
    await expectField('#VideoPlayer.state', 'paused', 8000);
    const ffBaseMs = (await field<number>('#trickPlayBar.positionMs')) ?? 0;
    await press(Key.Forward);
    await expectField('#trickPlayBar.transportMode', Mode.scan);
    await expectPred(
        '#trickPlayBar.cursorMs',
        (v) => typeof v === 'number' && v >= ffBaseMs + 10_000 && (v - ffBaseMs) % 10_000 === 0,
        `advanced by one or more 10s scan ticks from ${ffBaseMs}`,
        1800,
    );
    await press(Key.Ok);
    await expectField('#VideoPlayer.state', 'playing', 8000);
    await press(Key.Play);
    await expectField('#VideoPlayer.state', 'paused', 8000);
    const rwBaseMs = (await field<number>('#trickPlayBar.positionMs')) ?? 0;
    await press(Key.Rewind);
    await expectField('#trickPlayBar.transportMode', Mode.scan);
    await expectPred(
        '#trickPlayBar.cursorMs',
        (v) => typeof v === 'number' && v <= rwBaseMs - 10_000 && (rwBaseMs - v) % 10_000 === 0,
        `rewound by one or more 10s scan ticks from ${rwBaseMs}`,
        1800,
    );
    await press(Key.Ok);

    await finish();
})();
