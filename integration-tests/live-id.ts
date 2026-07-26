// Find a CURRENTLY-LIVE YouTube video id via youtubei.js (Innertube.search), so the live e2e spec doesn't depend
// on a single hardcoded stream that can go offline. Cached to tmp/ for ~15 min (one test session) so repeated
// runs don't re-search. Returns undefined on any failure — the caller falls back to a hardcoded id, then skips.
import { Innertube } from 'youtubei.js';
import * as fs from 'fs';

const CACHE = `${__dirname}/../tmp/live-id.cache`;
const REJECTED_CACHE = `${__dirname}/../tmp/live-id.rejected`;
const TTL_MS = 15 * 60 * 1000;
const REJECTED_TTL_MS = 24 * 60 * 60 * 1000;

function rejectedIds(): Set<string> {
    try {
        if (Date.now() - fs.statSync(REJECTED_CACHE).mtimeMs >= REJECTED_TTL_MS) return new Set();
        return new Set(fs.readFileSync(REJECTED_CACHE, 'utf8').split(/\s+/).filter(Boolean));
    } catch {
        return new Set();
    }
}

export function rejectLiveVideoId(id: string): void {
    if (!id) return;
    const rejected = rejectedIds();
    rejected.add(id);
    try {
        fs.mkdirSync(`${__dirname}/../tmp`, { recursive: true });
        fs.writeFileSync(REJECTED_CACHE, [...rejected].join('\n'));
        if (fs.existsSync(CACHE) && fs.readFileSync(CACHE, 'utf8').trim() === id) fs.unlinkSync(CACHE);
    } catch {
        /* a cache failure must never fail the integration spec */
    }
}

export async function getLiveVideoId(query = 'lofi hip hop radio'): Promise<string | undefined> {
    const rejected = rejectedIds();
    // session cache (by file mtime): a live id stays valid for a while; re-search past the TTL.
    try {
        if (Date.now() - fs.statSync(CACHE).mtimeMs < TTL_MS) {
            const cached = fs.readFileSync(CACHE, 'utf8').trim();
            if (cached && !rejected.has(cached)) { console.log(`live-id: using cached ${cached}`); return cached; }
        }
    } catch { /* no/stale cache */ }

    try {
        const yt = await Innertube.create({ retrieve_player: false });
        // SOURCE-side filter: features:['live'] asks YouTube for live videos only (don't rely on post-filtering a
        // general search, which could return a VOD titled like a live stream). is_live below is belt-and-suspenders.
        const search = await yt.search(query, { type: 'video', features: ['live'] });
        const items: any[] = (search as any).videos ?? (search as any).results ?? [];
        const isLive = (v: any) =>
            v?.is_live === true ||
            v?.is_live_content === true ||
            (Array.isArray(v?.badges) && v.badges.some((b: any) => /live/i.test(b?.label ?? b?.style ?? '')));
        const cand = items.filter((v) => v && (v.id || v.video_id) && !rejected.has(v.id ?? v.video_id));
        const pick = cand.find(isLive) ?? cand[0];
        const id: string | undefined = pick?.id ?? pick?.video_id;
        if (id) {
            try { fs.mkdirSync(`${__dirname}/../tmp`, { recursive: true }); fs.writeFileSync(CACHE, id); } catch { /* */ }
            const title = pick?.title?.text ?? pick?.title ?? '';
            console.log(`live-id: found ${id} live=${isLive(pick)} "${title}"`);
            return id;
        }
        console.log('live-id: search returned no usable video');
    } catch (e) {
        console.log(`live-id: search failed (${e}) — caller will fall back`);
    }
    return undefined;
}
