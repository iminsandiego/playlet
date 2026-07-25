// Shared helpers for the VideoPlayerDev on-device e2e specs: each spec deep-links a video, drives the device
// over rta ecp/odc, asserts on ODC field reads, and exits non-zero on failure.
//
// Read `#Chrome.opacity` (1 shown / 0 hidden), not `.visible` — visible stays true mid-fade-out. Read
// `#spinner.mode` (0 none / 1 loading / 2 buffering), not `#spinner.visible` — that id collides with the inner
// BusySpinner and the Group's visible is always true.

import { ecp, odc } from 'roku-test-automation';
import { AppId, setupEnvironment } from './common';
import { Key } from 'roku-test-automation/client/dist/ECP';

export { Key, ecp, odc };

// Mirror the BrightScript enums the renderers project.
export const Mode = { idle: 0, scrub: 1, scan: 2, liveDvr: 3 } as const;
export const Glyph = { none: 0, replay: 9 } as const;
export const Button = {
    previous: 0,
    skipBack: 1,
    playPause: 2,
    skipForward: 3,
    next: 4,
    quality: 5,
    captions: 6,
    stats: 7,
    bookmark: 8,
    minimize: 9,
} as const;

const j = (v: unknown) => JSON.stringify(v);
const eq = (a: unknown, b: unknown) => j(a) === j(b);

let failures: string[] = [];
let soft: string[] = [];
let section = '';

export function group(name: string): void {
    section = name;
    console.log(`\n── ${name} ──`);
}

function record(ok: boolean, msg: string, isSoft = false): void {
    console.log(`  ${ok ? '✓' : isSoft ? '⚠ soft' : '✗ FAIL'} ${msg}`);
    if (!ok) (isSoft ? soft : failures).push(`[${section}] ${msg}`);
}

export async function field<T = unknown>(keyPath: string): Promise<T | undefined> {
    const res = await odc.getValue({ base: 'scene', keyPath });
    return res?.value as T | undefined;
}

// The player retries a failed stream URL once, so a single transient state="error" is expected to recover. A
// second episode, or one that never clears within 8s, is an unrecovered failure — abort the suite.
let errorEpisodes = 0, inError = false, firstErrorAt = 0;
async function fatalErrorTripwire(): Promise<void> {
    let st: string | undefined;
    try { st = await field<string>('#VideoPlayer.state'); } catch { return; }
    if (st === 'error') {
        if (!inError) { inError = true; errorEpisodes++; firstErrorAt = Date.now(); }
        if (errorEpisodes >= 2 || Date.now() - firstErrorAt > 8000) {
            throw new Error(`FATAL: unrecovered video error (episodes=${errorEpisodes}) — the player's one retry did not recover (e.g. 403 with no working stream URL). Aborting the suite.`);
        }
    } else {
        inError = false;
    }
}

async function settle(keyPath: string, pred: (v: unknown) => boolean, timeoutMs: number): Promise<unknown> {
    const start = Date.now();
    let v = await field(keyPath);
    while (!pred(v) && Date.now() - start < timeoutMs) {
        await fatalErrorTripwire();
        await ecp.sleep(120);
        v = await field(keyPath);
    }
    return v;
}

export async function expectField(keyPath: string, expected: unknown, timeoutMs = 4000): Promise<void> {
    const got = await settle(keyPath, (v) => eq(v, expected), timeoutMs);
    record(eq(got, expected), `${keyPath} = ${j(got)}${eq(got, expected) ? '' : ` (expected ${j(expected)})`}`);
}

export async function expectPred(keyPath: string, pred: (v: any) => boolean, descr: string, timeoutMs = 4000): Promise<void> {
    const got = await settle(keyPath, pred, timeoutMs);
    record(pred(got), `${keyPath} ${descr} (got ${j(got)})`);
}

// Soft variant: a miss is a warning, not a failure — for racy signals (the ~700ms replay glyph) and
// live-stream-dependent checks.
export async function expectSoft(keyPath: string, pred: (v: any) => boolean, descr: string, timeoutMs = 1500): Promise<void> {
    const got = await settle(keyPath, pred, timeoutMs);
    record(pred(got), `${keyPath} ${descr} (got ${j(got)})`, true);
}

export async function expectMediaState(expected: string, timeoutMs = 8000): Promise<void> {
    const start = Date.now();
    let last: string | undefined;
    while (Date.now() - start < timeoutMs) {
        last = (await ecp.getMediaPlayer()).state;
        if (last === expected) break;
        await ecp.sleep(250);
    }
    record(last === expected, `ecp media state = ${last}${last === expected ? '' : ` (expected ${expected})`}`);
}

