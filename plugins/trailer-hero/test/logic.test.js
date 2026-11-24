'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const t = require('../trailer-hero.js');

const item = (id, extra) => Object.assign({ Id: id, Type: 'Movie', BackdropImageTags: ['b'], LocalTrailerCount: 0 }, extra);
const source = (container, codec, extra) => Object.assign({
    Id: 'ms1', Container: container, RunTimeTicks: 1200 * 1e7,
    MediaStreams: [{ Type: 'Video', Codec: codec, Width: 1280, BitDepth: 8 }]
}, extra);
const yes = () => 'probably';
const no = () => '';

test('selectSlides: trailers first, dedupe, backdrop and type required, capped', () => {
    const withT = [item('a', { LocalTrailerCount: 1 }), item('b', { LocalTrailerCount: 0 }), item('c', { BackdropImageTags: [], LocalTrailerCount: 2 })];
    const recent = [item('b'), item('d', { Type: 'Episode' }), item('e', { LocalTrailerCount: 1 }), item('f')];
    const out = t.selectSlides(withT, recent, 3, ['Movie', 'Series']).map((i) => i.Id);
    assert.deepEqual(out, ['a', 'e', 'b']);
});

test('selectSlides: empty and bad input', () => {
    assert.deepEqual(t.selectSlides(undefined, null, 5, ['Movie']), []);
    assert.deepEqual(t.selectSlides([item('a')], [], 0, ['Movie']), []);
    assert.deepEqual(t.selectSlides([null, {}], [], 5, ['Movie']), []);
});

test('isDirectPlayable: container, codec, bit depth, width', () => {
    assert.equal(t.isDirectPlayable(source('mp4', 'h264'), yes, 1920), true);
    assert.equal(t.isDirectPlayable(source('mp4', 'h264'), no, 1920), false);
    assert.equal(t.isDirectPlayable(source('avi', 'h264'), yes, 1920), false);
    assert.equal(t.isDirectPlayable(source('mp4', 'mpeg2video'), yes, 1920), false);
    assert.equal(t.isDirectPlayable(source('mp4', 'h264', { MediaStreams: [{ Type: 'Video', Codec: 'h264', BitDepth: 10 }] }), yes, 1920), false);
    assert.equal(t.isDirectPlayable(source('mp4', 'h264', { MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 3840 }] }), yes, 1920), false);
    assert.equal(t.isDirectPlayable(source('webm', 'vp9'), yes, 1920), true);
    assert.equal(t.isDirectPlayable(null, yes, 1920), false);
    assert.equal(t.isDirectPlayable(source('mp4', 'h264'), undefined, 1920), false);
});

test('isDirectPlayable asks the browser with the right mime', () => {
    let asked = '';
    t.isDirectPlayable(source('mkv', 'hevc'), (m) => { asked = m; return 'maybe'; }, 1920);
    assert.equal(asked, 'video/x-matroska; codecs="hvc1.1.6.L120.B0"');
});

test('pickTrailer: first playable wins, none gives null (backdrop fallback)', () => {
    const trailers = [
        { Id: 't1', MediaSources: [source('avi', 'h264')] },
        { Id: 't2', MediaSources: [source('mp4', 'h264', { Id: 'ms2' })] }
    ];
    assert.deepEqual(t.pickTrailer(trailers, yes, 1920), { id: 't2', mediaSourceId: 'ms2', durationSec: 1200 });
    assert.equal(t.pickTrailer(trailers, no, 1920), null);
    assert.equal(t.pickTrailer([], yes, 1920), null);
    assert.equal(t.pickTrailer(undefined, yes, 1920), null);
    assert.equal(t.pickTrailer([{ Id: 'x' }], yes, 1920), null);
});

