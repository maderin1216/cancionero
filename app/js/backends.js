// "Backends" de almacenamiento. Todos exponen la misma interfaz:
//   list() -> [{path, rev}]   read(path) -> texto   write(path, texto) -> {rev}   remove(path)

/** PC (Electron): lee y escribe la carpeta local de Dropbox mediante el preload. */
export class FsBackend {
  constructor(api) { this.api = api; this.id = 'fs'; this.label = 'Carpeta local'; }
  list() { return this.api.list(); }
  read(p) { return this.api.read(p); }
  write(p, t) { return this.api.write(p, t); }
  remove(p) { return this.api.remove(p); }
}

/** Desarrollo: el servidor local (tools/dev-server.mjs) expone la carpeta data/. */
export class DevBackend {
  constructor() { this.id = 'dev'; this.label = 'Servidor de desarrollo'; }
  async req(op, body) {
    const r = await fetch(`/api/${op}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }
  list() { return this.req('list'); }
  async read(path) { return (await this.req('read', { path })).text; }
  write(path, text) { return this.req('write', { path, text }); }
  remove(path) { return this.req('remove', { path }); }
}

// ---------------------------------------------------------------- Dropbox (celular / web)

const TOKEN_KEY = 'cancionero.dropbox';
const VERIFIER_KEY = 'cancionero.dropbox.verifier';

const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Dropbox exige que el JSON del header sea ASCII.
const headerJson = o => JSON.stringify(o).replace(/[\u007f-￿]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));

export class DropboxBackend {
  constructor(appKey) {
    this.id = 'dropbox';
    this.label = 'Dropbox';
    this.appKey = appKey;
    try { this.tok = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null'); } catch { this.tok = null; }
  }

  get connected() { return !!this.tok?.refresh_token; }
  get redirectUri() { return location.origin + location.pathname; }

  async connect() {
    if (!this.appKey) throw new Error('Falta la "App key" de Dropbox (ver Ajustes).');
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
    localStorage.setItem(VERIFIER_KEY, verifier);
    const u = new URL('https://www.dropbox.com/oauth2/authorize');
    u.search = new URLSearchParams({
      client_id: this.appKey, response_type: 'code', code_challenge: challenge,
      code_challenge_method: 'S256', token_access_type: 'offline', redirect_uri: this.redirectUri,
    });
    location.href = u.toString();
  }

  /** Si volvemos de la autorización de Dropbox con ?code=..., canjearlo por tokens. */
  async handleRedirect() {
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (!code) return false;
    history.replaceState(null, '', this.redirectUri + location.hash);
    const verifier = localStorage.getItem(VERIFIER_KEY);
    if (!verifier) return false;
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ code, grant_type: 'authorization_code', code_verifier: verifier, client_id: this.appKey, redirect_uri: this.redirectUri }),
    });
    if (!r.ok) throw new Error('Dropbox rechazó la autorización: ' + await r.text());
    this.saveToken(await r.json());
    localStorage.removeItem(VERIFIER_KEY);
    return true;
  }

  saveToken(t) {
    this.tok = { ...this.tok, ...t, expires_at: Date.now() + (t.expires_in - 60) * 1000 };
    localStorage.setItem(TOKEN_KEY, JSON.stringify(this.tok));
  }

  disconnect() {
    this.tok = null;
    localStorage.removeItem(TOKEN_KEY);
  }

  async token() {
    if (!this.connected) throw new Error('No conectado a Dropbox');
    if (Date.now() < (this.tok.expires_at || 0)) return this.tok.access_token;
    const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: this.tok.refresh_token, client_id: this.appKey }),
    });
    if (!r.ok) {
      if (r.status === 400 || r.status === 401) this.disconnect();
      throw new Error('No se pudo renovar el acceso a Dropbox');
    }
    this.saveToken(await r.json());
    return this.tok.access_token;
  }

  async rpc(endpoint, body) {
    const r = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`Dropbox ${endpoint}: ${await r.text()}`);
    return r.json();
  }

  async list() {
    let res;
    try { res = await this.rpc('files/list_folder', { path: '', recursive: true }); }
    catch (e) { if (/not_found/.test(e.message)) return []; throw e; }
    const entries = [...res.entries];
    while (res.has_more) { res = await this.rpc('files/list_folder/continue', { cursor: res.cursor }); entries.push(...res.entries); }
    return entries.filter(e => e['.tag'] === 'file').map(e => ({ path: e.path_display.replace(/^\//, ''), rev: e.rev }));
  }

  async read(path) {
    const r = await fetch('https://content.dropboxapi.com/2/files/download', {
      method: 'POST',
      headers: { Authorization: `Bearer ${await this.token()}`, 'Dropbox-API-Arg': headerJson({ path: '/' + path }) },
    });
    if (!r.ok) throw new Error(`No se pudo leer ${path}`);
    return r.text();
  }

  async write(path, text) {
    const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': headerJson({ path: '/' + path, mode: 'overwrite', mute: true }),
      },
      body: new TextEncoder().encode(text),
    });
    if (!r.ok) throw new Error(`No se pudo guardar ${path}: ${await r.text()}`);
    return { rev: (await r.json()).rev };
  }

  async remove(path) {
    await this.rpc('files/delete_v2', { path: '/' + path });
  }
}
