// Stats for Nerds e2e: toggle the persisted overlay through the player button row, assert live values are
// projected, and prove the overlay is independent of the auto-hiding Chrome. The test restores the user's
// initial Stats preference before leaving the channel.

import {
    Key,
    Button,
    field,
    press,
    revealChrome,
    launchVod,
    finish,
    group,
    expectField,
    expectPred,
    expectSoft,
} from './vpd-player-harness';

const CONTENT_ID = 'aqz-KE-bpKQ'; // Big Buck Bunny — keeps playing through the HUD auto-hide assertions

(async () => {
    await launchVod(CONTENT_ID);

    group('reveal the HUD and focus the Stats button');
    await expectField('#Chrome.opacity', 0, 7000);
    await revealChrome(); // hidden -> shown, trackbar focused
    await expectField('#Chrome.opacity', 1);
    await press(Key.Up); // trackbar -> button row
    await expectField('#buttonRow.rowFocused', true);
    await expectField('#buttonRow.focusedIndex', Button.playPause);
    await press(Key.Right); // skip disabled Next -> Quality
    await press(Key.Right); // Quality -> Speed
    await press(Key.Right); // Speed -> Captions
    await press(Key.Right); // Captions -> Stats
    await expectField('#buttonRow.focusedIndex', Button.stats);
    await expectField('#StatsButton.focused', true);

    // The preference is intentionally persistent. Normalize to off for the exercise, then restore this value
    // before finish() so running the integration suite does not change the user's normal player setup.
    const initiallyEnabled = (await field<boolean>('#buttonRow.statsEnabled')) === true;
    if (initiallyEnabled) {
        group('normalize an initially enabled preference to off');
        await press(Key.Ok);
        await expectField('#buttonRow.statsEnabled', false);
        await expectField('#StatsButton.active', false);
        await expectField('#StatsButton.toggleState', true);
    }

    group('Stats button enables the passive fullscreen overlay');
    await press(Key.Ok);
    await expectField('#buttonRow.statsEnabled', true);
    await expectField('#StatsButton.active', true);
    await expectField('#StatsButton.toggleState', false);
    await expectField('#statsBg.visible', true);
    await expectField('#line1Value.text', 'playing');
    await expectPred('#line2Value.text', (v) => typeof v === 'string' && v.includes(':'), 'shows a formatted position');
    await expectPred('#line3Value.text', (v) => typeof v === 'string' && v.includes(':'), 'shows a formatted duration');
    group('the overlay remains visible after the HUD auto-hides');
    await expectField('#Chrome.opacity', 0, 7000);
    await expectField('#statsBg.visible', true);
    await expectField('#line1Value.text', 'playing');
    // Roku firmware and stream selection do not expose every heavy field consistently; at least one should be
    // available on a real playback, but keep that device-dependent observation soft.
    await expectSoft(
        '#line8Value.text',
        (v) => typeof v === 'string' && v.length > 0,
        'shows the inferred stream container',
        4000,
    );

    group('turn Stats off through the row');
    await press(Key.Ok); // reveal -> trackbar
    await expectField('#Chrome.opacity', 1);
    await press(Key.Up); // -> play/pause
    await press(Key.Right); // -> Quality
    await press(Key.Right); // -> Speed
    await press(Key.Right); // -> Captions
    await press(Key.Right); // -> Stats
    await expectField('#buttonRow.focusedIndex', Button.stats);
    await press(Key.Ok);
    await expectField('#buttonRow.statsEnabled', false);
    await expectField('#StatsButton.active', false);
    await expectField('#StatsButton.toggleState', true);

    if (initiallyEnabled) {
        group('restore the initially enabled preference');
        await press(Key.Ok); // focus remains on Stats
        await expectField('#buttonRow.statsEnabled', true);
        await expectField('#StatsButton.active', true);
    }

    await finish();
})();
