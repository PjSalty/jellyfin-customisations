/*!
 * Trailer Hero for the Jellyfin web client. MIT licence, see LICENSE.
 * Plain ES2019, no dependencies, no build step. Talks only to the same-origin
 * Jellyfin API through the client's own window.ApiClient session.
 */
(function () {
    'use strict';

    var DEFAULTS = {
        maxSlides: 6,
        rotateMs: 12000,
        videoDelayMs: 1800,
        startSeconds: 4,
        maxPlaySeconds: 20,
        maxVideoWidth: 1920,
        includeTypes: ['Movie', 'Series'],
        allowSound: true,
        soundVolume: 0.5,
        soundFadeMs: 400,
        labels: {
            play: 'Play', info: 'More info', next: 'Next title', prev: 'Previous title',
            mute: 'Mute trailer sound', unmute: 'Unmute trailer sound'
        }
    };

    // Per-device preference. The value is 'on' only after the person unmuted.
    var SOUND_KEY = 'trailer-hero:sound';

    /* ---------------------------------------------------------------- */
    /* Pure logic. Exported for the Node tests; no DOM access in here.   */
    /* ---------------------------------------------------------------- */

    var CODECS = {
        h264: 'avc1.640028',
        avc: 'avc1.640028',
        hevc: 'hvc1.1.6.L120.B0',
        h265: 'hvc1.1.6.L120.B0',
        vp8: 'vp8',
        vp9: 'vp09.00.10.08',
        av1: 'av01.0.05M.08'
    };

    function mergeConfig(user) {
        var out = {};
        var key;
        for (key in DEFAULTS) {
            if (Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
                out[key] = DEFAULTS[key];
            }
        }
        if (user && typeof user === 'object') {
            for (key in user) {
                if (Object.prototype.hasOwnProperty.call(user, key) && key !== 'labels') {
                    out[key] = user[key];
                }
            }
            out.labels = Object.assign({}, DEFAULTS.labels, user.labels || {});
        } else {
            out.labels = Object.assign({}, DEFAULTS.labels);
        }
        return out;
    }

    /** Decides whether any video may play. env: reducedMotion, saveData, hidden. */
    function videoGate(env) {
        if (env.reducedMotion) return { allowed: false, reason: 'reduced-motion' };
        if (env.saveData) return { allowed: false, reason: 'save-data' };
        if (env.hidden) return { allowed: false, reason: 'hidden' };
        return { allowed: true, reason: '' };
    }

    /** The saved "sound on" preference. Anything but 'on', or a blocked storage, means muted. */
    function readSoundPref(storage) {
        try {
            return !!storage && storage.getItem(SOUND_KEY) === 'on';
        } catch (e) {
            return false;
        }
    }

    /** Saves the preference; false when the storage refuses (private mode, blocked). */
    function writeSoundPref(storage, on) {
        try {
            if (!storage) return false;
            storage.setItem(SOUND_KEY, on ? 'on' : 'off');
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Whether an admin left sound possible: off when the config says
     * allowSound: false or the script tag carries data-sound="off".
     */
    function soundAllowed(cfg, tagValue) {
        if (cfg && cfg.allowSound === false) return false;
        return String(tagValue || '').toLowerCase() !== 'off';
    }

    /**
     * What to do with the saved preference. The first state is always muted;
     * the browser's autoplay policy only lets sound start after a user gesture.
     * Returns 'none' (no sound possible or wanted), 'wait' (wanted, no gesture
     * yet) or 'restore' (wanted and a gesture happened).
     */
    function restorePlan(o) {
        if (!o.allowed || !o.saved) return 'none';
        return o.gestured ? 'restore' : 'wait';
    }

    /** Volume after elapsedMs of a linear fade-in to target over durationMs. */
    function volumeAt(elapsedMs, durationMs, target) {
        if (!(durationMs > 0) || elapsedMs >= durationMs) return target;
        if (elapsedMs <= 0) return 0;
        return target * (elapsedMs / durationMs);
    }

    function soundLabel(labels, soundOn) {
        return soundOn ? labels.mute : labels.unmute;
    }

    function hasBackdrop(item) {
        return !!item && Array.isArray(item.BackdropImageTags) && item.BackdropImageTags.length > 0;
    }

    /**
     * Merges the "has a trailer" candidates and the "recent" candidates into
     * at most max slides: only the wanted types, only with a backdrop, no
     * duplicates, and items whose own LocalTrailerCount is above zero first.
     */
    function selectSlides(withTrailer, recent, max, types) {
        var seen = {};
        var withVideo = [];
        var stills = [];
        var all = (withTrailer || []).concat(recent || []);
        var i;
        for (i = 0; i < all.length; i++) {
            var item = all[i];
            if (!item || !item.Id || seen[item.Id]) continue;
            if (types.indexOf(item.Type) === -1 || !hasBackdrop(item)) continue;
            seen[item.Id] = true;
            if (item.LocalTrailerCount > 0) withVideo.push(item);
            else stills.push(item);
        }
        return withVideo.concat(stills).slice(0, Math.max(0, max));
    }

    function containerMime(container) {
        var c = String(container || '').toLowerCase().split(',')[0];
        if (c === 'mp4' || c === 'm4v' || c === 'mov') return 'video/mp4';
        if (c === 'webm') return 'video/webm';
        if (c === 'mkv' || c === 'matroska') return 'video/x-matroska';
        return '';
    }

    function videoStreamOf(source) {
        var streams = (source && source.MediaStreams) || [];
        for (var i = 0; i < streams.length; i++) {
            if (streams[i].Type === 'Video') return streams[i];
        }
        return null;
    }

    /** True when the browser can play this media source as is. */
    function isDirectPlayable(source, canPlayType, maxWidth) {
        if (!source || typeof canPlayType !== 'function') return false;
        var base = containerMime(source.Container);
        var video = videoStreamOf(source);
        if (!base || !video || !video.Codec) return false;
        var codec = CODECS[String(video.Codec).toLowerCase()];
        if (!codec) return false;
        if (video.BitDepth && video.BitDepth > 8 && String(video.Codec).toLowerCase() === 'h264') return false;
        if (video.Width && video.Width > maxWidth) return false;
        var answer = canPlayType(base + '; codecs="' + codec + '"');
        return answer === 'probably' || answer === 'maybe';
    }

    /** First directly playable trailer, or null (the slide then shows its backdrop). */
    function pickTrailer(trailers, canPlayType, maxWidth) {
        var list = Array.isArray(trailers) ? trailers : [];
        for (var i = 0; i < list.length; i++) {
            var sources = list[i].MediaSources || [];
            for (var j = 0; j < sources.length; j++) {
                if (isDirectPlayable(sources[j], canPlayType, maxWidth)) {
                    return {
                        id: list[i].Id,
                        mediaSourceId: sources[j].Id,
                        durationSec: sources[j].RunTimeTicks ? sources[j].RunTimeTicks / 1e7 : 0
                    };
                }
            }
        }
        return null;
    }

    /** Where in the trailer to start, and how long the visible window is. */
    function playWindow(durationSec, startSeconds, maxPlaySeconds) {
        var start = startSeconds;
        if (durationSec > 0 && durationSec < startSeconds * 3) start = 0;
        var room = durationSec > 0 ? Math.max(0, durationSec - start) : maxPlaySeconds;
        return { start: start, length: Math.min(maxPlaySeconds, room) };
    }

    function isSameOrigin(address, pageOrigin) {
        try {
            return new URL(address || '', pageOrigin + '/').origin === pageOrigin;
        } catch (e) {
            return false;
        }
    }

    function joinUrl(address, path) {
        return String(address || '').replace(/\/+$/, '') + '/' + path;
    }

    function query(params) {
        var parts = [];
        Object.keys(params).forEach(function (key) {
            var v = params[key];
            if (v === undefined || v === null || v === '') return;
            parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
        });
        return parts.join('&');
    }

    function buildStreamUrl(o) {
        return joinUrl(o.address, 'Videos/' + encodeURIComponent(o.id) + '/stream') + '?' + query({
            static: 'true',
            mediaSourceId: o.mediaSourceId,
            ApiKey: o.token
        }) + (o.startSec > 0 ? '#t=' + o.startSec : '');
    }

    function buildImageUrl(o) {
        return joinUrl(o.address, 'Items/' + encodeURIComponent(o.id) + '/Images/' + o.type + (o.index === undefined ? '' : '/' + o.index)) +
            '?' + query({ maxWidth: o.maxWidth, quality: o.quality || 80, tag: o.tag });
    }

    function buildItemsUrl(o) {
        var p = {
            userId: o.userId,
            IncludeItemTypes: o.types.join(','),
            Recursive: 'true',
            Fields: 'Overview,LocalTrailerCount',
            EnableImageTypes: 'Backdrop,Logo',
            ImageTypeLimit: 1,
            Limit: o.limit,
            SortBy: o.sortBy,
            SortOrder: o.sortOrder
        };
        if (o.hasTrailer) p.HasTrailer = 'true';
        return joinUrl(o.address, 'Items') + '?' + query(p);
    }

    function buildTrailersUrl(o) {
        return joinUrl(o.address, 'Items/' + encodeURIComponent(o.id) + '/LocalTrailers') + '?' + query({ userId: o.userId });
    }

    function buildPlayUrl(o) {
        return joinUrl(o.address, 'Sessions/' + encodeURIComponent(o.sessionId) + '/Playing') + '?' +
            query({ playCommand: 'PlayNow', itemIds: o.id });
    }

    function detailsRoute(item, serverId) {
        return 'details?id=' + encodeURIComponent(item.Id) + '&serverId=' + encodeURIComponent(serverId || item.ServerId || '');
    }

    function nextIndex(i, n, step) {
        if (n <= 0) return 0;
        return (((i + step) % n) + n) % n;
    }

    function formatRuntime(ticks) {
        var minutes = Math.round((ticks || 0) / 6e8);
        if (minutes <= 0) return '';
        var h = Math.floor(minutes / 60);
        var m = minutes % 60;
        return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
    }

    /** The small meta line: year, rating badge, community score, runtime. */
    function metaParts(item) {
        var out = [];
        if (item.ProductionYear) out.push({ kind: 'text', text: String(item.ProductionYear) });
        if (item.CommunityRating) out.push({ kind: 'text', text: '★ ' + (Math.round(item.CommunityRating * 10) / 10).toFixed(1) });
        if (item.Type === 'Movie') {
            var run = formatRuntime(item.RunTimeTicks);
            if (run) out.push({ kind: 'text', text: run });
        } else {
            out.push({ kind: 'text', text: 'Series' });
        }
        if (item.OfficialRating) out.push({ kind: 'badge', text: item.OfficialRating });
        return out;
    }

    var logic = {
        DEFAULTS: DEFAULTS,
        mergeConfig: mergeConfig,
        videoGate: videoGate,
        SOUND_KEY: SOUND_KEY,
        readSoundPref: readSoundPref,
        writeSoundPref: writeSoundPref,
        soundAllowed: soundAllowed,
        restorePlan: restorePlan,
        volumeAt: volumeAt,
        soundLabel: soundLabel,
        selectSlides: selectSlides,
        containerMime: containerMime,
        isDirectPlayable: isDirectPlayable,
        pickTrailer: pickTrailer,
        playWindow: playWindow,
        isSameOrigin: isSameOrigin,
        buildStreamUrl: buildStreamUrl,
        buildImageUrl: buildImageUrl,
        buildItemsUrl: buildItemsUrl,
        buildTrailersUrl: buildTrailersUrl,
        buildPlayUrl: buildPlayUrl,
        detailsRoute: detailsRoute,
        nextIndex: nextIndex,
        formatRuntime: formatRuntime,
        metaParts: metaParts
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = logic;
        return;
    }
    if (typeof window === 'undefined' || window.TrailerHero) return;

    /* ---------------------------------------------------------------- */
    /* Browser part: one hero on the home page, one reused <video>.      */
    /* ---------------------------------------------------------------- */

    var win = window;
    var doc = document;
    var config = mergeConfig(win.TrailerHeroConfig);
    // Captured while the script runs; null when it was not loaded from a tag.
    var scriptTag = doc.currentScript;
    var canSound = soundAllowed(config, scriptTag && scriptTag.getAttribute('data-sound'));
    var gestured = false; // a user gesture happened on this page load
    var SVG_NS = 'http://www.w3.org/2000/svg';
    var state = null; // the mounted hero, or null
    var generation = 0; // bumps on every mount/unmount so stale async work stops

    function el(tag, className, text) {
        var node = doc.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function api() {
        var client = win.ApiClient;
        if (!client || typeof client.getCurrentUserId !== 'function' || !client.getCurrentUserId()) return null;
        if (!isSameOrigin(client.serverAddress(), win.location.origin)) return null;
        return client;
    }

    function getJson(client, url) {
        if (typeof client.getJSON === 'function') return client.getJSON(url);
        return client.ajax({ type: 'GET', url: url, dataType: 'json' });
    }

    function environment() {
        var mq = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
        var conn = win.navigator && win.navigator.connection;
        return {
            reducedMotion: !!(mq && mq.matches),
            saveData: !!(conn && conn.saveData),
            hidden: !!doc.hidden
        };
    }

    function clearTimers(s) {
        win.clearTimeout(s.rotateTimer);
        win.clearTimeout(s.videoTimer);
        s.rotateTimer = 0;
        s.videoTimer = 0;
    }

    function localStore() {
        try {
            return win.localStorage;
        } catch (e) {
            return null;
        }
    }

    function clearFade(s) {
        win.clearTimeout(s.fadeTimer);
        s.fadeTimer = 0;
    }

    function stopVideo(s) {
        win.clearTimeout(s.videoTimer);
        s.videoTimer = 0;
        clearFade(s);
        s.video.muted = true;
        s.video.pause();
        s.video.classList.remove('is-playing');
        if (s.video.getAttribute('src')) {
            s.video.removeAttribute('src');
            s.video.load();
        }
    }

    function otherVideoPlaying(s) {
        var vids = doc.getElementsByTagName('video');
        for (var i = 0; i < vids.length; i++) {
            if (vids[i] !== s.video && !vids[i].paused && !vids[i].ended) return true;
        }
        return false;
    }

    function svgNode(tag, attrs) {
        var node = doc.createElementNS(SVG_NS, tag);
        Object.keys(attrs).forEach(function (k) { node.setAttribute(k, attrs[k]); });
        return node;
    }

    /** A speaker icon built with DOM methods; the "on" waves or the "off" cross show by state. */
    function buildSoundIcon() {
        var svg = svgNode('svg', { viewBox: '0 0 24 24', width: '24', height: '24', 'aria-hidden': 'true', focusable: 'false' });
        svg.setAttribute('class', 'trailer-hero__icon');
        svg.appendChild(svgNode('path', { d: 'M3 9v6h4l5 4V5L7 9H3z', fill: 'currentColor' }));
        var attrs = { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round' };
        var waves = svgNode('path', Object.assign({ d: 'M16 8.5a5 5 0 0 1 0 7M18.6 5.8a9 9 0 0 1 0 12.4' }, attrs));
        waves.setAttribute('class', 'trailer-hero__icon-on');
        var cross = svgNode('path', Object.assign({ d: 'M16 9.5l5 5M21 9.5l-5 5' }, attrs));
        cross.setAttribute('class', 'trailer-hero__icon-off');
        svg.appendChild(waves);
        svg.appendChild(cross);
        return svg;
    }

    function updateToggle(s) {
        if (!s.toggle) return;
        s.toggle.setAttribute('aria-pressed', s.soundOn ? 'true' : 'false');
        s.toggle.setAttribute('aria-label', soundLabel(config.labels, s.soundOn));
        s.toggle.classList.toggle('is-on', s.soundOn);
    }

    function setSoundOn(s, on) {
        s.soundOn = on;
        updateToggle(s);
    }

    /**
     * Unmutes the playing trailer with a short fade-in. The browser's autoplay
     * policy refuses sound without a user gesture; Chromium then pauses the
     * element or rejects play(). Either way the hero goes back to muted and
     * plays on, and never throws or stalls.
     * Policy: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay
     * and https://developer.chrome.com/blog/autoplay (checked 2026-11-24).
     */
    function applySound(s) {
        var v = s.video;
        if (!s.soundOn || !gestured || !v.getAttribute('src') || !v.muted) return;
        clearFade(s);
        v.volume = 0;
        v.muted = false;
        var begun = Date.now();
        var step = function () {
            if (state !== s || v.muted) return;
            v.volume = Math.min(1, Math.max(0, volumeAt(Date.now() - begun, config.soundFadeMs, config.soundVolume)));
            if (Date.now() - begun < config.soundFadeMs) s.fadeTimer = win.setTimeout(step, 50);
        };
        step();
        var played = v.play();
        if (played && typeof played.catch === 'function') {
            played.catch(function () { soundRefused(s); });
        }
    }

    function soundRefused(s) {
        if (state !== s) return;
        clearFade(s);
        s.video.muted = true;
        setSoundOn(s, false);
        var again = s.video.play();
        if (again && typeof again.catch === 'function') again.catch(function () { stopVideo(s); });
    }

    function toggleSound(s) {
        var on = !s.soundOn;
        s.pref = on;
        writeSoundPref(localStore(), on);
        setSoundOn(s, on);
        if (on) {
            gestured = true; // this click is the gesture
            applySound(s);
        } else {
            clearFade(s);
            s.video.muted = true;
        }
    }

    /** The first gesture on the page restores a saved "sound on" preference. */
    function onFirstGesture(event) {
        if (gestured) return;
        gestured = true;
        ['pointerup', 'keydown', 'touchend', 'click'].forEach(function (type) {
            doc.removeEventListener(type, onFirstGesture, true);
        });
        var s = state;
        if (!s || !s.toggle || s.toggle.contains(event.target)) return;
        if (restorePlan({ allowed: canSound, saved: s.pref, gestured: true }) === 'restore' && !s.soundOn) {
            setSoundOn(s, true);
            applySound(s);
        }
    }

    function unmount() {
        generation++;
        if (!state) return;
        var s = state;
        state = null;
        clearTimers(s);
        stopVideo(s);
        if (s.io) s.io.disconnect();
        s.cleanups.forEach(function (fn) { fn(); });
        if (s.root.parentNode) s.root.parentNode.removeChild(s.root);
    }

    function scheduleRotate(s, ms) {
        win.clearTimeout(s.rotateTimer);
        s.rotateTimer = win.setTimeout(function () { tick(s); }, ms);
    }

    function tick(s) {
        if (state !== s) return;
        if (!s.root.isConnected) { unmount(); return; }
        if (s.slides.length < 2 || s.held || !s.visible || doc.hidden) {
            scheduleRotate(s, 1000);
            return;
        }
        show(s, nextIndex(s.index, s.slides.length, 1));
    }

    function renderContent(s, item) {
        var c = s.content;
        while (c.firstChild) c.removeChild(c.firstChild);
        var client = api();
        var address = client ? client.serverAddress() : '';
        var logoTag = item.ImageTags && item.ImageTags.Logo;
        var title = el('h2', 'trailer-hero__title' + (logoTag ? ' has-logo' : ''));
        if (logoTag) {
            var logo = el('img', 'trailer-hero__logo');
            logo.alt = '';
            logo.src = buildImageUrl({ address: address, id: item.Id, type: 'Logo', maxWidth: 640, tag: logoTag });
            title.appendChild(logo);
        }
        title.appendChild(el('span', 'trailer-hero__name', item.Name || ''));
        c.appendChild(title);

        var meta = el('div', 'trailer-hero__meta');
        metaParts(item).forEach(function (part) {
            meta.appendChild(el('span', part.kind === 'badge' ? 'trailer-hero__badge' : '', part.text));
        });
        c.appendChild(meta);
        if (item.Overview) c.appendChild(el('p', 'trailer-hero__overview', item.Overview));

        var buttons = el('div', 'trailer-hero__buttons');
        var play = el('button', 'trailer-hero__btn trailer-hero__btn--primary', config.labels.play);
        play.type = 'button';
        play.addEventListener('click', function () { playItem(item); });
        var info = el('button', 'trailer-hero__btn trailer-hero__btn--secondary', config.labels.info);
        info.type = 'button';
        info.addEventListener('click', function () { openDetails(item); });
        buttons.appendChild(play);
        buttons.appendChild(info);
        c.appendChild(buttons);
    }

    function openDetails(item) {
        var client = win.ApiClient;
        var route = detailsRoute(item, client && client.serverId ? client.serverId() : '');
        if (win.Dashboard && typeof win.Dashboard.navigate === 'function') win.Dashboard.navigate(route);
        else win.location.hash = '#/' + route;
    }

    /** Plays through the client's own session; falls back to the details page. */
    function playItem(item) {
        var client = api();
        if (!client || typeof client.deviceId !== 'function') { openDetails(item); return; }
        var address = client.serverAddress();
        getJson(client, joinUrl(address, 'Sessions') + '?' + query({ deviceId: client.deviceId() }))
            .then(function (sessions) {
                if (!sessions || !sessions.length) throw new Error('no session');
                return client.ajax({
                    type: 'POST',
                    url: buildPlayUrl({ address: address, sessionId: sessions[0].Id, id: item.Id })
                });
            })
            .catch(function () { openDetails(item); });
    }

    function setBackdrop(s, item) {
        var client = api();
        if (!client) return;
        var url = buildImageUrl({
            address: client.serverAddress(), id: item.Id, type: 'Backdrop', index: 0,
            maxWidth: 1920, tag: item.BackdropImageTags[0]
        });
        var incoming = s.layers[s.layerIndex ^ 1];
        var outgoing = s.layers[s.layerIndex];
        incoming.style.backgroundImage = 'url("' + url + '")';
        incoming.classList.add('is-active');
        outgoing.classList.remove('is-active');
        s.layerIndex ^= 1;
    }

    function preloadNext(s) {
        var client = api();
        if (!client || s.slides.length < 2) return;
        var next = s.slides[nextIndex(s.index, s.slides.length, 1)];
        var img = new win.Image();
        img.src = buildImageUrl({
            address: client.serverAddress(), id: next.Id, type: 'Backdrop', index: 0,
            maxWidth: 1920, tag: next.BackdropImageTags[0]
        });
    }

    function show(s, index) {
        if (state !== s) return;
        stopVideo(s);
        win.clearTimeout(s.rotateTimer);
        s.index = index;
        var item = s.slides[index];
        s.dots.forEach(function (dot, i) { dot.classList.toggle('is-active', i === index); });
        s.content.classList.remove('is-visible');
        setBackdrop(s, item);
        renderContent(s, item);
        win.requestAnimationFrame(function () { s.content.classList.add('is-visible'); });
        scheduleRotate(s, config.rotateMs);
        preloadNext(s);
        scheduleVideo(s, item);
    }

    function scheduleVideo(s, item) {
        var gen = generation;
        if (!videoGate(environment()).allowed || !(item.LocalTrailerCount > 0)) return;
        s.videoTimer = win.setTimeout(function () {
            if (state !== s || gen !== generation || s.slides[s.index] !== item) return;
            startTrailer(s, item);
        }, config.videoDelayMs);
    }

    function startTrailer(s, item) {
        var client = api();
        if (!client || !s.visible || otherVideoPlaying(s) || !videoGate(environment()).allowed) return;
        var address = client.serverAddress();
        var cached = s.trailerCache[item.Id];
        var lookup = cached !== undefined
            ? Promise.resolve(cached)
            : getJson(client, buildTrailersUrl({ address: address, id: item.Id, userId: client.getCurrentUserId() }))
                .then(function (trailers) {
                    var picked = pickTrailer(trailers, function (t) { return s.video.canPlayType(t); }, config.maxVideoWidth);
                    s.trailerCache[item.Id] = picked;
                    return picked;
                });
        lookup.then(function (trailer) {
            if (!trailer || state !== s || s.slides[s.index] !== item || !s.visible) return;
            var window_ = playWindow(trailer.durationSec, config.startSeconds, config.maxPlaySeconds);
            var v = s.video;
            s.windowStart = window_.start;
            s.windowEnd = window_.start + window_.length;
            v.muted = true;
            v.preload = 'auto';
            v.src = buildStreamUrl({
                address: address, id: trailer.id, mediaSourceId: trailer.mediaSourceId,
                token: client.accessToken(), startSec: window_.start
            });
            var played = v.play();
            if (played && typeof played.catch === 'function') played.catch(function () { stopVideo(s); });
        }).catch(function () { /* no trailer or request failed: the backdrop stays */ });
    }

    function buildHero(s) {
        var root = el('section', 'trailer-hero');
        root.setAttribute('aria-label', 'Featured');
        var media = el('div', 'trailer-hero__media');
        s.layers = [el('div', 'trailer-hero__bg'), el('div', 'trailer-hero__bg')];
        s.layerIndex = 1;
        s.video = el('video', 'trailer-hero__video');
        s.video.muted = true;
        s.video.loop = false;
        s.video.playsInline = true;
        s.video.preload = 'none';
        s.video.setAttribute('muted', '');
        s.video.setAttribute('playsinline', '');
        s.video.setAttribute('disablepictureinpicture', '');
        s.video.setAttribute('disableremoteplayback', '');
        s.video.setAttribute('tabindex', '-1');
        media.appendChild(s.layers[0]);
        media.appendChild(s.layers[1]);
        media.appendChild(s.video);
        media.appendChild(el('div', 'trailer-hero__scrim'));
        root.appendChild(media);
        s.content = el('div', 'trailer-hero__content');
        root.appendChild(s.content);
        if (s.canSound) {
            s.toggle = el('button', 'trailer-hero__sound');
            s.toggle.type = 'button';
            s.toggle.appendChild(buildSoundIcon());
            s.toggle.addEventListener('click', function () { toggleSound(s); });
            updateToggle(s);
            root.appendChild(s.toggle);
        }
        var dots = el('div', 'trailer-hero__dots');
        dots.setAttribute('aria-hidden', 'true');
        s.dots = s.slides.map(function () {
            var d = el('i');
            dots.appendChild(d);
            return d;
        });
        root.appendChild(dots);
        s.root = root;
    }

    function wire(s) {
        function on(target, type, fn, opts) {
            target.addEventListener(type, fn, opts);
            s.cleanups.push(function () { target.removeEventListener(type, fn, opts); });
        }
        s.video.addEventListener('playing', function () {
            s.video.classList.add('is-playing');
            // Dwell on the slide for the whole visible window of the trailer.
            scheduleRotate(s, Math.max(1000, (s.windowEnd - s.windowStart) * 1000));
            applySound(s);
        });
        // Another video starting (the player, a preview) silences and stops the hero's.
        on(doc, 'playing', function (e) {
            if (e.target !== s.video && e.target && e.target.tagName === 'VIDEO') stopVideo(s);
        }, true);
        s.video.addEventListener('timeupdate', function () {
            if (s.video.currentTime >= s.windowEnd) s.video.currentTime = s.windowStart;
        });
        s.video.addEventListener('error', function () { stopVideo(s); });
        on(s.root, 'focusin', function () { s.held = true; });
        on(s.root, 'focusout', function (e) {
            if (!e.relatedTarget || !s.root.contains(e.relatedTarget)) s.held = false;
        });
        on(s.root, 'mouseenter', function () { s.held = true; });
        on(s.root, 'mouseleave', function () { s.held = false; });
        on(doc, 'visibilitychange', function () {
            if (doc.hidden) { stopVideo(s); return; }
            show(s, s.index);
        });
        if (typeof win.IntersectionObserver === 'function') {
            s.io = new win.IntersectionObserver(function (entries) {
                var seen = entries[entries.length - 1].isIntersecting;
                if (seen === s.visible) return;
                s.visible = seen;
                if (!seen) stopVideo(s);
                else show(s, s.index);
            }, { threshold: 0.25 });
            s.io.observe(s.root);
        }
    }

    function mount(page) {
        var host = page.querySelector('#homeTab');
        if (!host) return;
        if (state && state.page === page && state.root.isConnected) return;
        unmount();
        var existing = host.querySelectorAll('.trailer-hero');
        for (var i = 0; i < existing.length; i++) existing[i].parentNode.removeChild(existing[i]);
        var client = api();
        if (!client) return;
        var gen = generation;
        var address = client.serverAddress();
        var userId = client.getCurrentUserId();
        var base = { address: address, userId: userId, types: config.includeTypes, limit: 20 };
        Promise.all([
            getJson(client, buildItemsUrl(Object.assign({ hasTrailer: true, sortBy: 'Random' }, base))).catch(function () { return {}; }),
            getJson(client, buildItemsUrl(Object.assign({ sortBy: 'DateCreated', sortOrder: 'Descending' }, base))).catch(function () { return {}; })
        ]).then(function (results) {
            if (gen !== generation || !page.isConnected) return;
            var slides = selectSlides(results[0].Items, results[1].Items, config.maxSlides, config.includeTypes);
            if (!slides.length) return;
            var s = {
                page: page, slides: slides, index: 0, held: false, visible: true,
                trailerCache: {}, cleanups: [], rotateTimer: 0, videoTimer: 0,
                windowStart: 0, windowEnd: 0, fadeTimer: 0,
                // No button under reduced motion or data saver: no video plays there either.
                canSound: canSound && videoGate({ reducedMotion: environment().reducedMotion, saveData: environment().saveData, hidden: false }).allowed,
                pref: readSoundPref(localStore()), soundOn: false, toggle: null
            };
            // A gesture earlier on this page load lets a saved preference apply at once.
            s.soundOn = s.canSound && restorePlan({ allowed: canSound, saved: s.pref, gestured: gestured }) === 'restore';
            buildHero(s);
            wire(s);
            var anchor = host.querySelector('.sections');
            host.insertBefore(s.root, anchor || host.firstChild);
            state = s;
            show(s, 0);
        }).catch(function (err) {
            if (win.console) win.console.warn('trailer-hero: not shown', err);
        });
    }

    function onViewShow(event) {
        var target = event.target;
        if (target && target.id === 'indexPage' && target.classList && target.classList.contains('homePage')) mount(target);
        else unmount();
    }

    function onViewHide(event) {
        if (state && event.target === state.page) unmount();
    }

    if (config.disabled) return;
    if (canSound) {
        ['pointerup', 'keydown', 'touchend', 'click'].forEach(function (type) {
            doc.addEventListener(type, onFirstGesture, true);
        });
    }
    doc.addEventListener('viewshow', onViewShow, true);
    doc.addEventListener('viewhide', onViewHide, true);
    win.addEventListener('popstate', function () { if (state && !state.root.isConnected) unmount(); });

    win.TrailerHero = { logic: logic, unmount: unmount, version: '0.2.0' };

    // The script may load after the first home view fired viewshow.
    var current = doc.getElementById('indexPage');
    if (current && current.classList.contains('homePage') && current.offsetParent !== null) mount(current);
})();
