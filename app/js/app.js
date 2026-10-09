// Cancionero: app principal (rutas y vistas).
import { ApiStore } from './store.js';
import { APP_VERSION, API_BASE } from './config.js';
import { renderSong, fitToWidth, separateChords } from './render.js';
import { transposedKeyName } from './song.js';
import { keyName, setAccidentals } from './chords.js';
import { esc, debounce, formatDate, fold } from './util.js';
import { toast, openDialog, confirmDialog, formDialog } from './ui.js';
import { renderEditor, VIS_OPTIONS } from './editor.js';

// ---------------------------------------------------------------- ajustes (de cada dispositivo)

const SETTINGS_KEY = 'cancionero.settings';
const settings = Object.assign(
  { notation: 'latin', accidentals: 'sharp', theme: 'light', songSize: 18, fit: true, wakeLock: true },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; } })(),
);
const saveSettings = () => { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); applySettings(); };
function applySettings() {
  document.documentElement.style.setProperty('--song-size', settings.songSize + 'px');
  setAccidentals(settings.accidentals);
  document.documentElement.dataset.theme = settings.theme;
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', settings.theme === 'dark' ? '#000000' : '#ffffff');
  const nt = document.getElementById('nightToggle');
  if (nt) nt.checked = settings.theme === 'dark';
}

const ROLE_NAMES = { admin: 'Administrador', editor: 'Usuario' };
const VIS_SHORT = { private: '', title: 'título visible', public: 'visible para todos' };

// ---------------------------------------------------------------- arranque

const $ = s => document.querySelector(s);
const view = $('#view');
let store, current = null;
const tempSemis = new Map(); // transporte temporal (fuera de listas) mientras la app está abierta

const isDesktop = location.protocol === 'app:';
const isLocalDev = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

