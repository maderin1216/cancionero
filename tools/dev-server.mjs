// Servidor de desarrollo: sirve app/ y expone la carpeta de datos con la misma API que usa Electron.
//   node tools/dev-server.mjs [puerto] [carpeta-datos]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFsApi } from '../electron/fs-api.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = +(process.argv[2] || 5180);
const api = makeFsApi(() => path.resolve(process.argv[3] || path.join(root, 'data')));
const appDir = path.join(root, 'app');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      let body = '';
      for await (const c of req) body += c;
      const a = body ? JSON.parse(body) : {};
      const op = url.pathname.slice(5);
      const out = op === 'list' ? await api.list()
        : op === 'read' ? { text: await api.read(a.path) }
        : op === 'write' ? await api.write(a.path, a.text)
        : op === 'remove' ? await api.remove(a.path) ?? {}
        : null;
      if (!out) { res.writeHead(404).end('?'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(out));
      return;
    }
    let file = path.join(appDir, decodeURIComponent(url.pathname));
    if (!file.startsWith(appDir)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404).end('no encontrado'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    res.writeHead(500).end(String(e.message));
  }
}).listen(port, () => console.log(`Cancionero en http://localhost:${port}`));
