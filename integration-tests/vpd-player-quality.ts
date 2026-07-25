// Player-hosted Quality selector e2e: open the full selector from the ten-button row, prove its baseline
// choices and modal key ownership, then cancel without changing the user's persisted preference.

import {
    Key,
    Button,
    check,
    field,
    press,
    revealChrome,
    launchVod,
    finish,
    group,
    expectField,
    expectPred,
    odc,
} from './vpd-player-harness';

const CONTENT_ID = 'aqz-KE-bpKQ'; // Big Buck Bunny — stable long-form VOD

async function readUserPrefsRaw(): Promise<string | undefined> {
    const result = await odc.readRegistry({ values: { Playlet: ['user_prefs'] } });
    const raw = result.values?.Playlet?.user_prefs;
    return typeof raw === 'string' ? raw : undefined;
}

(async () => {
    await launchVod(CONTENT_ID);
    const initialUserPrefsRaw = await readUserPrefsRaw();

    group('Quality is the first right-cluster button in the final ten-button row');
    await expectField('#Chrome.opacity', 0, 7000);
    await revealChrome(); // hidden -> trackbar
    await press(Key.Up); // trackbar -> play/pause
    await expectField('#buttonRow.focusedIndex', Button.playPause);
    await press(Key.Right); // -> skip forward
    await press(Key.Right); // skip disabled Next -> Quality
    await expectField('#buttonRow.focusedIndex', Button.quality);
    await expectField('#QualityButton.focused', true);
    await expectPred('#buttonRow.qualityLabel', (v) => typeof v === 'string' && v.length > 0, 'shows the effective quality');

    group('Quality opens the full embedded selector');
    await press(Key.Ok);
    await expectField('#checkList.content.#auto.title', 'Auto');
    await expectField('#checkList.content.#1080p.title', '1080p');
    await expectField('#checkList.content.#720p.title', '720p');
    check('selector opens on Save so the action row is reachable', await odc.hasFocus({ base: 'scene', keyPath: '#saveButton' }));
    await expectField('#VideoPlayer.width', 1280);

    group('Up enters the full list; choosing a quality returns to Save');
    await press(Key.Up); // Save -> checklist
    check('quality checklist receives real SceneGraph focus', await odc.hasFocus({ base: 'scene', keyPath: '#checkList' }));
    await press(Key.Down); // Auto -> 1080p
    await press(Key.Ok); // stage 1080p; host preference is unchanged until Save
    check('a changed selection returns focus to Save', await odc.hasFocus({ base: 'scene', keyPath: '#saveButton' }));

    group('Right moves from Save to Close without affecting playback');
    await press(Key.Right);
    await expectField('#VideoPlayer.width', 1280);
    check('Right moves focus from Save to Close', await odc.hasFocus({ base: 'scene', keyPath: '#closeButton' }));

    group('Close cancels and restores the Quality button without mutating preferences');
    await press(Key.Ok);
    await expectField('#Chrome.opacity', 1);
    await expectField('#buttonRow.rowFocused', true);
    await expectField('#buttonRow.focusedIndex', Button.quality);
    await expectField('#QualityButton.focused', true);
    check('cancel preserves Playlet/user_prefs byte-for-byte', await readUserPrefsRaw() === initialUserPrefsRaw);
    await expectPred('#VideoPlayer.state', (state) => state === 'playing', 'keeps playing while selecting and cancelling');

    await finish();
})();