async function boot() {
  applySettings();
  store = new ApiStore(API_BASE);
  store.loadCache();
  let lastRole = store.me?.role;
  store.addEventListener('change', () => {
    updateChrome();
    // si el administrador le cambió el rol, rehacer la pantalla con los permisos nuevos
    if (store.me?.role !== lastRole) { lastRole = store.me?.role; if (!current?.isDirty?.()) { route(); return; } }
    current?.onStoreChange?.();
  });
  store.addEventListener('status', updateSyncDot);
  store.addEventListener('auth', () => { toast('La sesión venció. Volvé a ingresar.'); route(); });
  setupChrome();
  window.addEventListener('hashchange', route);
  route();
  if (store.loggedIn) store.sync();
  window.addEventListener('focus', () => store.sync());
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    store.sync();
    if (current?.wake) requestWakeLock();
  });
  if (!isDesktop && !isLocalDev && 'serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}

function updateSyncDot() {
  const d = $('#syncDot');
  d.className = 'sync-dot ' + store.status;
  d.title = store.status === 'error' ? 'Error al sincronizar: ' + (store.error?.message || '') : store.status === 'ok' ? 'Sincronizado' : 'Sincronizando…';
  if (store.status === 'error') toast('No se pudo sincronizar (se usan las canciones guardadas)');
}

// ---------------------------------------------------------------- barra superior, menú y buscador

function updateChrome() {
  document.body.classList.toggle('logged-out', !store.loggedIn);
  $('#drawerUser').textContent = store.me ? `${store.me.name} · ${ROLE_NAMES[store.me.role] || ''}` : '';
  $('#navUsers').hidden = !store.isAdmin;
  $('#navNew').hidden = !store.canEditSongs;
  $('#logoutBtn').hidden = !store.loggedIn;
  const n = store.requests.incoming.length;
  $('#reqBadge').textContent = n || '';
  $('#reqBadge').hidden = !n;
}

function setupChrome() {
  const drawer = $('#drawer');
  $('#menuBtn').onclick = () => { drawer.hidden = false; };
  drawer.onclick = e => { if (e.target === drawer || e.target.matches('a')) drawer.hidden = true; };
  $('#appVersion').textContent = 'Versión ' + APP_VERSION;
  const nt = $('#nightToggle');
  nt.checked = settings.theme === 'dark';
  nt.onchange = () => { settings.theme = nt.checked ? 'dark' : 'light'; saveSettings(); };
  $('#logoutBtn').onclick = async () => {
    drawer.hidden = true;
    if (!await confirmDialog('¿Cerrar sesión en este dispositivo?', 'Cerrar sesión')) return;
    await store.logout();
    location.hash = '#/';
    route();
  };
  $('#syncBtn').onclick = async () => { drawer.hidden = true; await store.sync(); toast(store.status === 'ok' ? 'Listo' : 'Error al sincronizar'); };
  updateChrome();

  const input = $('#search'), box = $('#searchResults');
  let sel = 0, results = [];
  const show = () => {
    if (current?.ownsSearch) { box.hidden = true; current.onSearch(input.value); return; }
    const q = input.value.trim();
    if (!q) { box.hidden = true; return; }
    results = store.search(q).slice(0, 40);
    sel = 0;
    box.innerHTML = results.length
      ? results.map((r, i) => `<div class="item${i === sel ? ' sel' : ''}" data-i="${i}"><span class="t">${esc(r.song.title)}${r.snippet ? `<small>${esc(r.snippet)}</small>` : ''}</span><span class="k">${esc(keyName(r.song.key, settings.notation))}</span></div>`).join('')
      : '<div class="empty">No hay canciones con ese texto</div>';
    box.hidden = false;
  };
  const pick = i => {
    const r = results[i];
    if (!r) return;
    input.value = '';
    box.hidden = true;
    input.blur();
    location.hash = songHash(r.song.path);
  };
  input.addEventListener('input', show);
  input.addEventListener('focus', () => { if (input.value) show(); });
  input.addEventListener('keydown', e => {
    if (current?.ownsSearch) { if (e.key === 'Enter') current.onSearchEnter?.(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      sel = Math.max(0, Math.min(results.length - 1, sel + (e.key === 'ArrowDown' ? 1 : -1)));
      box.querySelectorAll('.item').forEach((n, i) => n.classList.toggle('sel', i === sel));
      box.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') pick(sel);
    else if (e.key === 'Escape') { input.value = ''; box.hidden = true; input.blur(); }
  });
  box.addEventListener('pointerdown', e => { e.preventDefault(); const it = e.target.closest('[data-i]'); if (it) pick(+it.dataset.i); });
  document.addEventListener('pointerdown', e => { if (!e.target.closest('.search-wrap')) box.hidden = true; });

  // atajo: "/" o Ctrl+K enfoca el buscador (PC)
  document.addEventListener('keydown', e => {
    if ((e.key === '/' && !e.target.closest('input,textarea')) || (e.key.toLowerCase() === 'k' && e.ctrlKey)) { e.preventDefault(); input.focus(); input.select(); }
  });
}

const songHash = path => '#/c/' + encodeURIComponent(path);
const listHash = (lpath, i) => '#/lista/' + encodeURIComponent(lpath) + (i !== undefined ? '/' + i : '');

// ---------------------------------------------------------------- rutas

let lastHash = location.hash;
function route() {
  if (current?.isDirty?.() && !confirm('¿Salir sin guardar los cambios?')) { history.replaceState(null, '', lastHash || '#/'); return; }
  lastHash = location.hash;
  current?.leave?.();
  releaseWakeLock();
  updateChrome();
  const h = decodeURIComponent(location.hash.slice(1) || '/');
  const parts = h.split('/').filter(Boolean);
  const search = $('#search');
  search.value = '';
  $('#searchResults').hidden = true;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + h));
  window.scrollTo(0, 0);

  if (!store.loggedIn) current = loginView();
  else if (!parts.length) current = songsView();
  else if (parts[0] === 'c') current = songView(parts.slice(1).join('/'));
  else if (parts[0] === 'listas') current = listsView();
  else if (parts[0] === 'lista' && parts.length >= 4) current = songView(null, parts.slice(1, 3).join('/'), +parts[3]);
  else if (parts[0] === 'lista') current = listView(parts.slice(1, 3).join('/'));
  else if (parts[0] === 'editar' && store.canEditSongs) current = editorView(parts.slice(1).join('/'));
  else if (parts[0] === 'nueva' && store.canEditSongs) current = editorView(null);
  else if (parts[0] === 'ajustes') current = settingsView();
  else if (parts[0] === 'usuarios' && store.isAdmin) current = usersView();
  else if (parts[0] === 'pedidos') current = requestsView();
  else current = songsView();
  search.placeholder = current.ownsSearch ? 'Filtrar canciones…' : 'Buscar canción…';
}

// ---------------------------------------------------------------- vista: ingreso

function loginView() {
  view.innerHTML = '<div class="page login"><div class="empty">Conectando…</div></div>';
  let alive = true;
  const draw = needsSetup => {
    if (!alive) return;
    view.innerHTML = `<div class="page login">
      <div class="login-box">
        <img src="icons/icon.svg" alt="" class="login-logo">
        <h1>Cancionero</h1>
        ${needsSetup ? '<p class="hint">Primera vez: creá el usuario <b>administrador</b>. Con ese usuario después vas a dar de alta a los demás integrantes del coro.</p>' : ''}
        <form>
          <label class="field"><span>Usuario</span><input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required autofocus></label>
          ${needsSetup ? '<label class="field"><span>Tu nombre (como lo van a ver los demás)</span><input name="name" required></label>' : ''}
          <label class="field"><span>Contraseña</span><input name="password" type="password" autocomplete="${needsSetup ? 'new-password' : 'current-password'}" required></label>
          ${needsSetup ? '<label class="field"><span>Repetí la contraseña</span><input name="password2" type="password" autocomplete="new-password" required></label>' : ''}
          <p class="login-error" hidden></p>
          <button class="btn primary login-btn">${needsSetup ? 'Crear administrador' : 'Ingresar'}</button>
        </form>
        ${needsSetup ? '' : '<p class="hint">¿No tenés usuario o te olvidaste la contraseña? Pedíselo al administrador del cancionero.</p>'}
      </div></div>`;
    const form = view.querySelector('form'), errEl = view.querySelector('.login-error');
    form.onsubmit = async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(form));
      errEl.hidden = true;
      if (needsSetup && f.password !== f.password2) { errEl.textContent = 'Las contraseñas no coinciden'; errEl.hidden = false; return; }
      const btn = form.querySelector('button');
      btn.disabled = true;
      try {
        if (needsSetup) await store.setup(f.username, f.name, f.password);
        else await store.login(f.username, f.password);
        await store.sync();
        location.hash = '#/';
        route();
      } catch (err) {
        errEl.textContent = err.message;
        errEl.hidden = false;
        btn.disabled = false;
      }
    };
  };
  store.needsSetup().then(draw).catch(() => {
    if (!alive) return;
    draw(false);
    toast('No se pudo conectar con el servidor. Revisá la conexión a internet.', 4000);
  });
  return { leave: () => { alive = false; } };
}

// ---------------------------------------------------------------- vista: todas las canciones

// pestaña elegida en la lista de canciones (se recuerda mientras la app está abierta)
let songsTab = null;

