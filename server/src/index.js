// API del Cancionero 2.0 (Cloudflare Worker + base D1). La app web se sirve como archivos estáticos
// desde el mismo Worker; acá sólo llegan las rutas /api/*.
//
// Reglas de acceso a las canciones:
//   - Cada canción tiene dueño; sólo el dueño la edita o la borra.
//   - Un usuario puede VER una canción si es suya, si es "public", o si está en una lista que le
//     compartieron y la canción es del dueño de esa lista.
//   - Las "title" de otros aparecen sólo con el título.
//   - Cualquiera puede hacerse una copia propia (cuantas veces quiera) de una canción ajena que
//     puede ver o cuyo título es visible.
import { hashPassword, verifyPassword, newToken, tokenHash, checkPasswordStrength } from './auth.js';

const SESSION_DAYS = 180;
const MAX_FAILED = 8;          // intentos fallidos antes de bloquear
const LOCK_MS = 15 * 60 * 1000;
const ROLES = ['admin', 'editor']; // 'editor' = usuario común
const VISIBILITIES = ['private', 'title', 'public'];

// Orígenes que pueden llamar a la API desde otro dominio (la app de escritorio y desarrollo).
const ALLOWED_ORIGINS = ['app://cancionero', 'http://localhost:5180', 'http://localhost:8787'];

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}
const fail = (status, message, extra) => { throw new HttpError(status, message, extra); };

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(req);
    const origin = req.headers.get('Origin');
    const cors = origin && ALLOWED_ORIGINS.includes(origin)
      ? { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE', 'Access-Control-Max-Age': '86400', Vary: 'Origin' }
      : {};
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    let status = 200, body;
    try {
      body = await route(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) { status = e.status; body = { error: e.message, ...e.extra }; }
      else { console.error(e); status = 500; body = { error: 'Error interno del servidor' }; }
    }
    return new Response(JSON.stringify(body ?? {}), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...cors } });
  },
};

async function readJson(req) {
  try { return await req.json(); } catch { fail(400, 'Pedido inválido'); }
}

// ---------------------------------------------------------------- rutas

async function route(req, env, url) {
  const db = env.DB;
  const m = req.method;
  const p = url.pathname.replace(/\/+$/, '');
  let mt;

  if (p === '/api/status' && m === 'GET') {
    const n = await db.prepare('SELECT COUNT(*) AS n FROM users').first('n');
    return { needsSetup: n === 0 };
  }
  if (p === '/api/setup' && m === 'POST') return setup(db, await readJson(req));
  if (p === '/api/login' && m === 'POST') return login(db, await readJson(req));

  const me = await authenticate(db, req);

  if (p === '/api/logout' && m === 'POST') {
    await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(me.tokenHash).run();
    return {};
  }
  if (p === '/api/me' && m === 'GET') return { me: publicMe(me) };
  if (p === '/api/me/password' && m === 'POST') return changeOwnPassword(db, me, await readJson(req));
  if (p === '/api/sync' && m === 'POST') return sync(db, me, (await readJson(req)).have || {});
  if (p === '/api/directory' && m === 'GET') {
    const { results } = await db.prepare('SELECT id, username, name FROM users WHERE disabled = 0 ORDER BY name').all();
    return { users: results };
  }

  // canciones
  if (p === '/api/songs' && m === 'POST') return createSong(db, me, await readJson(req));
  if (p === '/api/songs/visibility' && m === 'PUT') return setVisibility(db, me, await readJson(req));
  if ((mt = p.match(/^\/api\/songs\/([a-z0-9-]+)$/))) {
    if (m === 'PUT') return updateSong(db, me, mt[1], await readJson(req));
    if (m === 'DELETE') return deleteSong(db, me, mt[1]);
  }
  if ((mt = p.match(/^\/api\/songs\/([a-z0-9-]+)\/history$/)) && m === 'GET') return songHistory(db, me, mt[1]);
  if ((mt = p.match(/^\/api\/songs\/([a-z0-9-]+)\/copy$/)) && m === 'POST') return copyVisibleSong(db, me, mt[1]);

  // listas
  if (p === '/api/lists' && m === 'POST') return createList(db, me, await readJson(req));
  if ((mt = p.match(/^\/api\/lists\/(\d+)$/))) {
    if (m === 'PUT') return updateList(db, me, +mt[1], await readJson(req));
    if (m === 'DELETE') return deleteList(db, me, +mt[1]);
  }
  if ((mt = p.match(/^\/api\/lists\/(\d+)\/sharing$/)) && m === 'PUT') return shareList(db, me, +mt[1], await readJson(req));
  if ((mt = p.match(/^\/api\/lists\/(\d+)\/semis$/)) && m === 'PUT') return saveSemis(db, me, +mt[1], await readJson(req));

  // administración de usuarios
  if (p === '/api/users') {
    requireRole(me, 'admin');
    if (m === 'GET') {
      const { results } = await db.prepare('SELECT id, username, name, role, disabled, created_at FROM users ORDER BY name').all();
      return { users: results };
    }
    if (m === 'POST') return createUser(db, await readJson(req));
  }
  if ((mt = p.match(/^\/api\/users\/(\d+)$/)) && m === 'PUT') {
    requireRole(me, 'admin');
    return updateUser(db, me, +mt[1], await readJson(req));
  }

  fail(404, 'No existe');
}

