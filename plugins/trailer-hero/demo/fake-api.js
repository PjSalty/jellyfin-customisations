'use strict';
// A stand-in for the Jellyfin web client's window.ApiClient, enough for the hero.
(function () {
    var LONG = 'A courier carries a sealed crate across a coastline that no map agrees on. Every harbour owes someone a favour, and every favour has a price that is only named after the crate changes hands.';
    function movie(id, name, year, trailers) {
        return {
            Id: id, ServerId: 'demo', Type: 'Movie', Name: name, ProductionYear: year, Overview: LONG,
            CommunityRating: 7.4, OfficialRating: 'PG-13', RunTimeTicks: 112 * 6e8,
            BackdropImageTags: ['t'], ImageTags: {}, LocalTrailerCount: trailers
        };
    }
    var items = [
        movie('m000a', 'Low Tide', 2023, 1),
        movie('m000b', 'The Salt Road', 2024, 0),
        movie('m000c', 'Night Ferry', 2022, 1),
        movie('m000d', 'Glass Coast', 2021, 0)
    ];
    var trailers = {
        m000a: [{ Id: 'tr-a', MediaSources: [{ Id: 'ms-a', Container: 'mp4', RunTimeTicks: 14 * 1e7, MediaStreams: [{ Type: 'Video', Codec: 'h264', Width: 960, BitDepth: 8 }] }] }],
        m000c: [{ Id: 'tr-c', MediaSources: [{ Id: 'ms-c', Container: 'avi', MediaStreams: [{ Type: 'Video', Codec: 'mpeg4', Width: 640 }] }] }]
    };
    function json(url) {
        var u = new URL(url, location.href);
        var m = /^\/Items\/([^/]+)\/LocalTrailers$/.exec(u.pathname);
        if (m) return trailers[m[1]] || [];
        if (u.pathname === '/Items') {
            var only = u.searchParams.get('HasTrailer') === 'true';
            return { Items: items.filter(function (i) { return !only || i.LocalTrailerCount > 0; }), TotalRecordCount: items.length };
        }
        if (u.pathname === '/Sessions') return [{ Id: 'sess-1' }];
        return {};
    }
    window.__demoCalls = [];
    window.ApiClient = {
        getCurrentUserId: function () { return 'user-1'; },
        serverAddress: function () { return ''; },
        serverId: function () { return 'demo'; },
        deviceId: function () { return 'demo-device'; },
        accessToken: function () { return 'demo-token'; },
        getJSON: function (url) { window.__demoCalls.push(url); return Promise.resolve(json(url)); },
        ajax: function (req) { window.__demoCalls.push(req.type + ' ' + req.url); return Promise.resolve({}); }
    };
    window.Dashboard = { navigate: function (route) { window.__demoCalls.push('navigate ' + route); } };
})();
