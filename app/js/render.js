// Dibuja una canción en HTML como en el PDF: la letra va de corrido y cada acorde queda
// "colgado" exactamente encima de la letra donde cambia (un ancla de ancho cero).
import { transposeChordText, spellingFor } from './song.js';
import { esc } from './util.js';

const MARKS_RE = /^[\s[\](){}\-–—|/.,:;→←♪]*(?:(?:x\d+|\d+x|bis)[\s[\](){}\-–—|/.,:;→←♪]*)?$/i;
export const isMarks = t => MARKS_RE.test(t);

const plainText = t => esc(t);

/** HTML de una línea. `textFn(text, offset)` permite envolver cada letra (lo usa el editor). */
export function renderLyricLine(parts, chordFn, { textFn = plainText, chordAttrs = () => '' } = {}) {
  const hasChords = parts.some(p => p.chord !== null);
  // si fuera de los acordes sólo hay signos ("[", "]", "(", "-", "x2"…) es una línea de acordes:
  // se muestra de corrido, como una intro
  const hasText = parts.some(p => !isMarks(p.text));
  const marks = !hasText && parts.some(p => p.text.length > 0);
  let html = '', off = 0;
  parts.forEach((p, pi) => {
    if (p.chord !== null) html += `<span class="a"><span class="ch"${chordAttrs(pi)}>${esc(chordFn(p.chord))}</span></span>`;
    // en una línea de acordes, sin espacio antes de un ']' o ')' que cierra (no en el editor: ahí cada letra cuenta)
    html += textFn(marks && textFn === plainText ? p.text.replace(/\s+(?=[\])])/g, '') : p.text, off);
    off += p.text.length;
  });
  const cls = ['line', hasChords ? 'has-chords' : '', hasText ? '' : 'chords-only', marks ? 'marks' : ''].filter(Boolean).join(' ');
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

/**
 * Si un acorde se pisa con el anterior (porque las sílabas son cortas), corre la letra lo justo
 * para que no se superpongan. Los márgenes van en em para que escalen con el tamaño de letra.
 */
export function separateChords(container) {
  const fs = parseFloat(getComputedStyle(container).fontSize) || 16;
  const gap = 0.3 * fs;
  for (const line of container.querySelectorAll('.line.has-chords:not(.chords-only)')) {
    const anchors = [...line.querySelectorAll('.a')];
    anchors.forEach(a => { a.style.marginLeft = ''; });
    let prev = null;
    for (const a of anchors) {
      const ch = a.firstElementChild;
      if (prev) {
        const pr = prev.getBoundingClientRect(), cr = ch.getBoundingClientRect();
        if (Math.abs(pr.top - cr.top) < 2) {
          const need = pr.right + gap - cr.left;
          if (need > 0.5) a.style.marginLeft = (need / fs).toFixed(3) + 'em';
        }
      }
      prev = ch;
    }
  }
}

/**
 * Modo "ajustar al ancho": calcula el tamaño de letra para que el verso más largo ocupe justo el
 * ancho disponible (como el PDF). Devuelve el tamaño en px.
 */
export function fitToWidth(container, { max = 30, min = 5 } = {}) {
  const base = 20;
  container.style.fontSize = base + 'px';
  separateChords(container);
  let widest = 0;
  for (const line of container.querySelectorAll('.line')) {
    // el ancho del verso o, si un acorde del final sobresale, hasta donde termina el acorde
    const left = line.getBoundingClientRect().left;
    let right = line.offsetWidth;
    for (const ch of line.querySelectorAll('.ch')) right = Math.max(right, ch.getBoundingClientRect().right - left);
    widest = Math.max(widest, right);
  }
  const avail = container.clientWidth;
  const size = widest ? Math.max(min, Math.min(max, Math.floor((base * avail / widest) * 10) / 10)) : max;
  container.style.fontSize = size + 'px';
  return size;
}
