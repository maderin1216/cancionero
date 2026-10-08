// Dibuja una canción en HTML: cada acorde queda arriba de la sílaba donde cambia.
import { transposeChordText, spellingFor } from './song.js';
import { esc } from './util.js';

/**
 * Convierte las partes de una línea en "átomos" (trozos de palabra), agrupados por palabra
 * para que el salto de línea en pantallas angostas nunca corte una palabra.
 */
function lineAtoms(parts, chordFn) {
  const atoms = [];
  parts.forEach((p, pi) => {
    const segs = p.text ? p.text.match(/[^ ]+ *| +/g) : [''];
    segs.forEach((s, si) => atoms.push({ chord: si === 0 && p.chord !== null ? chordFn(p.chord) : null, text: s, pi, si }));
  });
  return atoms;
}

export function renderLyricLine(parts, chordFn, { editable = false } = {}) {
  const hasChords = parts.some(p => p.chord !== null);
  const hasText = parts.some(p => p.text.trim());
  const atoms = lineAtoms(parts, chordFn);
  let html = '', word = '';
  const flush = () => { if (word) html += `<span class="w">${word}</span>`; word = ''; };
  for (const a of atoms) {
    const ch = hasChords ? `<span class="ch"${editable && a.chord !== null ? ` data-pi="${a.pi}"` : ''}>${a.chord !== null ? esc(a.chord) : ''}</span>` : '';
    const ly = hasText ? `<span class="ly">${esc(a.text)}</span>` : '';
    word += `<span class="c">${ch}${ly}</span>`;
    if (/ $/.test(a.text) || !a.text) flush();
  }
  flush();
  const cls = ['line', hasChords ? 'has-chords' : '', hasText ? '' : 'chords-only'].filter(Boolean).join(' ');
  return `<div class="${cls}">${html}</div>`;
}

/** HTML completo de la canción transportada `semis` semitonos. */
export function renderSong(song, { semis = 0, notation = 'latin', origKey = null } = {}) {
  const opts = spellingFor(origKey, semis, notation);
  const chordFn = c => transposeChordText(c, semis, opts);
  let html = '', inChorus = false;
  for (const l of song.lines) {
    const c = l.type !== 'blank' && l.chorus;
    if (l.type !== 'blank' && c !== inChorus) { html += c ? '<div class="chorus">' : '</div>'; inChorus = c; }
    if (l.type === 'blank') html += '<div class="blank"></div>';
    else if (l.type === 'comment') html += `<div class="comment">${esc(l.text)}</div>`;
    else html += renderLyricLine(l.parts, chordFn);
  }
  if (inChorus) html += '</div>';
  return html;
}
