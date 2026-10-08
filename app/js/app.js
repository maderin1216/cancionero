// Cancionero: app principal (rutas y vistas).
import { Store } from './store.js';
import { FsBackend, DevBackend, DropboxBackend } from './backends.js';
import { DROPBOX_APP_KEY } from './config.js';
import { renderSong, fitToWidth, separateChords } from './render.js';
import { transposedKeyName } from './song.js';
import { keyName } from './chords.js';
import { esc, debounce, formatDate } from './util.js';
import { toast, openDialog, confirmDialog, formDialog } from './ui.js';
import { renderEditor } from './editor.js';

// ---------------------------------------------------------------- ajustes

const SETTINGS_KEY = 'cancionero.settings';
const settings = Object.assign(
  { notation: 'latin', songSize: 18, fit: true, wakeLock: true, dropboxAppKey: '' },
  (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'); } catch { return {}; } })(),
);
const saveSettings = () => { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); applySettings(); };
function applySettings() {
  document.documentElement.style.setProperty('--song-size', settings.songSize + 'px');
}

// ---------------------------------------------------------------- arranque

const $ = s => document.querySelector(s);
const view = $('#view');
let store, backend, current = null;
const tempSemis = new Map(); // transporte temporal (fuera de listas) mientras la app está abierta

const isElectron = !!window.cancioneroFS;
const isLocalDev = !isElectron && /^(localhost|127\.0\.0\.1)$/.test(location.hostname) && !new URLSearchParams(location.search).has('dropbox');

async function boot() {
  applySettings();
  backend = isElectron ? new FsBackend(window.cancioneroFS)
    : isLocalDev ? new DevBackend()
    : new DropboxBackend(settings.dropboxAppKey || DROPBOX_APP_KEY);
  if (backend instanceof DropboxBackend) {
    try { if (await backend.handleRedirect()) toast('Dropbox conectado'); }
    catch (e) { toast(e.message, 5000); }
  }
  store = new Store(backend);
  store.loadCache();
  store.addEventListener('change', () => current?.onStoreChange?.());
  store.addEventListener('status', updateSyncDot);
  setupChrome();
  window.addEventListener('hashchange', route);
  route();
  if (isElectron && !(await window.cancioneroFS.getRoot())) location.hash = '#/ajustes';
  else if (canSync()) store.sync();
  else if (!store.songs.size) location.hash = '#/ajustes';
  window.addEventListener('focus', () => { if (canSync()) store.sync(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (canSync()) store.sync();
    if (current?.wake) requestWakeLock();
  });
  if (!isElectron && 'serviceWorker' in navigator && !isLocalDev) navigator.serviceWorker.register('sw.js').catch(() => {});
}

const canSync = () => !(backend instanceof DropboxBackend) || backend.connected;

function updateSyncDot() {
  const d = $('#syncDot');
  d.className = 'sync-dot ' + store.status;
  d.title = store.status === 'error' ? 'Error al sincronizar: ' + (store.error?.message || '') : store.status === 'ok' ? 'Sincronizado' : 'Sincronizando…';
  if (store.status === 'error') toast('No se pudo sincronizar (se usan las canciones guardadas)');
}

// ---------------------------------------------------------------- barra superior, menú y buscador

function setupChrome() {
  const drawer = $('#drawer');
  $('#menuBtn').onclick = () => { drawer.hidden = false; };
  drawer.onclick = e => { if (e.target === drawer || e.target.matches('a')) drawer.hidden = true; };
  $('#syncBtn').onclick = async () => { drawer.hidden = true; if (canSync()) { await store.sync(); toast(store.status === 'ok' ? 'Listo' : 'Error al sincronizar'); } };

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
  const h = decodeURIComponent(location.hash.slice(1) || '/');
  const parts = h.split('/').filter(Boolean);
  const search = $('#search');
  search.value = '';
  $('#searchResults').hidden = true;
  document.querySelectorAll('[data-nav]').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + h));
  window.scrollTo(0, 0);

  if (!parts.length) current = songsView();
  else if (parts[0] === 'c') current = songView(parts.slice(1).join('/'));
  else if (parts[0] === 'listas') current = listsView();
  else if (parts[0] === 'lista' && parts.length >= 4) current = songView(null, parts.slice(1, 3).join('/'), +parts[3]);
  else if (parts[0] === 'lista') current = listView(parts.slice(1, 3).join('/'));
  else if (parts[0] === 'editar') current = editorView(parts.slice(1).join('/'));
  else if (parts[0] === 'nueva') current = editorView(null);
  else if (parts[0] === 'ajustes') current = settingsView();
  else current = songsView();
  search.placeholder = current.ownsSearch ? 'Filtrar canciones…' : 'Buscar canción…';
}