// ---------------------------------------------------------------- sesión

const publicMe = u => ({ id: u.id, username: u.username, name: u.name, role: u.role });

async function startSession(db, user) {
  const token = newToken();
  const now = Date.now();
  await db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await tokenHash(token), user.id, now, now + SESSION_DAYS * 864e5).run();
  return { token, me: publicMe(user) };
}

async function authenticate(db, req) {
  const h = req.headers.get('Authorization') || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  if (!token) fail(401, 'Tenés que iniciar sesión');
  const th = await tokenHash(token);
  const row = await db.prepare(`SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`).bind(th).first();
  const now = Date.now();
  if (!row || row.expires_at < now || row.disabled) fail(401, 'La sesión venció, volvé a iniciar sesión');
  // renovar la sesión si se usa (como mucho una vez por día)
  if (row.expires_at - now < (SESSION_DAYS - 1) * 864e5) {
    await db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').bind(now + SESSION_DAYS * 864e5, th).run();
  }
  return { ...row, tokenHash: th };
}

function requireRole(me, ...roles) {
  if (!roles.includes(me.role)) fail(403, 'No tenés permiso para hacer esto');
}

function cleanUsername(u) {
  const s = String(u || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(s)) fail(400, 'El usuario tiene que tener entre 3 y 30 letras, números, punto o guion (sin espacios ni acentos)');
  return s;
}

async function setup(db, body) {
  const n = await db.prepare('SELECT COUNT(*) AS n FROM users').first('n');
  if (n > 0) fail(403, 'La app ya tiene administrador');
  const username = cleanUsername(body.username);
  const err = checkPasswordStrength(body.password);
  if (err) fail(400, err);
  const name = String(body.name || '').trim() || username;
  const r = await db.prepare('INSERT INTO users (username, name, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *')
    .bind(username, name, await hashPassword(body.password), 'admin', Date.now()).first();
  // canciones cargadas antes de que existiera el administrador: pasan a ser suyas
  await db.prepare('UPDATE songs SET owner_id = ? WHERE owner_id IS NULL').bind(r.id).run();
  return startSession(db, r);
}

async function login(db, body) {
  const username = String(body.username || '').trim().toLowerCase();
  const user = await db.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
  const now = Date.now();
  if (user && user.locked_until > now) fail(429, 'Demasiados intentos fallidos. Probá de nuevo en unos minutos.');
  const ok = user && !user.disabled && await verifyPassword(String(body.password || ''), user.pass_hash);
  if (!ok) {
    if (user) {
      const failed = user.failed + 1;
      await db.prepare('UPDATE users SET failed = ?, locked_until = ? WHERE id = ?')
        .bind(failed >= MAX_FAILED ? 0 : failed, failed >= MAX_FAILED ? now + LOCK_MS : 0, user.id).run();
    }
    fail(401, 'Usuario o contraseña incorrectos');
  }
  if (user.failed) await db.prepare('UPDATE users SET failed = 0 WHERE id = ?').bind(user.id).run();
  return startSession(db, user);
}

