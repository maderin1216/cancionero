// Editor de canciones: texto ChordPro a la izquierda y vista previa interactiva a la derecha.
// En la vista previa: clic en una letra = poner un acorde ahí; clic en un acorde = cambiarlo o
// quitarlo; arrastrar un acorde = moverlo (incluso a otra línea).
import { parseSong, songKey, transposeChordText, spellingFor } from './song.js';
import { parseKey, keyName, noteName, keyUsesFlats } from './chords.js';
import { chordsOverLyricsToChordPro } from './textimport.js';
import { esc, debounce } from './util.js';
import { toast, openDialog, confirmDialog } from './ui.js';

const DIRECTIVE_RE = /^\s*\{\s*([a-zA-Z_]+)\s*(?::\s*(.*?))?\s*\}\s*$/;

// ---- una línea de letra como {text, chords:[{pos, name}]} y de vuelta
export function lineToModel(line) {
  const chords = [];
  let text = '', last = 0, m;
  const re = /\[([^\]]*)\]/g;
  while ((m = re.exec(line))) {
    text += line.slice(last, m.index);
    chords.push({ pos: text.length, name: m[1] });
    last = re.lastIndex;
  }
  text += line.slice(last);
  return { text, chords };
}

export function modelToLine({ text, chords }) {
  const sorted = chords.map((c, i) => ({ ...c, i })).sort((a, b) => a.pos - b.pos || a.i - b.i);
  let out = '', pos = 0;
  for (const c of sorted) {
    const p = Math.min(c.pos, text.length);
    if (p > pos) { out += text.slice(pos, p); pos = p; }
    out += `[${c.name}]`;
  }
  return out + text.slice(pos);
}

function splitSource(text) {
  // separa título y tono (van en campos aparte) del cuerpo
  const meta = { title: '', key: '' };
  const body = [];
  let header = true;
  for (const line of text.replace(/\r/g, '').split('\n')) {
    const d = line.match(DIRECTIVE_RE);
    if (header && d && /^(title|t|key|k)$/i.test(d[1])) {
      meta[/^t/i.test(d[1]) ? 'title' : 'key'] = d[2] || '';
      continue;
    }
    if (header && !line.trim() && !body.length) continue;
    header = header && (!!d || !line.trim());
    body.push(line);
  }
  while (body.length && !body.at(-1).trim()) body.pop();
  return { meta, body: body.join('\n') };
}