// ---------------------------------------------------------------- vista: todas las canciones

function songsView() {
  let q = '';
  const render = () => {
    const res = store.search(q);
    view.innerHTML = `<div class="page">
      <div class="page-head"><h1>Canciones <span class="count">${store.songs.size}</span></h1>
        <a class="btn" href="#/nueva">+ Nueva</a></div>
      ${!store.songs.size ? `<div class="empty">${store.status === 'syncing' ? 'Cargando canciones…' : 'Todavía no hay canciones. Revisá la conexión en Ajustes.'}</div>` : ''}
      <ul class="items">${res.map(r => `<li><a class="item" href="${songHash(r.song.path)}"><span class="t">${esc(r.song.title)}${r.snippet ? `<small>${esc(r.snippet)}</small>` : ''}</span><span class="k">${esc(keyName(r.song.key, settings.notation))}</span></a></li>`).join('')}</ul>
    </div>`;
  };
  render();
  return {
    ownsSearch: true,
    onSearch: v => { q = v; render(); },
    onSearchEnter: () => { const r = store.search(q)[0]; if (r) location.hash = songHash(r.song.path); },
    onStoreChange: render,
  };
}

// ---------------------------------------------------------------- vista: canción

function songView(path, lpath = null, idx = 0) {
  const list = lpath ? store.lists.get(lpath) : null;
  if (lpath && !list) { view.innerHTML = `<div class="page empty">Lista no encontrada</div>`; return { onStoreChange: () => route() }; }
  const item = list ? list.items[idx] : null;
  if (list) path = item?.song;
  let semis = item ? (item.semis || 0) : (tempSemis.get(path) || 0);
  let entry = store.songs.get(path);

  const saveListSemis = debounce(async () => {
    try { await store.saveList(list); } catch (e) { toast('No se pudo guardar el tono en la lista'); }
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
      <div class="song-tools">
        <span class="keybox"><button data-act="down" aria-label="Bajar medio tono">−</button><button class="key" data-act="keys">${esc(shown || '—')}</button><button data-act="up" aria-label="Subir medio tono">+</button></span>
        <span class="orig">${semis ? `${semis > 0 ? '+' : ''}${semis} · original ${esc(keyName(k, settings.notation))} <button data-act="reset">volver</button>` : 'tono original'}</span>
        <span class="spacer"></span>
        <span class="size-btns row">${settings.fit ? '' : '<button data-act="fit" aria-label="Ajustar al ancho" title="Ajustar al ancho de la pantalla">↔</button>'}<button data-act="smaller" aria-label="Letra más chica">A−</button><button data-act="bigger" aria-label="Letra más grande">A+</button></span>
        <a class="btn small" href="#/editar/${encodeURIComponent(path)}">Editar</a>
        ${isElectron || matchMedia('(min-width: 900px)').matches ? '<button class="btn small" data-act="print">Imprimir</button>' : ''}
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
    onStoreChange: () => { if (!list || store.lists.get(lpath)) render(); },
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
  const lists = store.listList();
  const today = new Date().toISOString().slice(0, 10);
  const chosen = await openDialog((d, close) => {
    d.innerHTML = `<h2>Agregar a una lista</h2>
      <ul class="items">${lists.map(l => `<li class="item" data-p="${esc(l.path)}"><span class="t">${esc(l.name)}<small>${esc(formatDate(l.date))}</small></span><span class="count">${l.items.length}</span></li>`).join('') || '<div class="empty">No hay listas todavía</div>'}</ul>
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
    const f = await formDialog('Nueva lista', [{ name: 'name', label: 'Nombre', placeholder: 'Misa del sábado' }, { name: 'date', label: 'Fecha', type: 'date', value: nextSaturday() || today }], 'Crear');
    if (!f || !f.name.trim()) return;
    list = { name: f.name.trim(), date: f.date, items: [] };
  } else list = store.lists.get(chosen);
  list.items.push({ song: path, semis });
  try { await store.saveList(list); toast(`Agregada a "${list.name}"`); }
  catch (e) { toast('No se pudo guardar: ' + e.message); }
}

function nextSaturday() {
  const d = new Date();
  d.setDate(d.getDate() + ((6 - d.getDay() + 7) % 7));
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- vista: listas

function listsView() {
  const render = () => {
    const today = new Date().toISOString().slice(0, 10);
    const all = store.listList();
    const upcoming = all.filter(l => (l.date || '') >= today).reverse();
    const past = all.filter(l => (l.date || '') < today);
    const li = l => `<li><a class="item" href="${listHash(l.path)}"><span class="t">${esc(l.name)}<small>${esc(formatDate(l.date))}</small></span><span class="count">${l.items.length} canc.</span></a></li>`;
    view.innerHTML = `<div class="page">
      <div class="page-head"><h1>Listas</h1><button class="btn primary" data-new>+ Nueva lista</button></div>
      ${!all.length ? '<div class="empty">Armá una lista para la próxima misa o evento: tocá "+ Nueva lista".</div>' : ''}
      ${upcoming.length ? `<h3 class="count">Próximas</h3><ul class="items">${upcoming.map(li).join('')}</ul>` : ''}
      ${past.length ? `<h3 class="count">Anteriores</h3><ul class="items">${past.map(li).join('')}</ul>` : ''}
    </div>`;
    view.querySelector('[data-new]').onclick = async () => {
      const f = await formDialog('Nueva lista', [{ name: 'name', label: 'Nombre', placeholder: 'Misa del sábado' }, { name: 'date', label: 'Fecha', type: 'date', value: nextSaturday() }], 'Crear');
      if (!f || !f.name.trim()) return;
      try {
        const p = await store.saveList({ name: f.name.trim(), date: f.date, items: [] });
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
    view.innerHTML = `<div class="page setlist">
      <div class="page-head"><div><h1 style="margin-bottom:2px">${esc(list.name)}</h1><div class="count">${esc(formatDate(list.date))}</div></div>
        <div class="row"><button class="btn small" data-act="edit">Renombrar</button><button class="btn small danger" data-act="del">Eliminar</button></div></div>
      <div class="row" style="margin:14px 0 6px">
        <button class="btn primary" data-act="add">+ Agregar canciones</button>
        ${list.items.length ? `<a class="btn" href="${listHash(lpath, 0)}">▶ Empezar</a>` : ''}
      </div>
      <ul class="items">${list.items.map((it, i) => {
        const s = store.songs.get(it.song);
        const k = s ? transposedKeyName(s.key, it.semis || 0, settings.notation) : '';
        return `<li class="item" draggable="true" data-i="${i}">
          <span class="num">${i + 1}</span>
          <a class="t" href="${listHash(lpath, i)}" style="text-decoration:none">${it.label ? `<small style="font-weight:700;color:#000">${esc(it.label)}</small>` : ''}${esc(s?.title || '(canción borrada)')}${it.semis ? `<small>${it.semis > 0 ? '+' : ''}${it.semis} desde el original</small>` : ''}</a>
          <span class="k">${esc(k)}</span>
          <span class="acts"><button data-act="label" title="Etiqueta (ej: Entrada)">✎</button><button data-act="up" title="Subir">↑</button><button data-act="downi" title="Bajar">↓</button><button data-act="rm" title="Quitar">✕</button></span>
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
    if (a === 'edit') {
      const f = await formDialog('Editar lista', [{ name: 'name', label: 'Nombre', value: list.name }, { name: 'date', label: 'Fecha', type: 'date', value: list.date }]);
      if (f && f.name.trim()) { list.name = f.name.trim(); list.date = f.date; save(list); }
      return;
    }
    if (a === 'del') {
      if (await confirmDialog(`¿Eliminar la lista "${list.name}"?`, 'Eliminar', true)) {
        try { await store.remove(lpath); location.hash = '#/listas'; } catch (err) { toast(err.message); }
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
      <input class="field" style="width:100%;padding:9px 10px;border:1px solid var(--line);border-radius:8px;font-size:16px" placeholder="Buscar…" autofocus>
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

// ---------------------------------------------------------------- vista: editor

function editorView(path) {
  return renderEditor(view, { store, path, settings, onSaved: p => { location.hash = songHash(p); }, onCancel: () => history.back() });
}

// ---------------------------------------------------------------- vista: ajustes

function settingsView() {
  const render = async () => {
    let storage = '';
    if (backend instanceof FsBackend) {
      const root = await window.cancioneroFS.getRoot();
      storage = `<p class="hint">Las canciones se leen y guardan en esta carpeta (sincronizada por Dropbox):</p>
        <p><code>${esc(root || '(sin elegir)')}</code></p>
        <button class="btn" data-act="choose">Elegir carpeta…</button>`;
    } else if (backend instanceof DevBackend) {
      storage = `<p class="hint">Modo desarrollo: se usa la carpeta <code>data/</code> del proyecto.</p>`;
    } else {
      storage = backend.connected
        ? `<p>✅ Conectado a Dropbox.</p><button class="btn danger" data-act="disconnect">Desconectar</button>`
        : `<p class="hint">Conectá tu Dropbox para traer las canciones y listas.</p>
           <label class="field"><span>App key de Dropbox</span><input name="appkey" value="${esc(settings.dropboxAppKey || DROPBOX_APP_KEY)}" placeholder="ej: a1b2c3d4e5f6g7h"></label>
           <button class="btn primary" data-act="connect">Conectar con Dropbox</button>`;
    }
    view.innerHTML = `<div class="page">
      <h1>Ajustes</h1>
      <label class="field"><span>Notación de acordes</span>
        <select name="notation"><option value="latin">Latina (DO, RE, MI…)</option><option value="us">Americana (C, D, E…)</option></select></label>
      <label class="field"><span>Tamaño de letra de las canciones: <b data-size>${settings.songSize}px</b></span>
        <input name="songSize" type="range" min="12" max="40" step="1" value="${settings.songSize}"></label>
      <label class="row" style="margin-bottom:18px"><input name="wakeLock" type="checkbox" ${settings.wakeLock ? 'checked' : ''}> Mantener la pantalla encendida al ver una canción</label>
      <h3>Almacenamiento</h3>
      ${storage}
      <p class="hint" style="margin-top:24px">${store.songs.size} canciones · ${store.lists.size} listas</p>
    </div>`;
    view.querySelector('[name=notation]').value = settings.notation;
    view.querySelector('[name=notation]').onchange = e => { settings.notation = e.target.value; saveSettings(); };
    view.querySelector('[name=songSize]').oninput = e => { settings.songSize = +e.target.value; view.querySelector('[data-size]').textContent = settings.songSize + 'px'; saveSettings(); };
    view.querySelector('[name=wakeLock]').onchange = e => { settings.wakeLock = e.target.checked; saveSettings(); };
    view.querySelector('[data-act=choose]')?.addEventListener('click', async () => {
      if (await window.cancioneroFS.chooseRoot()) { store.files = {}; store.saveCache(); store.rebuild(); await store.sync(); render(); }
    });
    view.querySelector('[data-act=disconnect]')?.addEventListener('click', () => { backend.disconnect(); render(); });
    view.querySelector('[data-act=connect]')?.addEventListener('click', async () => {
      const key = view.querySelector('[name=appkey]').value.trim();
      settings.dropboxAppKey = key;
      saveSettings();
      backend.appKey = key;
      try { await backend.connect(); } catch (e) { toast(e.message, 4000); }
    });
  };
  render();
  return {};
}

// ---------------------------------------------------------------- pantalla encendida

let wakeLock = null;
async function requestWakeLock() {
  try { if ('wakeLock' in navigator && !document.hidden) wakeLock = await navigator.wakeLock.request('screen'); } catch { /* no soportado */ }
}
function releaseWakeLock() { wakeLock?.release().catch(() => {}); wakeLock = null; }

boot();