async function changeOwnPassword(db, me, body) {
  if (!await verifyPassword(String(body.old || ''), me.pass_hash)) fail(400, 'La contraseña actual no es correcta');
  const err = checkPasswordStrength(body.new);
  if (err) fail(400, err);
  await db.batch([
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').bind(await hashPassword(body.new), me.id),
    // cerrar las demás sesiones
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').bind(me.id, me.tokenHash),
  ]);
  return {};
}

// ---------------------------------------------------------------- acceso a canciones

const fold = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const slugify = s => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'cancion';
const songTitle = text => (String(text).match(/^\s*\{\s*(?:title|t)\s*:\s*(.*?)\s*\}\s*$/mi) || [])[1] || '';

/** Pares "dueño:slug" de canciones que el usuario puede ver por estar en listas que le compartieron. */
function listGrants(lists, me) {
  const g = new Set();
  for (const l of lists) if (l.owner_id !== me.id) for (const it of l.items) g.add(`${l.owner_id}:${it.song}`);
  return g;
}

const canViewSong = (s, me, grants) => s.owner_id === me.id || s.visibility === 'public' || grants.has(`${s.owner_id}:${s.slug}`);

async function getSong(db, slug) {
  const s = await db.prepare('SELECT * FROM songs WHERE slug = ? AND deleted = 0').bind(slug).first();
  if (!s) fail(404, 'La canción no existe');
  return s;
}

async function getOwnSong(db, me, slug) {
  const s = await getSong(db, slug);
  if (s.owner_id !== me.id) fail(403, 'Sólo el dueño puede modificar esta canción');
  return s;
}

// ---------------------------------------------------------------- sincronización

/**
 * Devuelve todo lo que el usuario puede ver. `have` = {slug: rev} de lo que ya tiene guardado:
 * el texto sólo se manda si cambió.
 */
async function sync(db, me, have) {
  const now = Date.now();
  const [songsRes, lists] = await Promise.all([
    db.prepare('SELECT s.id, s.slug, s.text, s.rev, s.owner_id, s.visibility, s.copied_from, u.name AS owner_name FROM songs s JOIN users u ON u.id = s.owner_id WHERE s.deleted = 0').all(),
    visibleLists(db, me),
  ]);
  const grants = listGrants(lists, me);
  const songs = [], catalog = [];
  const titles = {};
  for (const s of songsRes.results) titles[s.slug] = songTitle(s.text);
  // canciones de las que ya tengo una copia
  const copied = new Set(songsRes.results.filter(s => s.owner_id === me.id && s.copied_from).map(s => s.copied_from));
  for (const s of songsRes.results) {
    const mine = s.owner_id === me.id;
    if (canViewSong(s, me, grants)) {
      songs.push({
        slug: s.slug, rev: s.rev, mine, owner_name: s.owner_name, visibility: s.visibility,
        ...(have[s.slug] === s.rev ? {} : { text: s.text }),
      });
    } else if (s.visibility === 'title') {
      catalog.push({ slug: s.slug, title: titles[s.slug], owner_name: s.owner_name, copied: copied.has(s.id) });
    }
  }
  // títulos de las canciones de cada lista (por si alguna no se puede ver)
  for (const l of lists) l.titles = Object.fromEntries(l.items.map(it => [it.song, titles[it.song] || '']));
  return { now, me: publicMe(me), songs, catalog, lists };
}

