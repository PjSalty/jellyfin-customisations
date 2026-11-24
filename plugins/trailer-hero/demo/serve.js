'use strict';
// Dependency-free demo server: static files plus the three Jellyfin routes the
// hero calls, answered from ./assets. Run: node plugins/trailer-hero/demo/serve.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.mp4': 'video/mp4' };

function sendFile(req, res, file) {
    fs.stat(file, (err, st) => {
        if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
        const type = types[path.extname(file)] || 'application/octet-stream';
        const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        if (m) {
            const start = m[1] ? Number(m[1]) : 0;
            const end = m[2] ? Math.min(Number(m[2]), st.size - 1) : st.size - 1;
            res.writeHead(206, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
            fs.createReadStream(file, { start, end }).pipe(res);
            return;
        }
        res.writeHead(200, { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': st.size });
        fs.createReadStream(file).pipe(res);
    });
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    let m = /^\/Videos\/[^/]+\/stream$/.exec(url.pathname);
    if (m) return sendFile(req, res, path.join(__dirname, 'assets/sample-trailer.mp4'));
    m = /^\/Items\/([^/]+)\/Images\/Backdrop\/0$/.exec(url.pathname);
    if (m) return sendFile(req, res, path.join(__dirname, 'assets/backdrop-' + (m[1].charCodeAt(m[1].length - 1) % 3 + 1) + '.svg'));
    if (/^\/Items\/[^/]+\/Images\//.test(url.pathname)) { res.writeHead(404).end(); return; }
    if (url.pathname === '/') { res.writeHead(302, { Location: '/demo/index.html' }).end(); return; }
    if (url.pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
    const rel = url.pathname;
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
    sendFile(req, res, file);
});

const port = Number(process.env.PORT || 8099);
server.listen(port, '127.0.0.1', () => console.log('demo on http://127.0.0.1:' + port + '/'));
