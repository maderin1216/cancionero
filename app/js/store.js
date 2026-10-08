// Almacén de canciones y listas, con caché local para funcionar sin conexión.
//
// Estructura de archivos (igual en Dropbox y en la carpeta local de la PC):
//   canciones/<slug>.cho     una canción en formato ChordPro
//   listas/<id>.json         {name, date, items: [{song: 'canciones/x.cho', semis: 0}]}

import { parseSong, songKey, songPlainText } from './song.js';
import { fold, slugify } from './util.js';

export class Store extends EventTarget {
  constructor(backend) {
    super();
    this.backend = backend;
    this.cacheKey = `cancionero.cache.${backend.id}`;
    this.files = {};   // path -> {rev, text}
    this.songs = new Map();
    this.lists = new Map();
    this.status = 'idle';
  }

  loadCache() {
    try { this.files = JSON.parse(localStorage.getItem(this.cacheKey) || '{}').files || {}; }
    catch { this.files = {}; }
    this.rebuild();
  }

  saveCache() {
    try { localStorage.setItem(this.cacheKey, JSON.stringify({ files: this.files })); }
    catch (e) { console.warn('No se pudo guardar la caché', e); }
  }

  rebuild() {
    this.songs.clear();
    this.lists.clear();
    for (const [path, f] of Object.entries(this.files)) {
      if (path.startsWith('canciones/') && path.endsWith('.cho')) this.songs.set(path, makeSongEntry(path, f.text));
      else if (path.startsWith('listas/') && path.endsWith('.json')) {
        try { this.lists.set(path, { path, ...JSON.parse(f.text) }); } catch { /* lista dañada */ }
      }
    }
    this.dispatchEvent(new Event('change'));
  }

  setStatus(s, err) {
    this.status = s;
    this.error = err;
    this.dispatchEvent(new Event('status'));
  }

  async sync() {
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      this.setStatus('syncing');
      try {
        const remote = await this.backend.list();
        const wanted = remote.filter(f => /^(canciones\/.+\.cho|listas\/.+\.json)$/i.test(f.path));
        const seen = new Set();
        let changed = false;
        const toRead = wanted.filter(f => { seen.add(f.path); return this.files[f.path]?.rev !== f.rev; });
        // descargar de a varios a la vez
        for (let i = 0; i < toRead.length; i += 8) {
          const batch = toRead.slice(i, i + 8);
          const texts = await Promise.all(batch.map(f => this.backend.read(f.path)));
          batch.forEach((f, j) => { this.files[f.path] = { rev: f.rev, text: texts[j] }; });
          changed = true;
        }
        for (const p of Object.keys(this.files)) if (!seen.has(p)) { delete this.files[p]; changed = true; }
        if (changed) { this.saveCache(); this.rebuild(); }
        this.setStatus('ok');
      } catch (e) {
        console.error(e);
        this.setStatus('error', e);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  async write(path, text) {
    const { rev } = await this.backend.write(path, text);
    this.files[path] = { rev, text };
    this.saveCache();
    this.rebuild();
  }

  async remove(path) {
    await this.backend.remove(path);
    delete this.files[path];
    this.saveCache();
    this.rebuild();
  }

  /** Guarda una canción. Si es nueva (path null) elige un nombre de archivo libre. */
  async saveSong(path, text) {
    if (!path) {
      const title = parseSong(text).meta.title || 'cancion';
      const base = slugify(title);
      let p = `canciones/${base}.cho`, n = 2;
      while (this.files[p]) p = `canciones/${base}-${n++}.cho`;
      path = p;
    }
    await this.write(path, text);
    return path;
  }

  async saveList(list) {
    const path = list.path || `listas/${list.date || 'sin-fecha'}-${slugify(list.name)}-${Date.now().toString(36)}.json`;
    const { path: _, ...data } = list;
    await this.write(path, JSON.stringify(data, null, 2));
    return path;
  }

  songList() {
    return [...this.songs.values()].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  }

  listList() {
    return [...this.lists.values()].sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.name.localeCompare(b.name));
  }

  search(q) {
    const f = fold(q).trim();
    if (!f) return this.songList().map(s => ({ song: s }));
    const words = f.split(/\s+/);
    const res = [];
    for (const s of this.songs.values()) {
      let score = 0;
      if (s.sortKey.startsWith(f)) score = 4;
      else if (words.every(w => s.sortKey.includes(w))) score = 3;
      else if (s.searchText.includes(f)) score = 2;
      else if (words.every(w => s.searchText.includes(w))) score = 1;
      if (score) res.push({ song: s, score, snippet: score <= 2 ? snippet(s, words[0]) : '' });
    }
    return res.sort((a, b) => b.score - a.score || a.song.sortKey.localeCompare(b.song.sortKey));
  }
}

function makeSongEntry(path, text) {
  let parsed;
  try { parsed = parseSong(text); } catch { parsed = { meta: {}, lines: [] }; }
  const title = parsed.meta.title || path.replace(/^canciones\/|\.cho$/g, '');
  const plain = songPlainText(parsed);
  return {
    path, text, song: parsed, title,
    key: songKey(parsed),
    sortKey: fold(title).replace(/^[¡¿"'(]+/, ''),
    plain,
    searchText: fold(plain),
  };
}

function snippet(s, word) {
  const i = s.searchText.indexOf(word);
  if (i < 0 || s.sortKey.includes(word)) return '';
  const start = Math.max(0, i - 25);
  return (start ? '…' : '') + s.plain.slice(start, i + 45).trim() + '…';
}