test('playWindow: starts a few seconds in, short clips from zero, capped length', () => {
    assert.deepEqual(t.playWindow(150, 4, 20), { start: 4, length: 20 });
    assert.deepEqual(t.playWindow(10, 4, 20), { start: 0, length: 10 });
    assert.deepEqual(t.playWindow(0, 4, 20), { start: 4, length: 20 });
    assert.deepEqual(t.playWindow(16, 4, 20), { start: 4, length: 12 });
});

test('videoGate: reduced motion, save data and hidden tab block video', () => {
    assert.deepEqual(t.videoGate({}), { allowed: true, reason: '' });
    assert.equal(t.videoGate({ reducedMotion: true }).reason, 'reduced-motion');
    assert.equal(t.videoGate({ saveData: true }).reason, 'save-data');
    assert.equal(t.videoGate({ hidden: true }).allowed, false);
    assert.equal(t.videoGate({ reducedMotion: true, saveData: true }).reason, 'reduced-motion');
});

test('isSameOrigin refuses other origins and garbage', () => {
    assert.equal(t.isSameOrigin('', 'https://media.example'), true);
    assert.equal(t.isSameOrigin('https://media.example/jf', 'https://media.example'), true);
    assert.equal(t.isSameOrigin('https://cdn.example', 'https://media.example'), false);
    assert.equal(t.isSameOrigin('http://media.example', 'https://media.example'), false);
    assert.equal(t.isSameOrigin('http://[bad', 'https://media.example'), false);
});

test('URL builders target the documented routes and encode values', () => {
    assert.equal(
        t.buildStreamUrl({ address: 'https://h/', id: 'i d', mediaSourceId: 'm', token: 'k&1', startSec: 4 }),
        'https://h/Videos/i%20d/stream?static=true&mediaSourceId=m&ApiKey=k%261#t=4'
    );
    assert.equal(t.buildStreamUrl({ address: '', id: 'i', mediaSourceId: 'm', token: 'k', startSec: 0 }), '/Videos/i/stream?static=true&mediaSourceId=m&ApiKey=k');
    assert.equal(t.buildTrailersUrl({ address: '', id: 'i', userId: 'u' }), '/Items/i/LocalTrailers?userId=u');
    assert.equal(t.buildImageUrl({ address: '', id: 'i', type: 'Backdrop', index: 0, maxWidth: 1920, tag: 'x' }), '/Items/i/Images/Backdrop/0?maxWidth=1920&quality=80&tag=x');
    assert.equal(t.buildPlayUrl({ address: '', sessionId: 's', id: 'i' }), '/Sessions/s/Playing?playCommand=PlayNow&itemIds=i');
    const items = t.buildItemsUrl({ address: '', userId: 'u', types: ['Movie', 'Series'], limit: 20, sortBy: 'Random', hasTrailer: true });
    assert.match(items, /^\/Items\?userId=u&IncludeItemTypes=Movie%2CSeries&Recursive=true&Fields=Overview%2CLocalTrailerCount/);
    assert.match(items, /HasTrailer=true/);
    assert.doesNotMatch(t.buildItemsUrl({ address: '', userId: 'u', types: ['Movie'], limit: 1, sortBy: 'DateCreated' }), /HasTrailer/);
});

test('nextIndex wraps both ways and survives empty', () => {
    assert.equal(t.nextIndex(2, 3, 1), 0);
    assert.equal(t.nextIndex(0, 3, -1), 2);
    assert.equal(t.nextIndex(0, 0, 1), 0);
});

test('metaParts and runtime', () => {
    assert.equal(t.formatRuntime(112 * 6e8), '1h 52m');
    assert.equal(t.formatRuntime(0), '');
    const parts = t.metaParts({ Type: 'Movie', ProductionYear: 2021, CommunityRating: 7.84, RunTimeTicks: 95 * 6e8, OfficialRating: 'PG-13' });
    assert.deepEqual(parts.map((p) => p.text), ['2021', '★ 7.8', '1h 35m', 'PG-13']);
    assert.equal(parts[3].kind, 'badge');
    assert.deepEqual(t.metaParts({ Type: 'Series' }).map((p) => p.text), ['Series']);
});

