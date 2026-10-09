// Almacén de canciones y listas: habla con la API del servidor y guarda una copia local para que la
// app funcione sin conexión con lo último que se descargó.
//
// Identificadores que usa la interfaz:
//   canción -> su "slug" (ej: "a-tanto-amor")
//   lista   -> "listas/<id>"
// Cada ítem de lista es {id, song, label, semis}; "semis" (el tono) es personal de cada usuario.

import { parseSong, songKey, songPlainText } from './song.js';
import { fold } from './util.js';

const SESSION_KEY = 'cancionero.session';
const CACHE_KEY = 'cancionero.v2.cache';

export class ApiError extends Error {
  constructor(status, data) { super(data?.error || `Error ${status}`); this.status = status; this.data = data || {}; }
}

export class ApiStore extends EventTarget {
  constructor(apiBase) {
    super();
    this.apiBase = apiBase;
    this.token = localStorage.getItem(SESSION_KEY) || '';
    this.me = null;
    this.rawSongs = {};  // slug -> {text, rev, mine, owner_name, visibility}
    this.catalog = [];   // canciones ajenas de las que sólo se ve el título
    this.rawLists = [];  // tal como vienen del servidor
    this.songs = new Map();
    this.lists = new Map();
    this.status = 'idle';
  }

  get loggedIn() { return !!this.token; }
  get canEditSongs() { return !!this.me; } // cualquiera puede tener sus propias canciones
  get isAdmin() { return this.me?.role === 'admin'; }

  // ---------------------------------------------------------------- llamadas a la API