function songsView() {
  let q = '';
  const tabResults = () => {
    const all = store.search(q);
    const mine = all.filter(r => r.song.mine), shared = all.filter(r => !r.song.mine);
    const fq = fold(q).trim();
    const others = store.catalog.filter(c => !fq || fold(c.title).includes(fq)).sort((a, b) => fold(a.title).localeCompare(fold(b.title)));
    return { mine, shared, others };
  };
  const render = () => {
    const r = tabResults();
    const nMine = [...store.songs.values()].filter(s => s.mine).length;
    const nShared = store.songs.size - nMine;
    if (!songsTab) songsTab = nMine || !nShared ? 'mine' : 'shared';
    const tab = (id, label, n) => `<button class="tab${songsTab === id ? ' on' : ''}" data-tab="${id}">${label} <span class="count">${n}</span></button>`;
    const songRow = x => `<li><a class="item" href="${songHash(x.song.path)}"><span class="t">${esc(x.song.title)}${x.snippet ? `<small>${esc(x.snippet)}</small>` : ''}${songsTab === 'shared' ? `<small>de ${esc(x.song.owner_name)}</small>` : ''}${songsTab === 'mine' && VIS_SHORT[x.song.visibility] ? `<small class="vis">${VIS_SHORT[x.song.visibility]}</small>` : ''}</span><span class="k">${esc(keyName(x.song.key, settings.notation))}</span></a></li>`;
    const otherRow = c => `<li class="item"><span class="t">🔒 ${esc(c.title)}<small>de ${esc(c.owner_name)}</small></span>${c.copied ? '<span class="hint">ya tenés una copia</span>' : c.requested ? '<span class="hint">pedido enviado</span>' : `<button class="btn small" data-request="${esc(c.slug)}">Pedir copia</button>`}</li>`;
    let body;
    if (songsTab === 'mine') {
      body = r.mine.length ? `<ul class="items">${r.mine.map(songRow).join('')}</ul>`
        : `<div class="empty">${q ? 'Ninguna de tus canciones coincide.' : 'Todavía no tenés canciones propias. Creá una con "+ Nueva" o agregá a tus canciones una que te hayan compartido.'}</div>`;
    } else if (songsTab === 'shared') {
      body = r.shared.length ? `<ul class="items">${r.shared.map(songRow).join('')}</ul>`
        : `<div class="empty">${q ? 'Ninguna coincide.' : 'Acá aparecen las canciones de otros que podés ver: las de listas que te compartieron y las que sus dueños hicieron visibles.'}</div>`;
    } else {
      body = r.others.length ? `<p class="hint">De estas canciones sólo se ve el título. Si querés una, pedile una copia al dueño.</p><ul class="items">${r.others.map(otherRow).join('')}</ul>`
        : `<div class="empty">${q ? 'Ninguna coincide.' : 'No hay canciones de otros con el título visible.'}</div>`;
    }
    view.innerHTML = `<div class="page">
      <div class="page-head"><h1>Canciones</h1>
        <div class="row">${songsTab === 'mine' && r.mine.length ? '<button class="btn small" data-act="vis">Quién las ve…</button>' : ''}<a class="btn" href="#/nueva">+ Nueva</a></div></div>
      <div class="tabs">${tab('mine', 'Mías', nMine)}${tab('shared', 'Compartidas conmigo', nShared)}${tab('others', 'Otras', store.catalog.length)}</div>
      ${!store.songs.size && !store.catalog.length && store.status !== 'ok' ? '<div class="empty">Cargando canciones…</div>' : body}
    </div>`;
  };
  const onClick = async e => {
    const t = e.target.closest('[data-tab]');
    if (t) { songsTab = t.dataset.tab; render(); return; }
    const rq = e.target.closest('[data-request]');
    if (rq) {
      rq.disabled = true;
      try { await store.requestCopy(rq.dataset.request); toast('Pedido enviado. Cuando el dueño lo apruebe, la copia aparece en "Mías".'); }
      catch (err) { toast(err.message); rq.disabled = false; }
      return;
    }
    if (e.target.closest('[data-act=vis]')) bulkVisibility(tabResults().mine.map(x => x.song.path), q);
  };
  view.addEventListener('click', onClick);
  render();
  return {
    ownsSearch: true,
    onSearch: v => { q = v; render(); },
    onSearchEnter: () => { const r = store.search(q)[0]; if (r) location.hash = songHash(r.song.path); },
    onStoreChange: render,
    leave: () => view.removeEventListener('click', onClick),
  };
}

async function bulkVisibility(slugs, q) {
  const v = await openDialog((d, close) => {
    d.innerHTML = `<h2>Quién puede ver estas canciones</h2>
      <p class="hint" style="margin-top:0">Se aplica a ${q ? `las <b>${slugs.length}</b> canciones tuyas que coinciden con "${esc(q)}"` : `<b>todas</b> tus canciones (${slugs.length})`}. Para cambiar sólo algunas, escribí primero en el buscador de arriba.</p>
      ${VIS_OPTIONS.map(([val, t]) => `<label class="row vis-opt"><input type="radio" name="v" value="${val}"> ${esc(t)}</label>`).join('')}
      <p class="hint">Las canciones de las listas que compartas igual las ven las personas con las que compartiste la lista.</p>
      <div class="actions"><button class="btn" data-x>Cancelar</button><button class="btn primary" data-ok>Aplicar</button></div>`;
    d.querySelector('[data-x]').onclick = () => close(null);
    d.querySelector('[data-ok]').onclick = () => close(d.querySelector('input:checked')?.value || null);
  });
  if (!v) return;
  try { const n = await store.setVisibility(slugs, v); toast(`Listo: ${n} canciones actualizadas`); }
  catch (e) { toast('No se pudo cambiar: ' + e.message); }
}

// ---------------------------------------------------------------- vista: canción