test('mergeConfig keeps defaults and overrides', () => {
    const c = t.mergeConfig({ maxSlides: 3, labels: { play: 'Lecture' } });
    assert.equal(c.maxSlides, 3);
    assert.equal(c.labels.play, 'Lecture');
    assert.equal(c.labels.info, 'More info');
    assert.equal(t.mergeConfig().maxSlides, 6);
});

function memoryStorage(initial) {
    const data = Object.assign({}, initial);
    return {
        getItem: (k) => (k in data ? data[k] : null),
        setItem: (k, v) => { data[k] = String(v); }
    };
}
const blockedStorage = {
    getItem() { throw new Error('SecurityError'); },
    setItem() { throw new Error('QuotaExceededError'); }
};

test('sound: first use is muted (no saved preference)', () => {
    assert.equal(t.readSoundPref(memoryStorage()), false);
    assert.equal(t.restorePlan({ allowed: true, saved: false, gestured: true }), 'none');
});

test('sound: saved preference round trip under the namespaced key', () => {
    const store = memoryStorage();
    assert.equal(t.SOUND_KEY, 'trailer-hero:sound');
    assert.equal(t.writeSoundPref(store, true), true);
    assert.equal(store.getItem(t.SOUND_KEY), 'on');
    assert.equal(t.readSoundPref(store), true);
    t.writeSoundPref(store, false);
    assert.equal(t.readSoundPref(store), false);
});

test('sound: any value but "on" counts as muted', () => {
    for (const v of ['true', '1', 'ON', '', 'off']) {
        assert.equal(t.readSoundPref(memoryStorage({ [t.SOUND_KEY]: v })), false, v);
    }
});

test('sound: blocked or missing storage never throws and stays muted', () => {
    assert.equal(t.readSoundPref(blockedStorage), false);
    assert.equal(t.writeSoundPref(blockedStorage, true), false);
    assert.equal(t.readSoundPref(null), false);
    assert.equal(t.writeSoundPref(null, true), false);
});

test('sound: a saved "on" waits for a gesture, then restores', () => {
    assert.equal(t.restorePlan({ allowed: true, saved: true, gestured: false }), 'wait');
    assert.equal(t.restorePlan({ allowed: true, saved: true, gestured: true }), 'restore');
});

test('sound: forced mute (config or script tag) overrides everything', () => {
    assert.equal(t.soundAllowed({ allowSound: false }, ''), false);
    assert.equal(t.soundAllowed({}, 'off'), false);
    assert.equal(t.soundAllowed({}, 'OFF'), false);
    assert.equal(t.soundAllowed({ allowSound: true }, null), true);
    assert.equal(t.soundAllowed(t.mergeConfig(undefined), undefined), true);
    assert.equal(t.restorePlan({ allowed: false, saved: true, gestured: true }), 'none');
});

test('sound: defaults and labels', () => {
    const cfg = t.mergeConfig({ labels: { mute: 'Quiet' } });
    assert.equal(cfg.allowSound, true);
    assert.equal(cfg.soundVolume, 0.5);
    assert.equal(t.soundLabel(cfg.labels, true), 'Quiet');
    assert.equal(t.soundLabel(cfg.labels, false), 'Unmute trailer sound');
});

test('sound: fade-in is linear and clamped', () => {
    assert.equal(t.volumeAt(0, 400, 0.5), 0);
    assert.equal(t.volumeAt(200, 400, 0.5), 0.25);
    assert.equal(t.volumeAt(400, 400, 0.5), 0.5);
    assert.equal(t.volumeAt(9999, 400, 0.5), 0.5);
    assert.equal(t.volumeAt(-5, 400, 0.5), 0);
    assert.equal(t.volumeAt(10, 0, 0.5), 0.5);
});