export function renderEditor(view, { store, path, settings, onSaved, onCancel }) {
  const entry = path ? store.songs.get(path) : null;
  if (path && !entry) { view.innerHTML = '<div class="page empty">No se encontró la canción.</div>'; return {}; }
  const { meta, body } = splitSource(entry ? entry.text : '');
  let dirty = false;

  view.innerHTML = `<div class="editor">
    <div class="page-head"><h1 style="font-size:22px;margin:6px 0">${entry ? 'Editar canción' : 'Nueva canción'}</h1>
      <div class="row">
        ${entry ? '<button class="btn danger" data-act="delete">Eliminar</button>' : ''}
        <button class="btn" data-act="cancel">Cancelar</button>
        <button class="btn primary" data-act="save">Guardar</button>
      </div></div>
    <div class="ed-meta">
      <label class="field"><span>Título</span><input name="title" value="${esc(meta.title)}" placeholder="Nombre de la canción"></label>
      <label class="field"><span>Tono original</span><input name="key" value="${esc(meta.key)}" placeholder="ej: SOL, MIm"></label>
      <div class="field"><span>Transportar y guardar</span><div class="row"><button class="btn small" data-act="tdown">− ½ tono</button><button class="btn small" data-act="tup">+ ½ tono</button></div></div>
    </div>
    <div class="row" style="margin:4px 0 8px">
      <button class="btn small" data-act="chorus" title="Marca las líneas seleccionadas como estribillo (negrita)">Marcar estribillo</button>
      <button class="btn small" data-act="convert" title="Convierte texto con los acordes en la línea de arriba (pegado de internet o Word)">Convertir "acordes arriba"</button>
      <button class="btn small" data-act="help">¿Cómo se escribe?</button>
    </div>
    <div class="ed-tabs"><button class="btn small" data-tab="src">Texto</button><button class="btn small" data-tab="pre">Acordes</button></div>
    <div class="ed-cols">
      <section data-sec="src"><h3>Texto (los acordes van entre corchetes: <code>[SOL]Ho[RE]la</code>)</h3>
        <textarea id="edSource" spellcheck="false" placeholder="Pegá o escribí la letra acá.&#10;&#10;Después hacé clic en la vista previa, sobre la sílaba donde cambia el acorde."></textarea></section>
      <section data-sec="pre" class="on"><h3>Vista previa — clic en una sílaba para poner un acorde · arrastrá los acordes para moverlos</h3>
        <div class="ed-preview song"></div></section>
    </div>
  </div>`;

  const src = view.querySelector('#edSource');
  const pre = view.querySelector('.ed-preview');
  const titleIn = view.querySelector('[name=title]');
  const keyIn = view.querySelector('[name=key]');
  src.value = body;

  const markDirty = () => { dirty = true; };
  const lines = () => src.value.split('\n');
  const setLines = ls => {
    const st = src.scrollTop;
    src.value = ls.join('\n');
    src.scrollTop = st;
    markDirty();
    renderPreview();
  };

  // ---------------------------------------------------------------- vista previa

  function renderPreview() {
    const ls = lines();
    let html = '', chorus = false;
    ls.forEach((line, li) => {
      const d = line.match(DIRECTIVE_RE);
      if (d) {
        const n = d[1].toLowerCase();
        if (n === 'soc' || n === 'start_of_chorus') chorus = true;
        else if (n === 'eoc' || n === 'end_of_chorus') chorus = false;
        else if (n === 'c' || n === 'comment') html += `<div class="comment">${esc(d[2] || '')}</div>`;
        return;
      }
      if (!line.trim()) { html += '<div class="blank"></div>'; return; }
      html += renderEditableLine(lineToModel(line), li, chorus);
    });
    pre.innerHTML = html || '<div class="empty">Escribí la letra en el cuadro de texto.</div>';
  }

  function renderEditableLine(model, li, chorus) {
    const { text, chords } = model;
    const hasChords = chords.length > 0;
    // cortes: posiciones donde empieza un acorde o una palabra
    const order = chords.map((c, ci) => ({ ...c, ci })).sort((a, b) => a.pos - b.pos || a.ci - b.ci);
    const chordAt = new Map();
    for (const c of order) { if (!chordAt.has(c.pos)) chordAt.set(c.pos, []); chordAt.get(c.pos).push(c); }
    const cuts = new Set([0, ...chordAt.keys()]);
    for (let i = 1; i < text.length; i++) if (text[i - 1] === ' ' && text[i] !== ' ') cuts.add(i);
    const sortedCuts = [...cuts].filter(p => p <= text.length).sort((a, b) => a - b);
    let html = '', word = '';
    const flush = () => { if (word) html += `<span class="w">${word}</span>`; word = ''; };
    sortedCuts.forEach((start, k) => {
      const end = k + 1 < sortedCuts.length ? sortedCuts[k + 1] : text.length;
      const here = chordAt.get(start) || [];
      // varios acordes en la misma posición: los anteriores van solos
      here.slice(0, -1).forEach(c => { word += `<span class="c"><span class="ch" data-li="${li}" data-pi="${c.ci}">${esc(c.name)}</span><span class="ly"></span></span>`; });
      const c = here.at(-1);
      let ly = '';
      for (let p = start; p < end; p++) ly += `<span class="ch-hit" data-li="${li}" data-pos="${p}">${text[p] === ' ' ? ' ' : esc(text[p])}</span>`;
      if (end === text.length) ly += `<span class="ch-hit" data-li="${li}" data-pos="${text.length}">  </span>`;
      word += `<span class="c">${hasChords ? `<span class="ch"${c ? ` data-li="${li}" data-pi="${c.ci}"` : ''}>${c ? esc(c.name) : ''}</span>` : '<span class="ch"></span>'}<span class="ly">${ly}</span></span>`;
      if (text[end - 1] === ' ' || end === text.length) flush();
    });
    flush();
    return `<div class="line has-chords${chorus ? ' in-chorus' : ''}" ${chorus ? 'style="font-weight:700"' : ''}>${html}</div>`;
  }

  // ---------------------------------------------------------------- edición de acordes

  const songChordNames = () => {
    const freq = new Map();
    for (const l of lines()) for (const c of lineToModel(l).chords) freq.set(c.name, (freq.get(c.name) || 0) + 1);
    return [...freq.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0]).filter(n => !/\s/.test(n)).slice(0, 16);
  };

  const diatonic = () => {
    const k = parseKey(keyIn.value) || songKey(parseSong(src.value));
    if (!k) return [];
    const o = { notation: settings.notation, flats: keyUsesFlats(k.root, k.minor) };
    const degs = k.minor
      ? [[0, 'm'], [2, 'dim'], [3, ''], [5, 'm'], [7, '7'], [7, 'm'], [8, ''], [10, '']]
      : [[0, ''], [2, 'm'], [4, 'm'], [5, ''], [7, ''], [7, '7'], [9, 'm'], [11, 'dim']];
    return degs.map(([s, q]) => noteName(k.root + s, o) + q);
  };

  function chordDialog(current) {
    return openDialog((d, close) => {
      const used = songChordNames(), dia = diatonic();
      d.innerHTML = `<h2>${current !== null ? 'Cambiar acorde' : 'Poner acorde'}</h2>
        <form><input name="c" value="${esc(current || '')}" autocomplete="off" autofocus style="width:100%;padding:10px;font-size:20px;font-weight:700;border:1px solid var(--line);border-radius:8px">
        ${used.length ? `<div class="palette"><span class="lbl">Usados en la canción</span>${used.map(c => `<button type="button" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
        ${dia.length ? `<div class="palette"><span class="lbl">Acordes del tono</span>${dia.map(c => `<button type="button" data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : ''}
        <div class="actions">${current !== null ? '<button type="button" class="btn danger" data-rm>Quitar</button>' : ''}<button type="button" class="btn" data-x>Cancelar</button><button class="btn primary">Aceptar</button></div></form>`;
      const input = d.querySelector('input');
      input.select();
      d.querySelector('form').onsubmit = e => { e.preventDefault(); close(input.value.trim().replace(/[[\]]/g, '') || ''); };
      d.onclick = e => {
        const b = e.target.closest('[data-c]');
        if (b) close(b.dataset.c);
        else if (e.target.closest('[data-rm]')) close('');
        else if (e.target.closest('[data-x]')) close(null);
      };
    });
  }

  async function addChordAt(li, pos) {
    const name = await chordDialog(null);
    if (!name) return;
    const ls = lines();
    const m = lineToModel(ls[li]);
    m.chords.push({ pos, name });
    ls[li] = modelToLine(m);
    setLines(ls);
  }

  async function editChord(li, ci) {
    const ls = lines();
    const m = lineToModel(ls[li]);
    const name = await chordDialog(m.chords[ci].name);
    if (name === null || name === undefined) return;
    if (name === '') m.chords.splice(ci, 1);
    else m.chords[ci].name = name;
    ls[li] = modelToLine(m);
    setLines(ls);
  }

  function moveChord(fromLi, ci, toLi, pos) {
    const ls = lines();
    const from = lineToModel(ls[fromLi]);
    const [c] = from.chords.splice(ci, 1);
    if (fromLi === toLi) { from.chords.push({ ...c, pos }); ls[fromLi] = modelToLine(from); }
    else {
      ls[fromLi] = modelToLine(from);
      const to = lineToModel(ls[toLi]);
      to.chords.push({ ...c, pos });
      ls[toLi] = modelToLine(to);
    }
    setLines(ls);
  }

  // arrastrar acordes con el puntero (mouse o dedo)
  let drag = null;
  pre.addEventListener('pointerdown', e => {
    const ch = e.target.closest('.ch[data-pi]');
    if (!ch) return;
    e.preventDefault();
    drag = { li: +ch.dataset.li, ci: +ch.dataset.pi, x: e.clientX, y: e.clientY, el: ch, moved: false, ghost: null, target: null };
    ch.setPointerCapture(e.pointerId);
  });
  pre.addEventListener('pointermove', e => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
    if (!drag.moved) {
      drag.moved = true;
      drag.el.classList.add('drag-src');
      drag.ghost = document.createElement('div');
      drag.ghost.className = 'drag-ghost';
      drag.ghost.textContent = drag.el.textContent;
      drag.ghost.style.fontSize = getComputedStyle(pre).fontSize;
      document.body.append(drag.ghost);
    }
    drag.ghost.style.left = e.clientX - 4 + 'px';
    drag.ghost.style.top = e.clientY - 36 + 'px';
    // la letra que está debajo de la punta del acorde (un poco más abajo del puntero)
    const under = document.elementFromPoint(e.clientX, e.clientY + 18)?.closest('.ch-hit')
      || document.elementFromPoint(e.clientX, e.clientY)?.closest('.ch-hit');
    if (drag.target !== under) { drag.target?.classList.remove('drop'); drag.target = under; under?.classList.add('drop'); }
  });
  const endDrag = e => {
    if (!drag) return;
    const d = drag;
    drag = null;
    d.ghost?.remove();
    d.el.classList.remove('drag-src');
    d.target?.classList.remove('drop');
    if (!d.moved) { if (e.type === 'pointerup') editChord(d.li, d.ci); return; }
    if (d.target) moveChord(d.li, d.ci, +d.target.dataset.li, +d.target.dataset.pos);
  };
  pre.addEventListener('pointerup', endDrag);
  pre.addEventListener('pointercancel', endDrag);
  pre.addEventListener('click', e => {
    const hit = e.target.closest('.ch-hit');
    if (hit) addChordAt(+hit.dataset.li, +hit.dataset.pos);
  });

  // ---------------------------------------------------------------- barra de herramientas

  const transposeAll = semis => {
    const k = parseKey(keyIn.value) || songKey(parseSong(src.value));
    const opts = spellingFor(k, semis, 'latin');
    opts.forceNotation = false;
    setLines(lines().map(l => (DIRECTIVE_RE.test(l) ? l : l.replace(/\[([^\]]*)\]/g, (_, c) => `[${transposeChordText(c, semis, opts)}]`))));
    if (k) keyIn.value = keyName({ root: (k.root + semis + 12) % 12, minor: k.minor });
  };

  view.querySelector('.editor').addEventListener('click', async e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) {
      view.querySelectorAll('[data-sec]').forEach(s => s.classList.toggle('on', s.dataset.sec === tab.dataset.tab));
      return;
    }
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const a = b.dataset.act;
    if (a === 'cancel') { if (!dirty || await confirmDialog('¿Descartar los cambios?', 'Descartar', true)) { dirty = false; onCancel(); } }
    else if (a === 'save') save();
    else if (a === 'delete') {
      if (await confirmDialog(`¿Eliminar "${entry.title}"? Se borra de Dropbox (queda en la papelera de Dropbox unos días).`, 'Eliminar', true)) {
        try { await store.remove(path); dirty = false; location.hash = '#/'; } catch (err) { toast(err.message); }
      }
    }
    else if (a === 'tup') transposeAll(1);
    else if (a === 'tdown') transposeAll(-1);
    else if (a === 'convert') {
      const s = src.selectionStart, en = src.selectionEnd;
      if (s !== en) src.setRangeText(chordsOverLyricsToChordPro(src.value.slice(s, en)), s, en, 'select');
      else src.value = chordsOverLyricsToChordPro(src.value);
      markDirty();
      renderPreview();
      toast('Listo. Revisá en la vista previa que los acordes hayan quedado bien.');
    }
    else if (a === 'chorus') {
      const v = src.value;
      let s = src.selectionStart, en = src.selectionEnd;
      if (s === en) { toast('Primero seleccioná en el texto las líneas del estribillo'); return; }
      s = v.lastIndexOf('\n', s - 1) + 1;
      const nl = v.indexOf('\n', en - (v[en - 1] === '\n' ? 1 : 0));
      en = nl < 0 ? v.length : nl;
      src.setRangeText(`{soc}\n${v.slice(s, en)}\n{eoc}`, s, en, 'end');
      markDirty();
      renderPreview();
    }
    else if (a === 'help') helpDialog();
  });

  src.addEventListener('input', debounce(() => { markDirty(); renderPreview(); }, 150));
  titleIn.addEventListener('input', markDirty);
  keyIn.addEventListener('input', markDirty);
  const onKey = e => { if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(); } };
  document.addEventListener('keydown', onKey);
  const onUnload = e => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', onUnload);

  async function save() {
    const title = titleIn.value.trim();
    if (!title) { toast('Poné un título'); titleIn.focus(); return; }
    let key = keyIn.value.trim();
    if (!key) { const k = songKey(parseSong(src.value)); if (k) key = keyName(k); }
    const text = `{title: ${title}}\n${key ? `{key: ${key}}\n` : ''}\n${src.value.replace(/\s+$/, '')}\n`;
    try {
      const p = await store.saveSong(path, text);
      dirty = false;
      toast('Guardada');
      onSaved(p);
    } catch (e) {
      toast('No se pudo guardar: ' + e.message, 5000);
    }
  }

  renderPreview();
  if (!entry) titleIn.focus();

  return {
    isDirty: () => dirty,
    leave: () => { document.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onUnload); },
  };
}