function songView(path, lpath = null, idx = 0) {
  let list = lpath ? store.lists.get(lpath) : null;
  if (lpath && !list) { view.innerHTML = `<div class="page empty">Lista no encontrada</div>`; return { onStoreChange: () => route() }; }
  let item = list ? list.items[idx] : null;
  if (list) path = item?.song;
  let semis = item ? (item.semis || 0) : (tempSemis.get(path) || 0);
  let entry = store.songs.get(path);

  // el tono dentro de una lista es personal: se guarda sólo para este usuario
  const saveListSemis = debounce(async () => {
    try { await store.saveListSemis(list); } catch (e) { toast('No se pudo guardar el tono en la lista'); }
  }, 800);

  const setSemis = s => {
    semis = ((s % 12) + 12) % 12;
    if (semis > 6) semis -= 12;
    if (item) { item.semis = semis; saveListSemis(); }
    else tempSemis.set(path, semis);
    render();
  };

  const render = () => {
    entry = store.songs.get(path);
    if (!entry) {
      view.innerHTML = `<div class="page empty">${store.status === 'syncing' ? 'Cargando…' : 'No se encontró la canción.'}</div>`;
      return;
    }
    const k = entry.key;
    const shown = transposedKeyName(k, semis, settings.notation);
    view.innerHTML = `<div class="song-page">
      <div class="song-title">${esc(entry.title)}</div>
      ${entry.mine ? '' : `<div class="song-owner">de ${esc(entry.owner_name)} · sólo lectura</div>`}
      <div class="song-tools">
        <span class="keybox"><button data-act="down" aria-label="Bajar medio tono">−</button><button class="key" data-act="keys">${esc(shown || '—')}</button><button data-act="up" aria-label="Subir medio tono">+</button></span>
        <span class="orig">${semis ? `${semis > 0 ? '+' : ''}${semis} · original ${esc(keyName(k, settings.notation))} <button data-act="reset">volver</button>` : 'tono original'}</span>
        <span class="spacer"></span>
        <span class="size-btns row">${settings.fit ? '' : '<button data-act="fit" aria-label="Ajustar al ancho" title="Ajustar al ancho de la pantalla">↔</button>'}<button data-act="smaller" aria-label="Letra más chica">A−</button><button data-act="bigger" aria-label="Letra más grande">A+</button></span>
        ${entry.mine ? `<a class="btn small" href="#/editar/${encodeURIComponent(path)}">Editar</a>` : '<button class="btn small" data-act="copy">Agregar a mis canciones</button>'}
        ${isDesktop || matchMedia('(min-width: 900px)').matches ? '<button class="btn small" data-act="print">Imprimir</button>' : ''}
        <button class="btn small" data-act="addlist">+ Lista</button>
      </div>
      <div class="song${settings.fit ? ' fit' : ''}">${renderSong(entry.song, { semis, notation: settings.notation, origKey: k })}</div>
    </div>
    ${list ? listBar() : ''}`;
    layout();
  };

  const layout = () => {
    const el = view.querySelector('.song');
    if (!el) return;
    if (settings.fit) fitToWidth(el);
    else { el.style.fontSize = settings.songSize + 'px'; separateChords(el); }
  };
  const onResize = debounce(layout, 120);
  window.addEventListener('resize', onResize);
  document.fonts?.ready.then(() => layout());

  const listBar = () => {
    const prev = list.items[idx - 1], next = list.items[idx + 1];
    const t = it => esc(store.songs.get(it?.song)?.title || '');
    return `<div class="listbar">
      <button class="nav" data-go="${idx - 1}" ${prev ? '' : 'disabled'}>‹ ${prev ? t(prev) : ''}</button>
      <a class="mid" href="${listHash(lpath)}"><b>${esc(list.name)}</b>${idx + 1} de ${list.items.length}${item?.label ? ' · ' + esc(item.label) : ''}</a>
      <button class="nav" data-go="${idx + 1}" ${next ? '' : 'disabled'}>${next ? t(next) : ''} ›</button>
    </div>`;
  };

  const onClick = async e => {
    const b = e.target.closest('[data-act],[data-go]');
    if (!b) return;
    if (b.dataset.go !== undefined) { location.hash = listHash(lpath, +b.dataset.go); return; }
    const a = b.dataset.act;
    if (a === 'up') setSemis(semis + 1);
    else if (a === 'down') setSemis(semis - 1);
    else if (a === 'reset') setSemis(0);
    else if (a === 'keys') { const s = await pickKey(entry.key, semis); if (s !== undefined) setSemis(s); }
    else if (a === 'fit') { settings.fit = true; saveSettings(); render(); }
    else if (a === 'bigger' || a === 'smaller') {
      const cur = settings.fit ? parseFloat(view.querySelector('.song').style.fontSize) || settings.songSize : settings.songSize;
      settings.fit = false;
      settings.songSize = Math.max(10, Math.min(48, Math.round(cur) + (a === 'bigger' ? 2 : -2)));
      render();
      saveSettings();
    }
    else if (a === 'print') window.print();
    else if (a === 'addlist') addToListDialog(path, semis);
    else if (a === 'copy') {
      if (!await confirmDialog(`¿Agregar "${entry.title}" a tus canciones? Se crea una copia tuya que podés editar; la de ${entry.owner_name} no cambia.`, 'Agregar')) return;
      try { const slug = await store.copySong(path); toast('Agregada a tus canciones'); location.hash = songHash(slug); }
      catch (err) { toast('No se pudo copiar: ' + err.message); }
    }
  };
  view.addEventListener('click', onClick);

  // deslizar a izquierda/derecha para cambiar de canción dentro de una lista
  let sx = 0, sy = 0;
  const ts = e => { sx = e.touches[0].clientX; sy = e.touches[0].clientY; };
  const te = e => {
    if (!list) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) > 90 && Math.abs(dy) < 50) {
      const to = idx + (dx < 0 ? 1 : -1);
      if (list.items[to]) location.hash = listHash(lpath, to);
    }
  };
  view.addEventListener('touchstart', ts, { passive: true });
  view.addEventListener('touchend', te, { passive: true });

  render();
  if (settings.wakeLock) requestWakeLock();
  return {
    wake: settings.wakeLock,
    onStoreChange: () => {
      if (!list) { render(); return; }
      // la lista se reconstruye al sincronizar: tomar la versión nueva
      list = store.lists.get(lpath);
      if (!list) return;
      item = list.items[idx];
      render();
    },
    leave: () => { window.removeEventListener('resize', onResize); view.removeEventListener('click', onClick); view.removeEventListener('touchstart', ts); view.removeEventListener('touchend', te); },
  };
}