export function check(label: string, ok: boolean, detail?: unknown): void {
    record(ok, `${label}${detail === undefined ? '' : ` (${typeof detail === 'string' ? detail : j(detail)})`}`);
}

export async function press(key: Key): Promise<void> {
    await ecp.sendKeypress(key);
}

// A background home-feed request can fail after a deep-linked player has already opened. Its scene-level
// dialog then sits above the focused player and consumes every ECP key. Dismiss only that known, unrelated
// dialog; an unexpected dialog may be a real player failure and must remain visible to the test.
async function dismissBlockingFeedDialog(): Promise<void> {
    let title: string | undefined;
    try { title = await field<string>('dialog.title'); } catch { title = undefined; }
    if (title !== 'Failed to load feed') return;

    console.log('  dismissing background feed-error dialog before player input');
    await press(Key.Ok);
    const start = Date.now();
    while (Date.now() - start < 4000) {
        try { title = await field<string>('dialog.title'); } catch { title = undefined; }
        if (title === undefined) return;
        await ecp.sleep(120);
    }
}

// Re-send the harmless hidden-HUD Up reveal until Chrome actually paints; once it does, stop immediately so
// focus stays on the bar. The explicit paint acknowledgement also covers a late background feed-error dialog:
// dismissBlockingFeedDialog removes it on the next pass instead of letting it consume the whole player spec.
export async function revealChrome(timeoutMs = 30_000): Promise<boolean> {
    const start = Date.now();
    let opacity = await field<number>('#Chrome.opacity');
    while ((opacity ?? 0) === 0 && Date.now() - start < timeoutMs) {
        await dismissBlockingFeedDialog();
        await press(Key.Up);
        await ecp.sleep(250);
        opacity = await field<number>('#Chrome.opacity');
    }
    const accepted = typeof opacity === 'number' && opacity > 0;
    record(accepted, `Chrome accepted reveal input (opacity=${opacity})`);
    return accepted;
}

// A fixed wait for a visual transition with no field oracle — named so it's auditable. Prefer waitFor().
export async function frames(ms = 200): Promise<void> {
    await ecp.sleep(ms);
}

export async function waitFor(keyPath: string, pred: (v: any) => boolean, descr: string, timeoutMs = 4000): Promise<void> {
    const got = await settle(keyPath, pred, timeoutMs);
    record(pred(got), `waitFor ${keyPath} ${descr} (got ${j(got)})`);
}

// Device-seam invariants read from the live node tree. Polls briefly so the self-heal guard (re-pauses on the
// next position tick) and chrome fades settle — assert the steady state, not a mid-transition blip.
export async function assertPlayerInvariants(label: string): Promise<void> {
    const inTransport = (m: number | undefined) => m === Mode.scrub || m === Mode.scan || m === Mode.liveDvr;
    let mode = await field<number>('#trickPlayBar.transportMode');
    let state = await field<string>('#VideoPlayer.state');
    const start = Date.now();
    while (inTransport(mode) && state === 'playing' && Date.now() - start < 2500) {
        await ecp.sleep(200);
        mode = await field<number>('#trickPlayBar.transportMode');
        state = await field<string>('#VideoPlayer.state');
    }
    const bif = await field<boolean>('#bifDisplay.visible');
    // a transport freezes the video (never "playing" under one); the bif is visible iff a transport is active.
    check(`INV-D1 @ ${label}`, !(inTransport(mode) && state === 'playing'), `mode=${mode} state=${state}`);
    check(`INV-D2 @ ${label}`, bif === inTransport(mode), `bif=${bif} mode=${mode}`);
    // the button row is visible iff idle (it rides the Chrome group's fade for actual paint).
    const rowVisible = await field<boolean>('#buttonRow.visible');
    check(`INV-D3 @ ${label}`, rowVisible === (mode === Mode.idle), `rowVisible=${rowVisible} mode=${mode}`);
    const rowFocused = await field<boolean>('#buttonRow.rowFocused');
    const opacity = await field<number>('#Chrome.opacity');
    // the button row is focusable only at idle; nothing is focused while the chrome is hidden.
    check(`INV-D4 @ ${label}`, !rowFocused || mode === Mode.idle, `rowFocused=${rowFocused} mode=${mode}`);
    check(`INV-D5 @ ${label}`, opacity !== 0 || !rowFocused, `opacity=${opacity} rowFocused=${rowFocused}`);
}

