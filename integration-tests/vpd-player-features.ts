// Captions + Bookmark e2e: exercise both feature buttons on a video with maintained English captions while
// preserving the Roku's exact global caption mode and the user's exact serialized bookmarks registry value.
// Cleanup runs before finish() because finish exits the process.

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
    ecp,
} from './vpd-player-harness';

// This is Playlet's maintained Invidious caption-health fixture
// (InvidiousInstanceTestingJob.CanFetchVideoCaptions: English track + known expected text).
const CONTENT_ID = 'k85mRPqvMbE';

function hasBookmark(raw: string | undefined, videoId: string): boolean {
    if (raw === undefined) return false;
    const parsed = JSON.parse(raw) as { groups?: Array<{ bookmarks?: Array<{ id?: string }> }> };
    return parsed.groups?.some((group) => group.bookmarks?.some((bookmark) => bookmark.id === videoId)) === true;
}

async function readBookmarksRaw(): Promise<string | undefined> {
    const result = await odc.readRegistry({ values: { Playlet: ['bookmarks'] } });
    const raw = result.values?.Playlet?.bookmarks;
    return typeof raw === 'string' ? raw : undefined;
}

async function waitForBookmark(expected: boolean, timeoutMs = 10_000): Promise<boolean> {
    // contentChange persistence and the ODC registry request run on the render thread. Let the save observer
    // drain before sending a read; an immediate request can snapshot the prior value and return much later.
    await ecp.sleep(500);
    const start = Date.now();
    let present = hasBookmark(await readBookmarksRaw(), CONTENT_ID);
    while (present !== expected && Date.now() - start < timeoutMs) {
        await ecp.sleep(120);
        present = hasBookmark(await readBookmarksRaw(), CONTENT_ID);
    }
    // An ODC read issued before Save can return the old snapshot after the timeout window has elapsed. Take
    // one fresh read after that response rather than reporting its stale value as the steady state.
    if (present !== expected) {
        await ecp.sleep(250);
        present = hasBookmark(await readBookmarksRaw(), CONTENT_ID);
    }
    return present;
}

(async () => {
    let captionSnapshotTaken = false;
    let bookmarkSnapshotTaken = false;
    let initialCaptionMode: string | undefined;
    let initialBookmarksRaw: string | undefined;

    try {
        await launchVod(CONTENT_ID);

        group('caption fixture and user-state preconditions');
        const closedCaptions = await field<boolean>('#VideoPlayer.content.closedCaptions');
        const subtitleTracks = await field<unknown[]>('#VideoPlayer.content.subtitleTracks');
        if (closedCaptions !== true || !Array.isArray(subtitleTracks) || subtitleTracks.length === 0) {
            throw new Error(
                `caption fixture ${CONTENT_ID} did not expose usable tracks ` +
                `(closedCaptions=${JSON.stringify(closedCaptions)}, tracks=${JSON.stringify(subtitleTracks)})`,
            );
        }
        check('known caption fixture exposes at least one subtitle track', true, `${subtitleTracks.length} track(s)`);

        initialCaptionMode = await field<string>('#VideoPlayer.globalCaptionMode');
        if (typeof initialCaptionMode !== 'string') {
            throw new Error(`globalCaptionMode was not readable (got ${JSON.stringify(initialCaptionMode)})`);
        }
        captionSnapshotTaken = true;

        initialBookmarksRaw = await readBookmarksRaw();
        // Parse before any mutation so malformed persisted data fails safely without touching it.
        const initiallyBookmarked = hasBookmark(initialBookmarksRaw, CONTENT_ID);
        bookmarkSnapshotTaken = true;

        await expectField('#Chrome.opacity', 0, 7000);
        await revealChrome(); // hidden -> shown, trackbar focused
        await press(Key.Up); // trackbar -> play/pause on the button row
        await expectField('#buttonRow.rowFocused', true);
        await expectField('#buttonRow.focusedIndex', Button.playPause);

        await press(Key.Right); // skip disabled Next -> Playback settings
        await press(Key.Right); // Playback settings -> Captions
        await expectField('#buttonRow.focusedIndex', Button.captions);
        await expectField('#CaptionsButton.focused', true);
        await expectField('#buttonRow.captionsEnabled', initialCaptionMode !== 'Off');
        await expectField('#CaptionsButton.active', initialCaptionMode !== 'Off');

        group('Captions button toggles the inherited Roku caption mode');
        const toggledCaptionMode = initialCaptionMode === 'Off' ? 'On' : 'Off';
        await press(Key.Ok);
        await expectField('#VideoPlayer.globalCaptionMode', toggledCaptionMode);
        await expectField('#buttonRow.captionsEnabled', toggledCaptionMode !== 'Off');
        await expectField('#CaptionsButton.active', toggledCaptionMode !== 'Off');
        await expectField('#CaptionsButton.toggleState', toggledCaptionMode === 'Off');

        group('Bookmark button toggles both projected and persisted state');
        await press(Key.Right); // Captions -> Stats
        await press(Key.Right); // Stats -> Bookmark
        await expectField('#buttonRow.focusedIndex', Button.bookmark);
        await expectField('#BookmarkButton.focused', true);
        await expectField('#BookmarkButton.disabled', false);
        await expectField('#buttonRow.bookmarked', initiallyBookmarked);
        await expectField('#BookmarkButton.active', initiallyBookmarked);

        await press(Key.Ok);
        await expectField('#buttonRow.bookmarked', !initiallyBookmarked);
        await expectField('#BookmarkButton.active', !initiallyBookmarked);
        check('bookmark registry membership flips after activation', await waitForBookmark(!initiallyBookmarked));

        // Restore semantic membership through the user-facing button. If the original lived in a custom group,
        // this re-adds it to Videos; the finally block byte-restores the original group/order/feedSource JSON.
        await press(Key.Ok);
        await expectField('#buttonRow.bookmarked', initiallyBookmarked);
        await expectField('#BookmarkButton.active', initiallyBookmarked);
        const returned = await waitForBookmark(initiallyBookmarked);
        const freshBookmarksRaw = await readBookmarksRaw();
        check(
            'bookmark registry membership returns after second activation',
            returned === initiallyBookmarked || hasBookmark(freshBookmarksRaw, CONTENT_ID) === initiallyBookmarked,
            freshBookmarksRaw,
        );

        await expectPred('#VideoPlayer.state', (state) => state === 'playing', 'keeps playing through both feature toggles');
    } catch (error) {
        check('feature spec completed without an exception', false, error instanceof Error ? error.message : String(error));
    } finally {
        group('restore exact user state');

        if (captionSnapshotTaken) {
            try {
                await odc.setValue({
                    base: 'scene',
                    keyPath: '#VideoPlayer.globalCaptionMode',
                    value: initialCaptionMode,
                });
                const restoredCaptionMode = await field<string>('#VideoPlayer.globalCaptionMode');
                check('global caption mode restored exactly', restoredCaptionMode === initialCaptionMode, restoredCaptionMode);
            } catch (error) {
                check('global caption mode cleanup succeeded', false, error instanceof Error ? error.message : String(error));
            }
        }

        if (bookmarkSnapshotTaken) {
            try {
                await odc.writeRegistry({
                    values: {
                        Playlet: { bookmarks: initialBookmarksRaw ?? null },
                    },
                });
                const restoredBookmarksRaw = await readBookmarksRaw();
                check('bookmarks registry restored byte-for-byte', restoredBookmarksRaw === initialBookmarksRaw);
            } catch (error) {
                check('bookmarks registry cleanup succeeded', false, error instanceof Error ? error.message : String(error));
            }
        }
    }

    await finish();
})();
