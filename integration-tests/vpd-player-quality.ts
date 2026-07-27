// Direct quality + speed player-bar e2e: each compact value pill opens its focused selector, returns to the
// owning button, and preserves the distinction between the saved quality default and current-video speed.

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
    expectMediaState,
    expectPred,
    odc,
} from './vpd-player-harness';

const CONTENT_ID = 'aqz-KE-bpKQ'; // Big Buck Bunny — stable long-form VOD
const SPEED_VALUES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

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

async function openQualityFromBar(): Promise<void> {
    await press(Key.Ok);
    await expectField('#checkList.content.#auto.title', 'Auto');
    await expectField('#checkList.content.#1080p.title', '1080p');
    await expectField('#checkList.content.#720p.title', '720p');
    check('quality selector owns focus', await odc.hasFocus({ base: 'scene', keyPath: '#checkList' }));
    await expectField('#checkList.itemFocused', 0);
}

(async () => {
    await launchVod(CONTENT_ID);
    const initialUserPrefsRaw = await readUserPrefsRaw();

    try {
        group('Quality and speed are direct value buttons on the player bar');
        await expectField('#Chrome.opacity', 0, 7000);
        await revealChrome(); // hidden -> trackbar
        await press(Key.Up); // trackbar -> play/pause
        await expectField('#buttonRow.focusedIndex', Button.playPause);
        await press(Key.Right); // skip disabled Next -> Quality
        await expectField('#buttonRow.focusedIndex', Button.quality);
        await expectField('#QualityButton.focused', true);
        await expectPred('#QualityButton.text', (v) => typeof v === 'string' && v.length > 0, 'quality pill shows its saved value');

        group('Quality opens directly and Close returns to its player-bar button');
        await openQualityFromBar();
        await press(Key.Down); // Auto -> first manual quality
        await press(Key.Ok); // stage the choice; preference remains unchanged until Save
        for (let i = 0; i < 12; i++) await press(Key.Down);
        check('quality list boundary reaches Save', await odc.hasFocus({ base: 'scene', keyPath: '#saveButton' }));
        await press(Key.Right);
        check('Right moves from Save to Close', await odc.hasFocus({ base: 'scene', keyPath: '#closeButton' }));
        await press(Key.Ok);
        await expectField('#Chrome.opacity', 1);
        await expectField('#buttonRow.focusedIndex', Button.quality);
        await expectField('#QualityButton.focused', true);
        check('quality cancel preserves Playlet/user_prefs byte-for-byte', await readUserPrefsRaw() === initialUserPrefsRaw);

        group('Quality Save updates the value pill and restores its focus');
        const beforeSaveQualityText = await field<string>('#QualityButton.text');
        await openQualityFromBar();
        await press(Key.Ok); // toggle Auto: manual set -> Auto, or Auto -> every supported manual quality
        const targetQualityValue = await field<string>('#playerQualitySelector.value');
        check('Auto toggle produces a different saved-quality value', typeof targetQualityValue === 'string' && targetQualityValue.length > 0);
        for (let i = 0; i < 12; i++) await press(Key.Down);
        check('changed quality reaches Save', await odc.hasFocus({ base: 'scene', keyPath: '#saveButton' }));
        await press(Key.Ok);
        await expectPred(
            '#QualityButton.text',
            (v) => typeof v === 'string' && v !== beforeSaveQualityText,
            'quality pill shows the changed saved value',
        );
        await expectField('#buttonRow.focusedIndex', Button.quality);
        await expectField('#QualityButton.focused', true);
        const savedQualityPrefsRaw = await readUserPrefsRaw();
        check(
            'quality Save updates Playlet/user_prefs with the selected quality',
            savedQualityPrefsRaw !== initialUserPrefsRaw
                && targetQualityValue !== undefined
                && savedQualityPrefsRaw?.includes(targetQualityValue) === true,
        );

        group('Speed opens directly and changes only the current video');
        await press(Key.Right); // Quality -> Speed
        await expectField('#buttonRow.focusedIndex', Button.speed);
        await expectField('#SpeedButton.focused', true);
        const initialSpeed = (await field<number>('#VideoPlayer.playbackSpeed')) ?? 1;
        const initialSpeedIndex = Math.max(0, SPEED_VALUES.findIndex((value) => Math.abs(value - initialSpeed) < 0.001));
        const targetSpeedIndex = initialSpeedIndex === SPEED_VALUES.length - 1 ? initialSpeedIndex - 1 : initialSpeedIndex + 1;
        const speedDirection = targetSpeedIndex > initialSpeedIndex ? Key.Down : Key.Up;

        await press(Key.Ok);
        await expectField('#playerSpeedSelector.title', 'Speed for this video');
        await expectField('#speedList.checkedItem', initialSpeedIndex);
        check('speed selector owns focus', await odc.hasFocus({ base: 'scene', keyPath: '#speedList' }));
        await press(Key.Play);
        await expectMediaState('pause');
        await expectField('#playerSpeedSelector.title', 'Speed for this video');
        await press(Key.Play);
        await expectMediaState('play');
        await press(speedDirection);
        await expectField('#speedList.itemFocused', targetSpeedIndex);
        await press(Key.Ok); // selecting a radio item saves and closes
        await expectField('#VideoPlayer.playbackSpeed', SPEED_VALUES[targetSpeedIndex]);
        await expectField('#buttonRow.focusedIndex', Button.speed);
        await expectField('#SpeedButton.focused', true);
        check('current-video speed leaves Playlet/user_prefs byte-for-byte unchanged', await readUserPrefsRaw() === savedQualityPrefsRaw);

        group('Reopening speed starts on the current value and can restore the original');
        await press(Key.Ok);
        await expectField('#speedList.checkedItem', targetSpeedIndex);
        await press(targetSpeedIndex > initialSpeedIndex ? Key.Up : Key.Down);
        await expectField('#speedList.itemFocused', initialSpeedIndex);
        await press(Key.Ok);
        await expectField('#VideoPlayer.playbackSpeed', initialSpeed);
        await expectField('#buttonRow.focusedIndex', Button.speed);
        await expectField('#SpeedButton.focused', true);
        check('round-trip speed adjustment leaves the saved quality preference unchanged', await readUserPrefsRaw() === savedQualityPrefsRaw);
        await expectPred('#VideoPlayer.state', (state) => state === 'playing', 'keeps playing after selector choices');
    } finally {
        await restoreUserPrefs(initialUserPrefsRaw);
        check('restores Playlet/user_prefs byte-for-byte', await readUserPrefsRaw() === initialUserPrefsRaw);
    }

    await finish();
})();
