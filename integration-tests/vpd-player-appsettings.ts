// App Settings e2e for the player features: the Playback section keeps focus visible without jittering,
// default speed opens as a modal list and saves a choice, and chapter markers remain a direct toggle.
// The test snapshots and restores user_prefs exactly so it does not alter the signed-in dev app.

import {
    Key,
    check,
    ecp,
    odc,
    field,
    press,
    finish,
    frames,
    group,
    expectField,
    expectPred,
    waitFor,
} from './vpd-player-harness';
import { AppId, setupEnvironment } from './common';

const SPEED_VALUES = ['0.25', '0.5', '0.75', '1.0', '1.25', '1.5', '1.75', '2.0'];
// Preference ids contain periods, which RTA interprets as key-path separators. The settings container's
// static scroll animation is child 0, so child 1 is Playback: its child 0 is the heading and children 1..5
// are the five visible TV controls.
const PLAYBACK = {
    autoplay: '#SettingsScreen.0.1.1',
    quality: '#SettingsScreen.0.1.2',
    speed: '#SettingsScreen.0.1.3',
    chapters: '#SettingsScreen.0.1.4',
    disableDubbed: '#SettingsScreen.0.1.5',
} as const;
const SETTINGS_CONTAINER = '#SettingsScreen.0';

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

async function launchApp(): Promise<void> {
    setupEnvironment(AppId.DEV);
    for (let i = 0; i < 20; i++) {
        await ecp.sendKeypress(Key.Home);
        await frames(200);
        try {
            if ((await ecp.getActiveApp()).app?.id !== AppId.DEV) break;
        } catch {
            // Retry until the Home transition is observable.
        }
    }
    await ecp.sendLaunchChannel({ verifyLaunch: true, verifyLaunchTimeOut: 10_000 });
    await waitFor('#ItemsList.itemFocused', (v) => typeof v === 'number', 'main navigation is ready', 12_000);
    if (await field<string>('dialog.title') === 'Failed to load feed') {
        await press(Key.Ok);
    }
}

async function inFocusChain(keyPath: string): Promise<boolean> {
    return odc.isInFocusChain({ base: 'scene', keyPath });
}

async function focusNavigation(): Promise<boolean> {
    for (let i = 0; i < 12; i++) {
        try {
            if (await odc.hasFocus({ base: 'scene', keyPath: '#ItemsList' })) return true;
            if (await field<string>('dialog.title') === 'Failed to load feed') {
                await press(Key.Ok);
            } else {
                await press(Key.Left);
            }
        } catch {
            await press(Key.Left);
        }
        await frames(250);
    }
    return false;
}

(async () => {
    await launchApp();
    const initialUserPrefsRaw = await readUserPrefsRaw();

    try {
        group('navigate from Home to the Playback settings category');
        await expectField('#ItemsList.itemFocused', 2);
        check('main navigation receives focus', await focusNavigation());
        await press(Key.Down);
        await press(Key.Down);
        await expectField('#ItemsList.itemFocused', 4);
        await press(Key.Right);
        await waitFor(`${PLAYBACK.autoplay}.value`, (v) => typeof v === 'boolean', 'Playback controls are created', 8000);
        await expectField(`${PLAYBACK.speed}.id`, 'preference.playback.preferred_speed');
        await expectField(`${PLAYBACK.chapters}.id`, 'preference.playback.show_chapter_markers');
        await press(Key.Right);
        check('Autoplay receives focus', await inFocusChain(PLAYBACK.autoplay));

        group('early Playback controls do not nudge the page while already visible');
        await frames(400);
        const initialTranslation = await field<number[]>(`${SETTINGS_CONTAINER}.translation`);
        await press(Key.Down);
        await frames(400);
        check('Default quality receives focus', await inFocusChain(PLAYBACK.quality));
        await expectField(`${SETTINGS_CONTAINER}.translation`, initialTranslation);
        await press(Key.Down);
        await frames(400);
        check('Default playback speed receives focus', await inFocusChain(PLAYBACK.speed));
        await expectField(`${SETTINGS_CONTAINER}.translation`, initialTranslation);

        group('default playback speed opens a focused eight-choice modal and saves');
        await press(Key.Ok);
        await expectField('#speedList.content.getChildCount()', 8);
        check('speed list receives modal focus', await odc.hasFocus({ base: 'scene', keyPath: '#speedList' }));
        const currentIndex = (await field<number>('#speedList.checkedItem')) ?? 3;
        await expectField('#speedList.itemFocused', currentIndex);
        const targetIndex = currentIndex < SPEED_VALUES.length - 1 ? currentIndex + 1 : currentIndex - 1;
        await press(targetIndex > currentIndex ? Key.Down : Key.Up);
        await expectField('#speedList.itemFocused', targetIndex);
        await press(Key.Ok);
        await waitFor(`${PLAYBACK.speed}.value`, (v) => v === SPEED_VALUES[targetIndex], 'selected speed saved', 5000);
        check('focus returns to Default playback speed', await inFocusChain(PLAYBACK.speed));
        check('saved speed updates user_prefs', await readUserPrefsRaw() !== initialUserPrefsRaw);

        group('chapter markers remain a visible, direct setting');
        await press(Key.Down);
        await frames(400);
        check('Show chapter markers receives focus', await inFocusChain(PLAYBACK.chapters));
        await expectField(`${SETTINGS_CONTAINER}.translation`, initialTranslation);
        const chapterValue = await field<boolean>(`${PLAYBACK.chapters}.value`);
        await press(Key.Ok);
        await expectField(`${PLAYBACK.chapters}.value`, !chapterValue);

        group('scrolling keeps the next focused control on screen');
        await press(Key.Down);
        await frames(500);
        check('Disable auto-dubbed audio receives focus', await inFocusChain(PLAYBACK.disableDubbed));
        await expectPred(
            `${PLAYBACK.disableDubbed}.sceneBoundingRect()`,
            (rect) => rect && rect.y >= 50 && rect.y + rect.height <= 670,
            'is fully inside the Settings viewport',
        );
    } finally {
        await restoreUserPrefs(initialUserPrefsRaw);
        check('restores Playlet/user_prefs byte-for-byte', await readUserPrefsRaw() === initialUserPrefsRaw);
    }

    await finish();
})();