function pickKey(origKey, semis) {
  return openDialog((d, close) => {
    const cur = ((semis % 12) + 12) % 12;
    let btns = '';
    for (let s = 0; s < 12; s++) {
      btns += `<button data-s="${s}" class="${s === cur ? 'cur' : ''} ${s === 0 ? 'orig-k' : ''}">${esc(transposedKeyName(origKey, s, settings.notation) || (s ? '+' + s : '0'))}</button>`;
    }
    d.innerHTML = `<h2>Elegí el tono</h2><p class="hint" style="margin-top:0">El tono con borde es el original (${esc(keyName(origKey, settings.notation))}).</p>
      <div class="keygrid">${btns}</div><div class="actions"><button class="btn" data-x>Cerrar</button></div>`;
    d.onclick = e => {
      if (e.target.closest('[data-x]')) close(undefined);
      const b = e.target.closest('[data-s]');
      if (b) close(+b.dataset.s);
    };
  });
}

async function addToListDialog(path, semis) {
  const lists = store.listList().filter(l => l.canEdit);
  const chosen = await openDialog((d, close) => {
    d.innerHTML = `<h2>Agregar a una lista</h2>
      <ul class="items">${lists.map(l => `<li class="item" data-p="${esc(l.path)}"><span class="t">${esc(l.name)}<small>${esc(formatDate(l.date))}${l.mine ? '' : ' · de ' + esc(l.owner_name)}</small></span><span class="count">${l.items.length}</span></li>`).join('') || '<div class="empty">No hay listas todavía</div>'}</ul>
      <div class="actions"><button class="btn" data-x>Cancelar</button><button class="btn primary" data-new>+ Nueva lista</button></div>`;
    d.onclick = e => {
      if (e.target.closest('[data-x]')) close(null);
      else if (e.target.closest('[data-new]')) close('new');
      else { const it = e.target.closest('[data-p]'); if (it) close(it.dataset.p); }
    };
  });
  if (!chosen) return;
  let list;
  if (chosen === 'new') {
    const f = await newListDialog();
    if (!f) return;
    list = { name: f.name, date: f.date, items: [] };
  } else list = store.lists.get(chosen);
  list.items.push({ song: path, semis });
  try {
    await store.saveList(list);
    if (list.id && semis) await store.saveListSemis(list);
    toast(`Agregada a "${list.name}"`);
  } catch (e) { toast('No se pudo guardar: ' + e.message); }
}

async function newListDialog() {
  const f = await formDialog('Nueva lista', [{ name: 'name', label: 'Nombre', placeholder: 'Misa del sábado' }, { name: 'date', label: 'Fecha', type: 'date', value: nextSaturday() }], 'Crear');
  if (!f || !f.name.trim()) return null;
  return { name: f.name.trim(), date: f.date };
}

function nextSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- vista: listas

function shareLabel(l) {
  if (!l.mine) return `de ${l.owner_name}${l.canEdit ? '' : ' · sólo lectura'}`;
  if (l.share_all === 2) return 'compartida con todos (pueden editar)';
  if (l.share_all === 1) return 'compartida con todos';
  if (l.shares.length) return `compartida con ${l.shares.length} persona${l.shares.length > 1 ? 's' : ''}`;
  return 'personal';
}

function listsView() {
  const render = () => {
    const today = new Date().toISOString().slice(0, 10);
    const all = store.listList();
    const upcoming = all.filter(l => (l.date || '') >= today).reverse();
    const past = all.filter(l => (l.date || '') < today);
    const li = l => `<li><a class="item" href="${listHash(l.path)}"><span class="t">${esc(l.name)}<small>${esc(formatDate(l.date))} · ${esc(shareLabel(l))}</small></span><span class="count">${l.items.length} canc.</span></a></li>`;
    view.innerHTML = `<div class="page">
      <div class="page-head"><h1>Listas</h1><button class="btn primary" data-new>+ Nueva lista</button></div>
      ${!all.length ? '<div class="empty">Armá una lista para la próxima misa o evento: tocá "+ Nueva lista".</div>' : ''}
      ${upcoming.length ? `<h3 class="count">Próximas</h3><ul class="items">${upcoming.map(li).join('')}</ul>` : ''}
      ${past.length ? `<h3 class="count">Anteriores</h3><ul class="items">${past.map(li).join('')}</ul>` : ''}
    </div>`;
    view.querySelector('[data-new]').onclick = async () => {
      const f = await newListDialog();
      if (!f) return;
      try {
        const p = await store.saveList({ name: f.name, date: f.date, items: [] });
        location.hash = listHash(p);
      } catch (e) { toast('No se pudo crear: ' + e.message); }
    };
  };
  render();
  return { onStoreChange: render };
}

