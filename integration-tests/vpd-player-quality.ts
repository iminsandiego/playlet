// Player-hosted playback-settings e2e: open the combined panel, enter/return from the quality selector,
// exercise speed adjustment, then close back to the owning player-bar button without retaining mutations.

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

async function restoreUserPrefs(raw: string | undefined): Promise<void> {
    await odc.writeRegistry({
        values: {
            Playlet: {
                user_prefs: raw ?? null,
            },
        } as any,
    });
}

(async () => {
    await launchVod(CONTENT_ID);
    const initialUserPrefsRaw = await readUserPrefsRaw();

    try {
    group('Playback settings is the first right-cluster button');
    await expectField('#Chrome.opacity', 0, 7000);
    await revealChrome(); // hidden -> trackbar
    await press(Key.Up); // trackbar -> play/pause
    await expectField('#buttonRow.focusedIndex', Button.playPause);
    await press(Key.Right); // skip disabled Next -> Playback settings
    await expectField('#buttonRow.focusedIndex', Button.playbackSettings);
    await expectField('#PlaybackSettingsButton.focused', true);
    await expectPred('#buttonRow.qualityLabel', (v) => typeof v === 'string' && v.length > 0, 'shows the effective quality');

    group('Playback settings opens one panel for quality and speed');
    await press(Key.Ok);
    await expectPred('#qualityButton.text', (v) => typeof v === 'string' && v.includes('Default quality'), 'labels quality honestly as a default');
    await expectPred('#speedButton.text', (v) => typeof v === 'string' && v.includes('Speed for this video') && v.includes('Default'), 'marks the speed scope and configured default');
    check('quality row receives initial focus', await odc.hasFocus({ base: 'scene', keyPath: '#qualityButton' }));

    group('Quality row opens the existing full embedded selector');
    await press(Key.Ok);
    await expectField('#checkList.content.#auto.title', 'Auto');
    await expectField('#checkList.content.#1080p.title', '1080p');
    await expectField('#checkList.content.#720p.title', '720p');
    check('selector opens in the quality list', await odc.hasFocus({ base: 'scene', keyPath: '#checkList' }));
    await expectField('#checkList.itemFocused', 0);
    await expectField('#VideoPlayer.width', 1280);

    group('Down starts at Auto; choosing a quality remains in the list');
    await press(Key.Down); // Auto -> 1080p
    await expectField('#checkList.itemFocused', 1);
    await press(Key.Ok); // stage 1080p; host preference is unchanged until Save
    check('a changed selection keeps list focus', await odc.hasFocus({ base: 'scene', keyPath: '#checkList' }));

    group('Down from the final quality reaches Save');
    for (let i = 0; i < 12; i++) await press(Key.Down);
    check('quality list boundary reaches Save', await odc.hasFocus({ base: 'scene', keyPath: '#saveButton' }));

    group('Right moves from Save to Close without affecting playback');
    await press(Key.Right);
    await expectField('#VideoPlayer.width', 1280);
    check('Right moves focus from Save to Close', await odc.hasFocus({ base: 'scene', keyPath: '#closeButton' }));

    group('Close cancels quality and returns to the parent settings panel');
    await press(Key.Ok);
    await expectPred('#speedButton.text', (v) => typeof v === 'string' && v.includes('Speed for this video'), 'restores the parent panel');
    check('quality cancel preserves Playlet/user_prefs byte-for-byte', await readUserPrefsRaw() === initialUserPrefsRaw);

    group('Quality Save applies a different default and returns to the parent panel');
    const beforeSaveQualityText = await field<string>('#qualityButton.text');
    await press(Key.Up); // speed -> quality
    check('quality row receives focus again', await odc.hasFocus({ base: 'scene', keyPath: '#qualityButton' }));
    await press(Key.Ok);
    const checkedQuality = (await field<number>('#checkList.checkedItem')) ?? 0;
    const targetQuality = checkedQuality === 1 ? 2 : 1; // choose 720p if already 1080p, otherwise 1080p
    for (let i = 0; i < targetQuality; i++) await press(Key.Down); // selector always starts at Auto
    await expectField('#checkList.itemFocused', targetQuality);
    const targetQualityValue = await field<string>(`#checkList.content.${targetQuality}.id`);
    await press(Key.Ok);
    for (let i = 0; i < 12; i++) await press(Key.Down);
    check('changed quality reaches Save', await odc.hasFocus({ base: 'scene', keyPath: '#saveButton' }));
    await press(Key.Ok);
    await expectPred(
        '#qualityButton.text',
        (v) => typeof v === 'string' && v !== beforeSaveQualityText,
        'shows the changed saved quality in the parent panel',
    );
    const savedRaw = await readUserPrefsRaw();
    check(
        'quality Save updates Playlet/user_prefs with the selected quality',
        savedRaw !== initialUserPrefsRaw && typeof targetQualityValue === 'string' && savedRaw?.includes(targetQualityValue) === true,
    );
    const savedQualityPrefsRaw = savedRaw;

    group('Left/Right changes only the current video speed and can restore the original value');
    const initialSpeed = await field<number>('#VideoPlayer.playbackSpeed');
    const initialSpeedText = await field<string>('#speedButton.text');
    await press(Key.Down); // Quality -> speed for this video
    check('speed row receives focus', await odc.hasFocus({ base: 'scene', keyPath: '#speedButton' }));
    await press(Key.Left);
    await expectPred('#VideoPlayer.playbackSpeed', (v) => typeof v === 'number' && v !== initialSpeed, 'applies the changed speed');
    check('current-video speed leaves Playlet/user_prefs byte-for-byte unchanged', await readUserPrefsRaw() === savedQualityPrefsRaw);
    await press(Key.Right);
    await expectField('#VideoPlayer.playbackSpeed', initialSpeed);
    await expectField('#speedButton.text', initialSpeedText);

    group('Back closes settings and restores the Playback settings button');
    await press(Key.Back);
    await expectField('#Chrome.opacity', 1);
    await expectField('#buttonRow.rowFocused', true);
    await expectField('#buttonRow.focusedIndex', Button.playbackSettings);
    await expectField('#PlaybackSettingsButton.focused', true);
    check('round-trip speed adjustment leaves the saved quality preference unchanged', await readUserPrefsRaw() === savedQualityPrefsRaw);
    await expectPred('#VideoPlayer.state', (state) => state === 'playing', 'keeps playing while selecting and cancelling');

    } finally {
        await restoreUserPrefs(initialUserPrefsRaw);
        check('restores Playlet/user_prefs byte-for-byte', await readUserPrefsRaw() === initialUserPrefsRaw);
    }

    await finish();
})();