  async api(method, path, body) {
    let r;
    try {
      r = await fetch(this.apiBase + path, {
        method,
        headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, { error: 'Sin conexión con el servidor' });
    }
    const data = await r.json().catch(() => ({}));
    if (r.status === 401 && this.token && path !== '/api/login') {
      this.clearSession();
      this.dispatchEvent(new Event('auth'));
    }
    if (!r.ok) throw new ApiError(r.status, data);
    return data;
  }

  setSession({ token, me }) {
    this.token = token;
    this.me = me;
    localStorage.setItem(SESSION_KEY, token);
  }

  clearSession() {
    this.token = '';
    this.me = null;
    localStorage.removeItem(SESSION_KEY);
  }

  async needsSetup() { return (await this.api('GET', '/api/status')).needsSetup; }

  async login(username, password) {
    const r = await this.api('POST', '/api/login', { username, password });
    this.resetCacheIfOtherUser(r.me);
    this.setSession(r);
  }

  async setup(username, name, password) {
    const r = await this.api('POST', '/api/setup', { username, name, password });
    this.resetCacheIfOtherUser(r.me);
    this.setSession(r);
  }

  async logout() {
    try { await this.api('POST', '/api/logout'); } catch { /* igual se cierra localmente */ }
    this.clearSession();
    localStorage.removeItem(CACHE_KEY);
    this.rawSongs = {}; this.rawLists = []; this.catalog = [];
    this.rebuild();
  }

  // si en este dispositivo entra otra persona, no mostrarle las listas privadas del anterior
  resetCacheIfOtherUser(me) {
    if (this.me && this.me.id !== me.id) {
      localStorage.removeItem(CACHE_KEY);
      this.rawSongs = {}; this.rawLists = []; this.catalog = [];
    }
  }

  // ---------------------------------------------------------------- caché local

  loadCache() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (c) { this.rawSongs = c.songs || {}; this.rawLists = c.lists || []; this.me = c.me || null; this.catalog = c.catalog || []; }
    } catch { /* caché dañada: se vuelve a bajar */ }
    this.rebuild();
  }

  saveCache() {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ songs: this.rawSongs, lists: this.rawLists, me: this.me, catalog: this.catalog })); }
    catch (e) { console.warn('No se pudo guardar la copia local', e); }
  }

  rebuild() {
    this.songs.clear();
    for (const [slug, s] of Object.entries(this.rawSongs)) this.songs.set(slug, makeSongEntry(slug, s));
    this.lists.clear();
    for (const l of this.rawLists) {
      const path = `listas/${l.id}`;
      this.lists.set(path, {
        path, id: l.id, name: l.name, date: l.date || '', rev: l.rev,
        owner_id: l.owner_id, owner_name: l.owner_name, mine: l.owner_id === this.me?.id,
        canEdit: l.can_edit, share_all: l.share_all, shares: l.shares || [], titles: l.titles || {},
        items: l.items.map(it => ({ ...it, semis: l.semis?.[it.id] || 0 })),
      });
    }
    this.dispatchEvent(new Event('change'));
  }

  setStatus(s, err) {
    this.status = s;
    this.error = err;
    this.dispatchEvent(new Event('status'));
  }

  async sync() {
    if (!this.loggedIn) return;
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      this.setStatus('syncing');
      try {
        // se mandan las versiones que ya tenemos: el servidor sólo devuelve el texto de lo que cambió
        const have = Object.fromEntries(Object.entries(this.rawSongs).map(([slug, s]) => [slug, s.rev]));
        const r = await this.api('POST', '/api/sync', { have });
        const next = {};
        for (const s of r.songs) {
          const text = s.text ?? this.rawSongs[s.slug]?.text;
          if (text !== undefined) next[s.slug] = { text, rev: s.rev, mine: s.mine, owner_name: s.owner_name, visibility: s.visibility };
        }
        this.rawSongs = next;
        this.rawLists = r.lists;
        this.catalog = r.catalog;
        this.me = r.me;
        this.saveCache();
        this.rebuild();
        this.setStatus('ok');
      } catch (e) {
        console.error(e);
        this.setStatus(e.status === 401 ? 'idle' : 'error', e);
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  // ---------------------------------------------------------------- canciones

  /**
   * Guarda una canción (nueva si slug es null). Si otro la cambió mientras se editaba, la API
   * responde 409; con force=true se guarda igual.
   */
  async saveSong(slug, text, { force = false, baseRev, visibility } = {}) {
    let r;
    if (slug) r = await this.api('PUT', `/api/songs/${slug}`, { text, baseRev: baseRev ?? this.rawSongs[slug]?.rev, force, visibility });
    else r = await this.api('POST', '/api/songs', { text, visibility });
    this.rawSongs[r.slug] = { ...this.rawSongs[r.slug], text, rev: r.rev, mine: true, owner_name: this.me?.name, visibility: visibility || this.rawSongs[r.slug]?.visibility || 'private' };
    this.saveCache();
    this.rebuild();
    return r.slug;
  }

  async deleteSong(slug) {
    await this.api('DELETE', `/api/songs/${slug}`);
    delete this.rawSongs[slug];
    this.saveCache();
    this.rebuild();
  }

  songHistory(slug) { return this.api('GET', `/api/songs/${slug}/history`); }

  /** Cambia quién puede ver estas canciones propias: 'private' | 'title' | 'public'. */
  async setVisibility(slugs, visibility) {
    const r = await this.api('PUT', '/api/songs/visibility', { slugs, visibility });
    for (const s of slugs) if (this.rawSongs[s]?.mine) this.rawSongs[s].visibility = visibility;
    this.saveCache();
    this.rebuild();
    return r.changed;
  }

  /** Copia propia de una canción ajena (se puede repetir). Devuelve el slug de la copia. */
  async copySong(slug) {
    const r = await this.api('POST', `/api/songs/${slug}/copy`);
    await this.sync();
    return r.slug;
  }

  // ---------------------------------------------------------------- listas

  async saveList(list) {
    const items = list.items.map(({ semis, ...it }) => ({ ...it, id: it.id || newItemId() }));
    list.items.forEach((it, i) => { it.id = items[i].id; });
    if (!list.id) {
      const semis = Object.fromEntries(list.items.filter(it => it.semis).map(it => [it.id, it.semis]));
      const r = await this.api('POST', '/api/lists', { name: list.name, date: list.date, items, semis });
      await this.sync();
      return `listas/${r.id}`;
    }
    const r = await this.api('PUT', `/api/lists/${list.id}`, { name: list.name, date: list.date, items, baseRev: list.rev, force: true });
    list.rev = r.rev;
    const raw = this.rawLists.find(l => l.id === list.id);
    if (raw) Object.assign(raw, { name: list.name, date: list.date, items: r.items, rev: r.rev });
    this.saveCache();
    this.rebuild();
    return list.path;
  }

  /** El tono de cada canción en la lista es personal: se guarda aparte. */
  async saveListSemis(list) {
    const semis = Object.fromEntries(list.items.filter(it => it.semis).map(it => [it.id, it.semis]));
    await this.api('PUT', `/api/lists/${list.id}/semis`, semis);
    const raw = this.rawLists.find(l => l.id === list.id);
    if (raw) raw.semis = semis;
    this.saveCache();
  }

  async shareList(list, shareAll, shares) {
    await this.api('PUT', `/api/lists/${list.id}/sharing`, { share_all: shareAll, shares });
    await this.sync();
  }

  async deleteList(list) {
    await this.api('DELETE', `/api/lists/${list.id}`);
    this.rawLists = this.rawLists.filter(l => l.id !== list.id);
    this.saveCache();
    this.rebuild();
  }

  async directory() { return (await this.api('GET', '/api/directory')).users; }

  // ---------------------------------------------------------------- cuenta y usuarios

  changePassword(oldPass, newPass) { return this.api('POST', '/api/me/password', { old: oldPass, new: newPass }); }
  async listUsers() { return (await this.api('GET', '/api/users')).users; }
  createUser(u) { return this.api('POST', '/api/users', u); }
  updateUser(id, changes) { return this.api('PUT', `/api/users/${id}`, changes); }

  // ---------------------------------------------------------------- búsqueda

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

const newItemId = () => crypto.getRandomValues(new Uint32Array(1))[0].toString(36);

function makeSongEntry(path, { text, rev, mine, owner_name, visibility }) {
  let parsed;
  try { parsed = parseSong(text); } catch { parsed = { meta: {}, lines: [] }; }
  const title = parsed.meta.title || path;
  const plain = songPlainText(parsed);
  return {
    path, text, rev, song: parsed, title, mine: mine !== false, owner_name, visibility: visibility || 'private',
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