function listView(lpath) {
  const save = async list => { try { await store.saveList(list); } catch (e) { toast('No se pudo guardar: ' + e.message); } };
  let dragFrom = null;

  const render = () => {
    const list = store.lists.get(lpath);
    if (!list) { view.innerHTML = `<div class="page empty">Lista no encontrada. <a href="#/listas">Volver</a></div>`; return; }
    const ed = list.canEdit;
    view.innerHTML = `<div class="page setlist">
      <div class="page-head"><div><h1 style="margin-bottom:2px">${esc(list.name)}</h1><div class="count">${esc(formatDate(list.date))} · ${esc(shareLabel(list))}</div></div>
        <div class="row">
          ${list.mine ? '<button class="btn small" data-act="share">Compartir</button>' : ''}
          ${ed ? '<button class="btn small" data-act="edit">Renombrar</button>' : ''}
          ${list.mine || store.isAdmin ? '<button class="btn small danger" data-act="del">Eliminar</button>' : ''}
        </div></div>
      <div class="row" style="margin:14px 0 6px">
        ${ed ? '<button class="btn primary" data-act="add">+ Agregar canciones</button>' : ''}
        ${list.items.length ? `<a class="btn" href="${listHash(lpath, 0)}">▶ Empezar</a>` : ''}
      </div>
      ${list.mine ? '' : '<p class="hint">El tono que elijas en cada canción es sólo para vos: no le cambia nada a los demás.</p>'}
      <ul class="items">${list.items.map((it, i) => {
        const s = store.songs.get(it.song);
        const k = s ? transposedKeyName(s.key, it.semis || 0, settings.notation) : '';
        return `<li class="item" ${ed ? 'draggable="true"' : ''} data-i="${i}">
          <span class="num">${i + 1}</span>
          <a class="t" href="${listHash(lpath, i)}" style="text-decoration:none">${it.label ? `<small class="label">${esc(it.label)}</small>` : ''}${s ? esc(s.title) : list.titles[it.song] ? `${esc(list.titles[it.song])} <span class="hint">(no disponible para vos)</span>` : '(canción borrada)'}${it.semis ? `<small>${it.semis > 0 ? '+' : ''}${it.semis} desde el original</small>` : ''}</a>
          <span class="k">${esc(k)}</span>
          ${ed ? '<span class="acts"><button data-act="label" title="Etiqueta (ej: Entrada)">✎</button><button data-act="up" title="Subir">↑</button><button data-act="downi" title="Bajar">↓</button><button data-act="rm" title="Quitar">✕</button></span>' : ''}
        </li>`;
      }).join('') || '<div class="empty">Lista vacía</div>'}</ul>
    </div>`;
  };

  const onClick = async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const list = store.lists.get(lpath);
    const i = +b.closest('[data-i]')?.dataset.i;
    const a = b.dataset.act;
    if (a === 'add') return addSongsDialog(list, save);
    if (a === 'share') return shareDialog(list);
    if (a === 'edit') {
      const f = await formDialog('Editar lista', [{ name: 'name', label: 'Nombre', value: list.name }, { name: 'date', label: 'Fecha', type: 'date', value: list.date }]);
      if (f && f.name.trim()) { list.name = f.name.trim(); list.date = f.date; save(list); }
      return;
    }
    if (a === 'del') {
      const extra = list.mine && (list.share_all || list.shares.length) ? ' También desaparece para las personas con las que la compartiste.' : '';
      if (await confirmDialog(`¿Eliminar la lista "${list.name}"?${extra}`, 'Eliminar', true)) {
        try { await store.deleteList(list); location.hash = '#/listas'; } catch (err) { toast(err.message); }
      }
      return;
    }
    if (a === 'up' && i > 0) [list.items[i - 1], list.items[i]] = [list.items[i], list.items[i - 1]];
    else if (a === 'downi' && i < list.items.length - 1) [list.items[i + 1], list.items[i]] = [list.items[i], list.items[i + 1]];
    else if (a === 'rm') list.items.splice(i, 1);
    else if (a === 'label') {
      const f = await formDialog('Etiqueta', [{ name: 'label', label: 'Momento de la misa u otra nota', value: list.items[i].label || '', placeholder: 'Entrada, Gloria, Ofertorio, Comunión…' }]);
      if (f === null) return;
      list.items[i].label = f.label.trim() || undefined;
    } else return;
    render();
    save(list);
  };
  // arrastrar para reordenar (PC)
  const onDragStart = e => { const li = e.target.closest('[data-i]'); if (li) { dragFrom = +li.dataset.i; li.classList.add('dragging'); } };
  const onDragOver = e => { if (dragFrom !== null && e.target.closest('[data-i]')) e.preventDefault(); };
  const onDrop = e => {
    const li = e.target.closest('[data-i]');
    if (!li || dragFrom === null) return;
    e.preventDefault();
    const list = store.lists.get(lpath);
    const [it] = list.items.splice(dragFrom, 1);
    list.items.splice(+li.dataset.i, 0, it);
    dragFrom = null;
    render();
    save(list);
  };
  const onDragEnd = () => { dragFrom = null; view.querySelector('.dragging')?.classList.remove('dragging'); };
  view.addEventListener('click', onClick);
  view.addEventListener('dragstart', onDragStart);
  view.addEventListener('dragover', onDragOver);
  view.addEventListener('drop', onDrop);
  view.addEventListener('dragend', onDragEnd);
  render();
  return {
    onStoreChange: render,
    leave: () => {
      view.removeEventListener('click', onClick);
      view.removeEventListener('dragstart', onDragStart);
      view.removeEventListener('dragover', onDragOver);
      view.removeEventListener('drop', onDrop);
      view.removeEventListener('dragend', onDragEnd);
    },
  };
}

function addSongsDialog(list, save) {
  let added = 0;
  return openDialog((d, close) => {
    d.innerHTML = `<h2>Agregar canciones a "${esc(list.name)}"</h2>
      <input class="field" style="width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font-size:16px;background:var(--bg)" placeholder="Buscar…" autofocus>
      <ul class="items" style="max-height:50vh;overflow:auto"></ul>
      <div class="actions"><span class="hint" style="margin-right:auto" data-n></span><button class="btn primary" data-x>Listo</button></div>`;
    const input = d.querySelector('input'), ul = d.querySelector('ul');
    const draw = () => {
      ul.innerHTML = store.search(input.value).slice(0, 60).map(r => {
        const n = list.items.filter(it => it.song === r.song.path).length;
        return `<li class="item" data-p="${esc(r.song.path)}"><span class="t">${esc(r.song.title)}${r.snippet ? `<small>${esc(r.snippet)}</small>` : ''}</span><span class="k">${n ? '✓' : '+'}</span></li>`;
      }).join('');
    };
    input.oninput = draw;
    d.onclick = e => {
      if (e.target.closest('[data-x]')) { close(); return; }
      const it = e.target.closest('[data-p]');
      if (!it) return;
      list.items.push({ song: it.dataset.p, semis: 0 });
      added++;
      d.querySelector('[data-n]').textContent = `${added} agregada${added > 1 ? 's' : ''}`;
      save(list);
      draw();
    };
    draw();
  });
}

