// Dedicated +/-10s button e2e: exercise the real ButtonRow -> coordinator -> TransportController -> Video
// path, including rapid accumulation, while proving the one-shot seeks never enter the preview transport.

import {
    Key,
    Button,
    Mode,
    field,
    press,
    revealChrome,
    launchVod,
    finish,
    group,
    expectField,
    expectPred,
} from './vpd-player-harness';

const CONTENT_ID = 'aqz-KE-bpKQ';

async function focusPlayButton(): Promise<void> {
    await expectField('#Chrome.opacity', 0, 7000);
    await revealChrome();
    await press(Key.Up);
    await expectField('#buttonRow.focusedIndex', Button.playPause);
}

async function expectActivePlayback(): Promise<void> {
    await expectPred(
        '#VideoPlayer.state',
        (state) => state === 'playing' || state === 'buffering',
        'continues playback (or is temporarily buffering), never paused',
    );
}

(async () => {
    await launchVod(CONTENT_ID);

    group('Forward 10 seeks immediately and keeps the renderer idle');
    await focusPlayButton();
    await press(Key.Right);
    await expectField('#buttonRow.focusedIndex', Button.skipForward);
    const start = (await field<number>('#VideoPlayer.position')) ?? 0;
    await press(Key.Ok);
    await expectPred('#VideoPlayer.position', (v) => typeof v === 'number' && v >= start + 7, `advanced about 10s from ${start}`, 12_000);
    await expectField('#trickPlayBar.transportMode', Mode.idle);
    await expectField('#bifDisplay.visible', false);
    await expectActivePlayback();

    group('Back 10 returns toward the prior position without pausing');
    await focusPlayButton();
    await press(Key.Left);
    await expectField('#buttonRow.focusedIndex', Button.skipBack);
    const beforeBack = (await field<number>('#VideoPlayer.position')) ?? 0;
    await press(Key.Ok);
    await expectPred('#VideoPlayer.position', (v) => typeof v === 'number' && v <= beforeBack - 7, `rewound about 10s from ${beforeBack}`, 12_000);
    await expectField('#trickPlayBar.transportMode', Mode.idle);
    await expectField('#bifDisplay.visible', false);
    await expectActivePlayback();

    group('rapid Forward 10 presses accumulate to about +20s');
    await focusPlayButton();
    await press(Key.Right);
    await expectField('#buttonRow.focusedIndex', Button.skipForward);
    const rapidStart = (await field<number>('#VideoPlayer.position')) ?? 0;
    await press(Key.Ok);
    await press(Key.Ok);
    await expectPred('#VideoPlayer.position', (v) => typeof v === 'number' && v >= rapidStart + 16, `advanced about 20s from ${rapidStart}`, 15_000);
    await expectField('#trickPlayBar.transportMode', Mode.idle);
    await expectField('#bifDisplay.visible', false);
    await expectActivePlayback();

    await finish();
})();
