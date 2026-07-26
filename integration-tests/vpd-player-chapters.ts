// Chapter-marker renderer e2e: inject deterministic chapter metadata into the real on-device
// VideoPlayerDev timeline, then prove marker count, preference gating, live suppression, and restoration.
// Parser normalization and metadata fallback are covered separately by ChapterMarkers.spec.bs.

import {
    Key,
    odc,
    press,
    revealChrome,
    launchVod,
    finish,
    group,
    expectField,
} from './vpd-player-harness';

const CONTENT_ID = 'aqz-KE-bpKQ'; // stable long-form VOD
const CHAPTERS = [
    { startMs: 0, title: 'Intro' },
    { startMs: 60_000, title: 'Main' },
    { startMs: 120_000, title: 'Wrap' },
];

(async () => {
    await launchVod(CONTENT_ID);
    await revealChrome();

    group('chapter metadata paints one divider per non-zero boundary');
    await odc.setValue({ base: 'scene', keyPath: '#trickPlayBar.showChapterMarkers', value: true });
    await odc.setValue({ base: 'scene', keyPath: '#trickPlayBar.chapters', value: CHAPTERS });
    await expectField('#chapterMarkers.getChildCount()', 2);
    await expectField('#chapterMarker1.width', 2);
    await expectField('#chapterMarker2.width', 2);

    group('the chapter-marker preference removes and restores the dividers');
    await odc.setValue({ base: 'scene', keyPath: '#trickPlayBar.showChapterMarkers', value: false });
    await expectField('#chapterMarkers.getChildCount()', 0);
    await odc.setValue({ base: 'scene', keyPath: '#trickPlayBar.showChapterMarkers', value: true });
    await expectField('#chapterMarkers.getChildCount()', 2);

    group('live timelines suppress VOD chapter dividers');
    await odc.setValue({ base: 'scene', keyPath: '#trickPlayBar.isLive', value: true });
    await expectField('#chapterMarkers.getChildCount()', 0);
    await odc.setValue({ base: 'scene', keyPath: '#trickPlayBar.isLive', value: false });
    await expectField('#chapterMarkers.getChildCount()', 2);

    // Return the real player projection to its natural state before leaving the content.
    await press(Key.Back);
    await finish();
})();