async function shareDialog(list) {
  let users;
  try { users = (await store.directory()).filter(u => u.id !== store.me.id); }
  catch (e) { toast('No se pudo cargar la lista de usuarios: ' + e.message); return; }
  const cur = new Map(list.shares.map(s => [s.user_id, s.can_edit ? 2 : 1]));
  const opt = (v, sel) => ['No', 'Puede ver', 'Puede editar'].map((t, i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${t}</option>`).join('');
  const res = await openDialog((d, close) => {
    d.innerHTML = `<h2>Compartir "${esc(list.name)}"</h2>
      <label class="field"><span><b>Todo el coro</b> (incluye a los que se sumen después)</span><select name="all">${opt(0, list.share_all)}</select></label>
      ${users.length ? `<p class="hint" style="margin:14px 0 6px">O elegí personas:</p>
      ${users.map(u => `<label class="field share-row"><span>${esc(u.name)} <small>(${esc(u.username)})</small></span><select data-u="${u.id}">${opt(0, cur.get(u.id) || 0)}</select></label>`).join('')}`
      : '<p class="hint">Todavía no hay otros usuarios. Los crea el administrador desde el menú → Usuarios.</p>'}
      <p class="hint">"Puede editar" = agregar, quitar y ordenar canciones. Borrar la lista sólo puede quien la creó. El tono de cada uno es personal.</p>
      <div class="actions"><button class="btn" data-x>Cancelar</button><button class="btn primary" data-ok>Guardar</button></div>`;
    d.querySelector('[data-x]').onclick = () => close(null);
    d.querySelector('[data-ok]').onclick = () => close({
      all: +d.querySelector('[name=all]').value,
      shares: [...d.querySelectorAll('[data-u]')].filter(s => +s.value > 0).map(s => ({ user_id: +s.dataset.u, can_edit: +s.value === 2 })),
    });
  });
  if (!res) return;
  try { await store.shareList(list, res.all, res.shares); toast('Listo'); }
  catch (e) { toast('No se pudo compartir: ' + e.message); }
}

// ---------------------------------------------------------------- vista: editor

function editorView(path) {
  return renderEditor(view, { store, path, settings, onSaved: p => { location.hash = songHash(p); }, onCancel: () => history.back() });
}

// ---------------------------------------------------------------- vista: usuarios (administrador)

function usersView() {
  let alive = true;
  const render = async () => {
    let users;
    try { users = await store.listUsers(); }
    catch (e) { if (alive) view.innerHTML = `<div class="page empty">No se pudieron cargar los usuarios: ${esc(e.message)}</div>`; return; }
    if (!alive) return;
    view.innerHTML = `<div class="page">
      <div class="page-head"><h1>Usuarios</h1><button class="btn primary" data-act="new">+ Nuevo usuario</button></div>
      <p class="hint"><b>Administrador</b>: además de lo de cualquier usuario, crea usuarios y reinicia contraseñas. <b>Usuario</b>: tiene sus propias canciones y listas, y ve lo que otros le comparten.</p>
      <ul class="items">${users.map(u => `<li class="item user-row${u.disabled ? ' off' : ''}" data-id="${u.id}">
        <span class="t">${esc(u.name)}<small>${esc(u.username)}${u.disabled ? ' · desactivado' : ''}</small></span>
        <select data-role ${u.id === store.me.id ? 'disabled' : ''}>${Object.entries(ROLE_NAMES).map(([r, t]) => `<option value="${r}" ${r === u.role ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <button class="btn small" data-act="pass">Contraseña</button>
        ${u.id === store.me.id ? '' : `<button class="btn small ${u.disabled ? '' : 'danger'}" data-act="toggle">${u.disabled ? 'Activar' : 'Desactivar'}</button>`}
      </li>`).join('')}</ul>
    </div>`;
  };
  const act = async (fn, okMsg) => {
    try { await fn(); toast(okMsg); render(); } catch (e) { toast(e.message, 4000); }
  };
  const onClick = async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = +b.closest('[data-id]')?.dataset.id;
    const a = b.dataset.act;
    if (a === 'new') {
      const u = await newUserDialog();
      if (u) act(() => store.createUser(u), `Usuario "${u.username}" creado. Pasale el usuario y la contraseña.`);
    } else if (a === 'pass') {
      const f = await formDialog('Nueva contraseña', [{ name: 'password', label: 'Contraseña nueva (mínimo 6 caracteres)', type: 'text' }], 'Cambiar');
      if (f?.password) act(() => store.updateUser(id, { password: f.password }), 'Contraseña cambiada. Se cerraron sus sesiones abiertas.');
    } else if (a === 'toggle') {
      const off = !b.closest('.off');
      if (!off || await confirmDialog('¿Desactivar este usuario? No va a poder entrar hasta que lo actives de nuevo.', 'Desactivar', true)) {
        act(() => store.updateUser(id, { disabled: off }), off ? 'Usuario desactivado' : 'Usuario activado');
      }
    }
  };
  const onChange = e => {
    const sel = e.target.closest('[data-role]');
    if (!sel) return;
    act(() => store.updateUser(+sel.closest('[data-id]').dataset.id, { role: sel.value }), 'Rol cambiado');
  };
  view.addEventListener('click', onClick);
  view.addEventListener('change', onChange);
  render();
  return { leave: () => { alive = false; view.removeEventListener('click', onClick); view.removeEventListener('change', onChange); } };
}

function newUserDialog() {
  return openDialog((d, close) => {
    d.innerHTML = `<h2>Nuevo usuario</h2><form>
      <label class="field"><span>Usuario (para ingresar; sin espacios ni acentos)</span><input name="username" autocapitalize="none" spellcheck="false" required autofocus placeholder="ej: maria.perez"></label>
      <label class="field"><span>Nombre (como lo ven los demás)</span><input name="name" required placeholder="ej: María"></label>
      <label class="field"><span>Rol</span><select name="role"><option value="editor">Usuario</option><option value="admin">Administrador</option></select></label>
      <label class="field"><span>Contraseña inicial (mínimo 6 caracteres; después la puede cambiar)</span><input name="password" type="text" required minlength="6"></label>
      <div class="actions"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">Crear</button></div></form>`;
    d.querySelector('[data-x]').onclick = () => close(null);
    d.querySelector('form').onsubmit = e => { e.preventDefault(); close(Object.fromEntries(new FormData(e.target))); };
  });
}

// ---------------------------------------------------------------- vista: pedidos de copia

function requestsView() {
  const STATUS = { pending: 'esperando respuesta', approved: 'aprobado', denied: 'rechazado' };
  const render = () => {
    const { incoming, mine } = store.requests;
    view.innerHTML = `<div class="page">
      <h1>Pedidos</h1>
      <h3>Te piden una copia</h3>
      ${incoming.length ? `<ul class="items">${incoming.map(r => `<li class="item" data-id="${r.id}"><span class="t">${esc(r.title)}<small>${esc(r.requester_name)} · ${esc(new Date(r.created_at).toLocaleDateString('es-AR'))}</small></span>
        <button class="btn small primary" data-act="approve">Dar copia</button><button class="btn small" data-act="deny">Rechazar</button></li>`).join('')}</ul>`
        : '<p class="hint">No hay pedidos pendientes.</p>'}
      <h3 style="margin-top:26px">Lo que pediste</h3>
      ${mine.length ? `<ul class="items">${mine.map(r => `<li class="item"><span class="t">${esc(r.title)}<small>${STATUS[r.status]}</small></span>${r.status === 'approved' && r.copy_slug && store.songs.has(r.copy_slug) ? `<a class="btn small" href="${songHash(r.copy_slug)}">Abrir</a>` : ''}</li>`).join('')}</ul>`
        : '<p class="hint">Todavía no pediste ninguna canción. Las que se pueden pedir están en Canciones → Otras.</p>'}
      <p class="hint" style="margin-top:20px">Dar una copia le crea a esa persona su propia versión de la canción, que puede editar. Tu canción no cambia.</p>
    </div>`;
  };
  const onClick = async e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const id = +b.closest('[data-id]').dataset.id;
    b.disabled = true;
    try { await store.resolveRequest(id, b.dataset.act); toast(b.dataset.act === 'approve' ? 'Copia enviada' : 'Pedido rechazado'); }
    catch (err) { toast(err.message); b.disabled = false; }
  };
  view.addEventListener('click', onClick);
  render();
  store.sync();
  return { onStoreChange: render, leave: () => view.removeEventListener('click', onClick) };
}

// ---------------------------------------------------------------- vista: ajustes y cuenta

function settingsView() {
  view.innerHTML = `<div class="page">
    <h1>Ajustes</h1>
    <h3>Mi cuenta</h3>
    <p>${esc(store.me?.name || '')} <span class="hint">(${esc(store.me?.username || '')} · ${esc(ROLE_NAMES[store.me?.role] || '')})</span></p>
    <div class="row" style="margin-bottom:22px"><button class="btn" data-act="pass">Cambiar mi contraseña</button><button class="btn danger" data-act="logout">Cerrar sesión</button></div>
    <h3>Pantalla</h3>
    <label class="field"><span>Notación de acordes</span>
      <select name="notation"><option value="latin">Latina (DO, RE, MI…)</option><option value="us">Americana (C, D, E…)</option></select></label>
    <label class="field"><span>Alteraciones</span>
      <select name="accidentals"><option value="sharp">Sostenidos (DO#, FA#, LA#…)</option><option value="flat">Bemoles (REb, SOLb, SIb…)</option><option value="auto">Automático según el tono</option></select></label>
    <label class="row" style="margin-bottom:12px"><input name="night" type="checkbox" ${settings.theme === 'dark' ? 'checked' : ''}> Modo noche (fondo negro, letras blancas)</label>
    <label class="row" style="margin-bottom:18px"><input name="wakeLock" type="checkbox" ${settings.wakeLock ? 'checked' : ''}> Mantener la pantalla encendida al ver una canción</label>
    <p class="hint" style="margin-top:24px">${store.songs.size} canciones · ${store.lists.size} listas · versión ${esc(APP_VERSION)}</p>
  </div>`;
  view.querySelector('[name=notation]').value = settings.notation;
  view.querySelector('[name=notation]').onchange = e => { settings.notation = e.target.value; saveSettings(); };
  view.querySelector('[name=accidentals]').value = settings.accidentals;
  view.querySelector('[name=accidentals]').onchange = e => { settings.accidentals = e.target.value; saveSettings(); };
  view.querySelector('[name=night]').onchange = e => { settings.theme = e.target.checked ? 'dark' : 'light'; saveSettings(); };
  view.querySelector('[name=wakeLock]').onchange = e => { settings.wakeLock = e.target.checked; saveSettings(); };
  view.querySelector('[data-act=logout]').onclick = async () => {
    if (!await confirmDialog('¿Cerrar sesión en este dispositivo?', 'Cerrar sesión')) return;
    await store.logout();
    location.hash = '#/';
    route();
  };
  view.querySelector('[data-act=pass]').onclick = async () => {
    const f = await openDialog((d, close) => {
      d.innerHTML = `<h2>Cambiar mi contraseña</h2><form>
        <label class="field"><span>Contraseña actual</span><input name="old" type="password" autocomplete="current-password" required autofocus></label>
        <label class="field"><span>Contraseña nueva (mínimo 6 caracteres)</span><input name="new" type="password" autocomplete="new-password" required minlength="6"></label>
        <label class="field"><span>Repetí la nueva</span><input name="new2" type="password" autocomplete="new-password" required></label>
        <div class="actions"><button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">Cambiar</button></div></form>`;
      d.querySelector('[data-x]').onclick = () => close(null);
      d.querySelector('form').onsubmit = e => { e.preventDefault(); close(Object.fromEntries(new FormData(e.target))); };
    });
    if (!f) return;
    if (f.new !== f.new2) { toast('Las contraseñas nuevas no coinciden'); return; }
    try { await store.changePassword(f.old, f.new); toast('Contraseña cambiada'); } catch (e) { toast(e.message, 4000); }
  };
  return {};
}

// ---------------------------------------------------------------- pantalla encendida

let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* no soportado */ }
}
function releaseWakeLock() { wakeLock?.release().catch(() => {}); wakeLock = null; }

boot();