async function visibleLists(db, me) {
  const { results } = await db.prepare(`
    SELECT l.*, u.name AS owner_name, s.can_edit AS share_edit, ls.semis AS my_semis
    FROM lists l
    JOIN users u ON u.id = l.owner_id
    LEFT JOIN list_shares s ON s.list_id = l.id AND s.user_id = ?1
    LEFT JOIN list_semis ls ON ls.list_id = l.id AND ls.user_id = ?1
    WHERE l.deleted = 0 AND (l.owner_id = ?1 OR l.share_all > 0 OR s.user_id IS NOT NULL)`).bind(me.id).all();
  const mine = results.filter(l => l.owner_id === me.id).map(l => l.id);
  const shares = mine.length
    ? (await db.prepare(`SELECT list_id, user_id, can_edit FROM list_shares WHERE list_id IN (${mine.map(() => '?').join(',')})`).bind(...mine).all()).results
    : [];
  return results.map(l => ({
    id: l.id,
    name: l.name,
    date: l.date,
    items: JSON.parse(l.items),
    rev: l.rev,
    owner_id: l.owner_id,
    owner_name: l.owner_name,
    share_all: l.share_all,
    can_edit: l.owner_id === me.id || l.share_all === 2 || !!l.share_edit,
    shares: l.owner_id === me.id ? shares.filter(s => s.list_id === l.id).map(s => ({ user_id: s.user_id, can_edit: !!s.can_edit })) : undefined,
    semis: JSON.parse(l.my_semis || '{}'),
  }));
}

// ---------------------------------------------------------------- canciones

function checkSongText(text) {
  if (typeof text !== 'string' || !text.trim()) fail(400, 'La canción está vacía');
  if (text.length > 100000) fail(400, 'La canción es demasiado larga');
}

async function freeSlug(db, base) {
  let slug = base;
  for (let n = 2; await db.prepare('SELECT 1 FROM songs WHERE slug = ?').bind(slug).first(); n++) slug = `${base}-${n}`;
  return slug;
}

async function insertSong(db, ownerId, text, { visibility = 'private', copiedFrom = null, slugBase } = {}) {
  const slug = await freeSlug(db, slugBase || slugify(songTitle(text)));
  const now = Date.now();
  await db.prepare('INSERT INTO songs (slug, text, rev, updated_at, updated_by, owner_id, visibility, copied_from) VALUES (?, ?, 1, ?, ?, ?, ?, ?)')
    .bind(slug, text, now, ownerId, ownerId, visibility, copiedFrom).run();
  return { slug, rev: 1, updated_at: now };
}

async function createSong(db, me, body) {
  checkSongText(body.text);
  const visibility = VISIBILITIES.includes(body.visibility) ? body.visibility : 'private';
  return insertSong(db, me.id, body.text, { visibility });
}

async function updateSong(db, me, slug, body) {
  checkSongText(body.text);
  const cur = await getOwnSong(db, me, slug);
  // si se cambió desde otro dispositivo mientras se editaba, avisar (salvo que se pida sobrescribir)
  if (!body.force && body.baseRev && body.baseRev !== cur.rev) {
    fail(409, 'Esta canción se modificó (desde otro dispositivo) mientras la editabas', { current: cur.text, rev: cur.rev });
  }
  const now = Date.now();
  const rev = cur.rev + 1;
  const stmts = [
    db.prepare('INSERT INTO song_history (song_id, text, rev, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)').bind(cur.id, cur.text, cur.rev, cur.updated_at, cur.updated_by),
    db.prepare('UPDATE songs SET text = ?, rev = ?, updated_at = ?, updated_by = ? WHERE id = ?').bind(body.text, rev, now, me.id, cur.id),
  ];
  if (VISIBILITIES.includes(body.visibility)) stmts.push(db.prepare('UPDATE songs SET visibility = ? WHERE id = ?').bind(body.visibility, cur.id));
  await db.batch(stmts);
  return { slug, rev, updated_at: now };
}

async function setVisibility(db, me, body) {
  if (!VISIBILITIES.includes(body.visibility)) fail(400, 'Visibilidad inválida');
  const slugs = (Array.isArray(body.slugs) ? body.slugs : []).filter(s => typeof s === 'string').slice(0, 2000);
  let changed = 0;
  // de a tandas, para no pasar el límite de parámetros de la base
  for (let i = 0; i < slugs.length; i += 90) {
    const part = slugs.slice(i, i + 90);
    const r = await db.prepare(`UPDATE songs SET visibility = ? WHERE owner_id = ? AND deleted = 0 AND slug IN (${part.map(() => '?').join(',')})`)
      .bind(body.visibility, me.id, ...part).run();
    changed += r.meta.changes;
  }
  return { changed };
}