function helpDialog() {
  openDialog((d, close) => {
    d.innerHTML = `<h2>Cómo se escribe una canción</h2>
      <div class="hint">
      <p><b>La forma fácil:</b> escribí o pegá sólo la letra y después hacé clic en la vista previa, sobre la sílaba donde cambia el acorde. Para mover un acorde, arrastralo. Para cambiarlo o quitarlo, hacé clic encima.</p>
      <p><b>En el texto</b> los acordes van entre corchetes, justo antes de la sílaba:<br><code>[SOL]Hecha un mar de [MIm]lágrimas</code></p>
      <p><b>Estribillo</b> (se ve en negrita): entre <code>{soc}</code> y <code>{eoc}</code>, o seleccioná las líneas y tocá "Marcar estribillo".</p>
      <p><b>Comentario</b> (ej. "Intro", "x2"): <code>{c: Intro}</code></p>
      <p><b>Sólo acordes</b> (intro, puente): una línea con <code>[(SOL RE MIm DO) x2]</code></p>
      <p><b>Si copiás de internet</b> una canción con los acordes en la línea de arriba, pegala y tocá "Convertir acordes arriba".</p>
      </div><div class="actions"><button class="btn primary">Entendido</button></div>`;
    d.querySelector('button').onclick = () => close();
  });
}
