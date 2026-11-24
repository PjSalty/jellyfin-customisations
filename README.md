# Jellyfin customisations

Small, dependency-free additions for the Jellyfin web client. Each one lives
in `plugins/<name>/`, is plain browser JavaScript and CSS, needs no build step,
and loads nothing from outside your server. MIT licensed.

| Plugin | What it does |
|---|---|
| [`trailer-hero`](plugins/trailer-hero/) | A full-width home-screen hero that rotates through titles and plays their local trailer behind the text, muted unless the viewer turns sound on |

## Trailer Hero

A hero at the top of the home screen rotates through up to six recent or
random Movies and Series the signed-in user can see. Each slide shows the
backdrop at once. A moment later, if the title has a local trailer the browser
can play as is, the trailer plays muted behind the logo or title, year, rating,
overview and Play / More info buttons.

Everything comes from your own server, through the web client's existing
session (`window.ApiClient`). The script never requests another origin and
refuses to run if the client's server address is not the page's own origin.

### Install

Serve two files from the same origin as the web client and load them from
`index.html`:

```html
<link rel="stylesheet" href="trailer-hero.css">
<script defer src="trailer-hero.js"></script>
```

Put them in the web root next to `index.html` (for the official container,
`/jellyfin/jellyfin-web/`), or use a web-server rewrite that injects the two
tags. Jellyfin's own "Custom CSS" setting can carry the stylesheet, but the
script needs the tag.

### Trailers

Only trailers already in your library play: a `trailers` folder next to the
movie, or a `-trailer` file (see the Jellyfin docs on local trailers). Titles
without one show their backdrop. Remote (YouTube) trailers are never used.

If almost nothing in your library has a local trailer, you will see backdrops
only. Check before expecting video.

The trailer is streamed as is (`/Videos/{id}/stream?static=true`), with no
transcoding. It plays only when the browser reports it can handle the container
and codec: MP4/M4V/MOV or WebM with H.264, VP8, VP9, AV1 (or HEVC where the
device supports it), at most 1920 px wide. Anything else falls back to the
backdrop.

### Devices

- Desktop and mobile browsers: supported.
- LG webOS TV web app (Chromium 94 on webOS 23): written for it. No `:has()`,
  `color-mix()`, container queries, CSS nesting or JavaScript past ES2019. The
  buttons are plain focusable `<button>` elements, the hero never traps focus,
  and rotation pauses while a button has focus.
- Fire TV: the Jellyfin app there is native, not the web client, so this does
  not appear at all.
- Not shown: any client that is not the Jellyfin web client.

### Sound

Trailers always start muted. A round speaker button in the top right corner
of the hero turns sound on and off (a `<button>` with `aria-pressed` and a
label that changes with the state, 44 px or larger, reachable with Tab, a TV
remote and Enter). When a person turns sound on, the choice is kept per device
in `localStorage` under `trailer-hero:sound` (`on` or `off`); a blocked
storage is ignored and the hero stays muted.

On the next visit the hero starts muted and shows the muted button. Browsers
refuse sound before the person has interacted with the page
(https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay), so a
saved "sound on" is applied on the first click, key press or touch anywhere
on the page. If the browser still refuses, the trailer stays muted and keeps
playing and the button shows the muted state. Sound plays at volume 0.5 after
a 400 ms fade-in (`soundVolume`, `soundFadeMs`), and stops when the slide
changes, the hero scrolls off screen, the tab is hidden, another video starts,
or the view changes. Under `prefers-reduced-motion` or data saver there is no
video and no button.

Admins can force "always muted" for everyone, which hides the button and
ignores any saved preference, in either way:

```html
<script>window.TrailerHeroConfig = { allowSound: false };</script>
<!-- or, on the script tag itself -->
<script defer src="trailer-hero.js" data-sound="off"></script>
```

### Behaviour and limits

- One `<video>` element, created once and reused, `preload="none"` until a
  slide is active.
- Muted by default; see Sound.
- No video when `prefers-reduced-motion: reduce` or `navigator.connection.saveData`
  is set, when the tab is hidden, or when the hero is scrolled off screen.
- Playback starts a few seconds into the trailer, loops inside a 20 second
  window, and stops when another video starts playing.
- Only `opacity` and `transform` are animated.
- The web client is a single-page app: the hero mounts on the home view,
  unmounts on any other view, and never duplicates.
- Play uses the client's own session (`Sessions/{id}/Playing`); if that fails it
  opens the details page. More info opens the details page.

### Configure

Set `window.TrailerHeroConfig` before the script loads:

```html
<script>
window.TrailerHeroConfig = { maxSlides: 5, maxPlaySeconds: 15, labels: { play: 'Play', info: 'Details' } };
</script>
```

Keys: `maxSlides`, `rotateMs`, `videoDelayMs`, `startSeconds`, `maxPlaySeconds`,
`maxVideoWidth`, `includeTypes`, `labels` (also `mute` and `unmute`), `allowSound`,
`soundVolume`, `soundFadeMs`, `disabled`. Theme it with the custom
properties at the top of `trailer-hero.css`; `--trailer-hero-header-offset`
pulls the hero up under a transparent header.

### API routes used

All same-origin, all read-only except Play:

- `GET /Items?userId=...&IncludeItemTypes=Movie,Series&HasTrailer=true` and a
  recent-items variant, with `Fields=Overview,LocalTrailerCount`
- `GET /Items/{id}/LocalTrailers?userId=...`
- `GET /Items/{id}/Images/Backdrop/0` and `/Images/Logo`
- `GET /Videos/{id}/stream?static=true&mediaSourceId=...&ApiKey=...`
- `GET /Sessions?deviceId=...`, `POST /Sessions/{id}/Playing` (Play button)

### Develop

```sh
npm test                                          # Node's built-in runner, no dependencies
node plugins/trailer-hero/demo/serve.js           # demo with a fake ApiClient on http://127.0.0.1:8099/
```

The demo uses a generated sample clip and gradient backdrops. The tests cover
the pure logic: slide selection, URL building, trailer and fallback decisions,
the motion and data-saver gate, and the sound preference, gesture gating and
forced-mute logic. The demo accepts `?nosound=1` to show the forced-mute switch.

## Licence

MIT. See [LICENSE](LICENSE).