async function deleteSong(db, me, slug) {
  const cur = await getOwnSong(db, me, slug);
  const now = Date.now();
  await db.batch([
    db.prepare('INSERT INTO song_history (song_id, text, rev, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)').bind(cur.id, cur.text, cur.rev, cur.updated_at, cur.updated_by),
    db.prepare('UPDATE songs SET deleted = 1, rev = rev + 1, updated_at = ?, updated_by = ? WHERE id = ?').bind(now, me.id, cur.id),
  ]);
  return {};
}

async function songHistory(db, me, slug) {
  const s = await getOwnSong(db, me, slug);
  const { results } = await db.prepare(`
    SELECT h.rev, h.text, h.updated_at, u.name AS by FROM song_history h LEFT JOIN users u ON u.id = h.updated_by
    WHERE h.song_id = ? ORDER BY h.rev DESC LIMIT 50`).bind(s.id).all();
  return { history: results };
}

/** Copia propia de una canción ajena que se puede ver o cuyo título es visible. Se puede repetir. */
async function copyVisibleSong(db, me, slug) {
  const s = await getSong(db, slug);
  if (s.owner_id === me.id) fail(400, 'Esta canción ya es tuya');
  const grants = listGrants(await visibleLists(db, me), me);
  if (s.visibility !== 'title' && !canViewSong(s, me, grants)) fail(403, 'No tenés acceso a esta canción');
  return insertSong(db, me.id, s.text, { copiedFrom: s.id, slugBase: `${slugify(songTitle(s.text))}-${me.username.replace(/[^a-z0-9]+/g, '-')}` });
}

// ---------------------------------------------------------------- listas

function cleanItems(items) {
  if (!Array.isArray(items) || items.length > 300) fail(400, 'Lista inválida');
  return items.map(it => ({
    id: String(it.id || crypto.randomUUID().slice(0, 8)).slice(0, 40),
    song: String(it.song || '').slice(0, 100),
    ...(it.label ? { label: String(it.label).slice(0, 80) } : {}),
  }));
}

function cleanListMeta(body) {
  const name = String(body.name || '').trim().slice(0, 120);
  if (!name) fail(400, 'La lista necesita un nombre');
  const date = body.date && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : null;
  return { name, date };
}

async function getList(db, id) {
  const l = await db.prepare('SELECT * FROM lists WHERE id = ? AND deleted = 0').bind(id).first();
  if (!l) fail(404, 'La lista no existe');
  return l;
}

async function canEditList(db, me, l) {
  if (l.owner_id === me.id || l.share_all === 2) return true;
  return !!await db.prepare('SELECT 1 FROM list_shares WHERE list_id = ? AND user_id = ? AND can_edit = 1').bind(l.id, me.id).first();
}

async function canSeeList(db, me, l) {
  if (l.owner_id === me.id || l.share_all > 0) return true;
  return !!await db.prepare('SELECT 1 FROM list_shares WHERE list_id = ? AND user_id = ?').bind(l.id, me.id).first();
}