// press + assert the whole invariant set (rapid adversarial sequences have no single per-key oracle). The paced
// wait lets the deferred freeze land after a commit-seek settles before the strict check.
export async function pressChecked(key: Key, label: string): Promise<void> {
    await press(key);
    await frames(600);
    await assertPlayerInvariants(label);
}

// Hard-fail if #VideoPlayer is the stock player, not VideoPlayerDev (chosen at compile time by USE_DEV_PLAYER),
// so a wrong-build run can't masquerade as a pass.
export async function assertPlayerIsDev(): Promise<void> {
    const isDev = await odc.isSubtype({ base: 'scene', keyPath: '#VideoPlayer', subtype: 'VideoPlayerDev' });
    if (!isDev) {
        console.log('\nFAILED: #VideoPlayer is not a VideoPlayerDev. Build the lib with `#const USE_DEV_PLAYER = true` (VideoQueue.bs) before running the player suite.');
        await ecp.sendKeypress(Key.Home);
        process.exit(1);
    }
    console.log('  player node subtype: VideoPlayerDev ✓');
}

// Hard-fail unless the device's EFFECTIVE SponsorBlock config matches the sbskip fixture: enabled +
// notifications + outro=manual_skip (the shipped defaults from config/preferences.json5; user_prefs overrides
// them). With SponsorBlock off the sbskip spec would exercise a plain OK/Right from idle and pass vacuously.
export async function assertSponsorBlockFixture(): Promise<void> {
    let prefs: Record<string, any> = {};
    try {
        const { values } = await odc.readRegistry({});
        prefs = JSON.parse((values as any)?.Playlet?.user_prefs ?? '{}');
    } catch {
        /* no overrides -> the defaults apply */
    }
    const enabled = prefs['sponsorblock.enabled'] ?? true;
    const notifications = prefs['sponsorblock.show_notifications'] ?? true;
    const outro = prefs['sponsorblock.categories']?.outro?.option ?? 'manual_skip';
    if (enabled !== true || notifications !== true || outro !== 'manual_skip') {
        console.log(`\nFAILED: SponsorBlock fixture not met (enabled=${enabled} notifications=${notifications} outro=${outro}).`);
        console.log('  The sbskip spec needs sponsorblock.enabled=true, show_notifications=true and the outro');
        console.log('  category on manual_skip (the defaults) — clear the Playlet/user_prefs overrides or fix them in Settings.');
        await ecp.sendKeypress(Key.Home);
        process.exit(1);
    }
    console.log('  SponsorBlock fixture: enabled + notifications + outro=manual_skip ✓');
}

