// Convierte texto con los acordes en una línea encima de la letra (como en internet o en Word con
// fuente de ancho fijo) a ChordPro, ubicando cada acorde según su columna.
import { parseChord } from './chords.js';

const ANNOT_RE = /^(x\d+|\d+x|bis|intro:?|puente:?|final:?|interludio:?|coro:?|estribillo:?|solo:?)$/i;
const PUNCT_RE = /[[\](){}\-–—→←♪,;:|]+/;

/** 'chord' si la palabra es un acorde (o varios con -, paréntesis…), 'annot' si es una anotación tipo x2, o null. */
export function chordishToken(tok) {
  if (ANNOT_RE.test(tok)) return 'annot';
  const pieces = tok.split(PUNCT_RE).filter(Boolean);
  if (!pieces.length) return 'annot';
  if (!pieces.every(p => parseChord(p) || ANNOT_RE.test(p))) return null;
  return pieces.some(p => parseChord(p)) ? 'chord' : 'annot';
}

export function isChordLineText(line) {
  const toks = line.trim().split(/\s+/).filter(Boolean);
  if (!toks.length) return false;
  const kinds = toks.map(chordishToken);
  return kinds.every(Boolean) && kinds.includes('chord');
}

export const cleanChord = s => s.replace(/\[/g, '(').replace(/\]/g, ')');

function tokensWithCols(line) {
  return [...line.matchAll(/\S+/g)].map(m => ({ text: m[0], col: m.index }));
}

function mergeCols(chordLine, lyric) {
  const text = lyric.replace(/\s+$/, '');
  let out = '', pos = 0;
  for (const t of tokensWithCols(chordLine)) {
    let idx = Math.min(t.col, text.length);
    while (idx < text.length && text[idx] === ' ') idx++;
    if (idx < pos) idx = pos;
    out += text.slice(pos, idx);
    pos = idx;
    if (idx >= text.length && out && !out.endsWith(' ')) out += ' ';
    out += `[${cleanChord(t.text)}]`;
  }
  return (out + text.slice(pos)).trimStart();
}

/** Texto "acordes arriba" -> ChordPro. Las líneas que ya tienen [acordes] quedan igual. */
export function chordsOverLyricsToChordPro(text) {
  const lines = text.replace(/\r/g, '').replace(/\t/g, '    ').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isChordLineText(l) && !/\[[^\]]*\]/.test(l)) {
      const next = lines[i + 1];
      if (next !== undefined && next.trim() && !isChordLineText(next) && !/^\s*\{/.test(next)) {
        out.push(mergeCols(l, next));
        i++;
      } else {
        out.push(`[${cleanChord(l.trim().replace(/ {2,}/g, '   '))}]`);
      }
    } else out.push(l.replace(/\s+$/, ''));
  }
  return out.join('\n');
}