async function createList(db, me, body) {
  const { name, date } = cleanListMeta(body);
  const items = cleanItems(body.items || []);
  const r = await db.prepare('INSERT INTO lists (owner_id, name, date, items, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(me.id, name, date, JSON.stringify(items), Date.now()).first();
  if (body.semis && typeof body.semis === 'object') await saveSemis(db, me, r.id, body.semis);
  return { id: r.id, rev: 1, items };
}

async function updateList(db, me, id, body) {
  const l = await getList(db, id);
  if (!await canEditList(db, me, l)) fail(403, 'No podés editar esta lista');
  if (!body.force && body.baseRev && body.baseRev !== l.rev) fail(409, 'Otra persona modificó esta lista', { rev: l.rev });
  const { name, date } = cleanListMeta(body);
  const items = cleanItems(body.items || []);
  await db.prepare('UPDATE lists SET name = ?, date = ?, items = ?, rev = rev + 1, updated_at = ? WHERE id = ?')
    .bind(name, date, JSON.stringify(items), Date.now(), id).run();
  return { id, rev: l.rev + 1, items };
}

async function deleteList(db, me, id) {
  const l = await getList(db, id);
  if (l.owner_id !== me.id && me.role !== 'admin') fail(403, 'Sólo quien creó la lista puede borrarla');
  await db.prepare('UPDATE lists SET deleted = 1, updated_at = ? WHERE id = ?').bind(Date.now(), id).run();
  return {};
}

async function shareList(db, me, id, body) {
  const l = await getList(db, id);
  if (l.owner_id !== me.id) fail(403, 'Sólo quien creó la lista puede compartirla');
  const shareAll = [0, 1, 2].includes(body.share_all) ? body.share_all : 0;
  const shares = (Array.isArray(body.shares) ? body.shares : []).filter(s => Number.isInteger(s.user_id) && s.user_id !== me.id).slice(0, 100);
  await db.batch([
    db.prepare('UPDATE lists SET share_all = ?, updated_at = ? WHERE id = ?').bind(shareAll, Date.now(), id),
    db.prepare('DELETE FROM list_shares WHERE list_id = ?').bind(id),
    ...shares.map(s => db.prepare('INSERT INTO list_shares (list_id, user_id, can_edit) VALUES (?, ?, ?)').bind(id, s.user_id, s.can_edit ? 1 : 0)),
  ]);
  return {};
}

async function saveSemis(db, me, id, body) {
  const l = await getList(db, id);
  if (!await canSeeList(db, me, l)) fail(403, 'No podés ver esta lista');
  const clean = {};
  for (const [k, v] of Object.entries(body || {})) if (Number.isInteger(v) && v >= -11 && v <= 11 && v !== 0) clean[String(k).slice(0, 40)] = v;
  await db.prepare('INSERT INTO list_semis (list_id, user_id, semis) VALUES (?, ?, ?) ON CONFLICT (list_id, user_id) DO UPDATE SET semis = excluded.semis')
    .bind(id, me.id, JSON.stringify(clean)).run();
  return {};
}

// ---------------------------------------------------------------- usuarios (administrador)

async function createUser(db, body) {
  const username = cleanUsername(body.username);
  const err = checkPasswordStrength(body.password);
  if (err) fail(400, err);
  const role = ROLES.includes(body.role) ? body.role : 'editor';
  const name = String(body.name || '').trim().slice(0, 80) || username;
  if (await db.prepare('SELECT 1 FROM users WHERE username = ?').bind(username).first()) fail(400, 'Ese usuario ya existe');
  const r = await db.prepare('INSERT INTO users (username, name, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id')
    .bind(username, name, await hashPassword(body.password), role, Date.now()).first();
  return { id: r.id };
}

async function updateUser(db, me, id, body) {
  const u = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!u) fail(404, 'El usuario no existe');
  if (id === me.id && (body.role && body.role !== 'admin' || body.disabled)) fail(400, 'No podés quitarte el rol de administrador ni desactivarte a vos mismo');
  const stmts = [];
  if (body.name !== undefined) stmts.push(db.prepare('UPDATE users SET name = ? WHERE id = ?').bind(String(body.name).trim().slice(0, 80) || u.username, id));
  if (body.role !== undefined) {
    if (!ROLES.includes(body.role)) fail(400, 'Rol inválido');
    stmts.push(db.prepare('UPDATE users SET role = ? WHERE id = ?').bind(body.role, id));
  }
  if (body.disabled !== undefined) {
    stmts.push(db.prepare('UPDATE users SET disabled = ? WHERE id = ?').bind(body.disabled ? 1 : 0, id));
    if (body.disabled) stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  }
  if (body.password !== undefined) {
    const err = checkPasswordStrength(body.password);
    if (err) fail(400, err);
    stmts.push(db.prepare('UPDATE users SET pass_hash = ?, failed = 0, locked_until = 0 WHERE id = ?').bind(await hashPassword(body.password), id));
    stmts.push(db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id));
  }
  if (stmts.length) await db.batch(stmts);
  return {};
}