// Deep-link a video and wait for playback. Polls #VideoPlayer.state (the player node can appear late — live
// manifests take ~20s). Returns false if it never reaches "playing" (e.g. an offline live id).
export async function launch(contentId: string, timeoutMs = 30_000): Promise<boolean> {
    setupEnvironment(AppId.DEV);
    console.log(`launch: contentId=${contentId}`);
    // Every spec runs in its own process. The prior spec's final Home press is asynchronous, so force a clean
    // channel boundary here before deep-linking; otherwise a just-minimized or fading player can leak into the
    // next spec for a few frames and make its first key act on the previous UI state.
    const homeStart = Date.now();
    let homeExited = false;
    while (Date.now() - homeStart < 10_000) {
        await ecp.sendKeypress(Key.Home);
        await ecp.sleep(250);
        let activeId = AppId.DEV;
        try { activeId = (await ecp.getActiveApp()).app?.id as AppId; } catch { /* retry */ }
        if (activeId !== AppId.DEV) {
            homeExited = true;
            break;
        }
    }
    if (!homeExited) {
        console.log('  dev channel did not exit before relaunch');
        return false;
    }
    await ecp.sendLaunchChannel({ params: { contentId }, verifyLaunch: true, verifyLaunchTimeOut: 10_000 });
    const start = Date.now();
    let sawContentLoad = false;
    while (Date.now() - start < timeoutMs) {
        let state: string | undefined;
        let loadedContentId: string | undefined;
        let launchSpinnerMode: number | undefined;
        try {
            state = await field<string>('#VideoPlayer.state');
            loadedContentId = await field<string>('#VideoPlayer.content.videoId');
            launchSpinnerMode = await field<number>('#spinner.mode');
        } catch {
            state = undefined;
            loadedContentId = undefined;
            launchSpinnerMode = undefined;
        }
        if (state !== 'playing' || loadedContentId !== contentId || launchSpinnerMode === 1) {
            sawContentLoad = true;
        }
        // The prior player can remain retained as previousPlayer while the deep link is loading. Do not accept
        // its already-playing state as this launch's readiness; require the requested identity AND evidence of
        // this launch's loading transition before accepting the playing edge.
        if (sawContentLoad && state === 'playing' && loadedContentId === contentId) {
            // The Video field can flip to playing before its scoped OnVideoState callback has projected the
            // first-frame state into the coordinator/renderers. Wait for that callback's durable oracle: it
            // turns the loading spinner off. Without this gate an immediate OK can be intentionally ignored by
            // ShowChrome (firstFrameSeen is still false), making the test exercise startup rather than input.
            const readyStart = Date.now();
            let spinnerMode: number | undefined;
            while (Date.now() - readyStart < 5000) {
                try { spinnerMode = await field<number>('#spinner.mode'); } catch { spinnerMode = undefined; }
                if (spinnerMode === 0) break;
                await ecp.sleep(120);
            }
            if (spinnerMode !== 0) {
                console.log(`  player reached playing but first-frame projection did not settle (spinner.mode=${spinnerMode})`);
                return false;
            }
            await assertPlayerIsDev();
            // The device can report the player rendered several seconds before the scene routes ECP keys to
            // it. Wait on the exact readiness condition instead of sleeping: upstream keeps real focus on the
            // VideoPlayer root while its HUD uses virtual focus.
            const focusStart = Date.now();
            let playerFocused = false;
            while (Date.now() - focusStart < 6000) {
                try {
                    playerFocused = await odc.hasFocus({ base: 'scene', keyPath: '#VideoPlayer' });
                } catch {
                    playerFocused = false;
                }
                if (playerFocused) break;
                await ecp.sleep(120);
            }
            if (!playerFocused) {
                console.log('  player reached playing but never received scene focus');
                return false;
            }

            // state=playing + first-frame projection + root focus are necessary but not sufficient on-device:
            // a background feed-error dialog can arrive after player creation and consume remote keys. Use an
            // acknowledged Up reveal as the final readiness oracle, then restore the hidden-HUD baseline every
            // spec expects. This keeps unrelated startup work out of the player behavior assertions.
            if (!await revealChrome()) {
                console.log('  player reached playing/focus but did not accept ECP input');
                return false;
            }
            await press(Key.Back);
            const resetStart = Date.now();
            let resetOpacity = await field<number>('#Chrome.opacity');
            while (resetOpacity !== 0 && Date.now() - resetStart < 7000) {
                await ecp.sleep(120);
                resetOpacity = await field<number>('#Chrome.opacity');
            }
            if (resetOpacity !== 0) {
                console.log(`  input probe succeeded but Chrome did not return to hidden (opacity=${resetOpacity})`);
                return false;
            }
            return true;
        }
        if (state === 'error' && loadedContentId === contentId) {
            console.log('  player entered state=error');
            return false;
        }
        await ecp.sleep(500);
    }
    console.log('  player did not reach state=playing within timeout');
    return false;
}

// Deep-link a known-good VOD and hard-fail if it never plays (a real failure, not a skip).
export async function launchVod(contentId: string): Promise<void> {
    const playing = await launch(contentId);
    if (!playing) {
        console.log(`\nFAILED: known-good VOD ${contentId} never reached "playing" — a real failure, not a skip.`);
        await ecp.sendKeypress(Key.Home);
        process.exit(1);
    }
}

// Tear down (Home) and exit non-zero on any hard failure; skipped=true (precondition not met) reports as a pass.
export async function finish(skipped = false): Promise<never> {
    try {
        await odc.shutdown();
    } catch {
        /* odc may not be connected */
    }
    await ecp.sendKeypress(Key.Home);
    if (soft.length) {
        console.log(`\n${soft.length} soft warning(s):`);
        soft.forEach((s) => console.log(`  ⚠ ${s}`));
    }
    if (skipped) {
        console.log('\nSKIPPED (precondition not met) — treated as pass.');
        process.exit(0);
    }
    if (failures.length) {
        console.log(`\nFAILED — ${failures.length} assertion(s):`);
        failures.forEach((f) => console.log(`  ✗ ${f}`));
        process.exit(1);
    }
    console.log('\nPASSED ✓');
    process.exit(0);
}
