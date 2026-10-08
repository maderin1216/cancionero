// Modelo de canción en formato ChordPro: parseo, serialización y transporte.
//
//   {title: A TANTO AMOR}
//   {key: SOL}
//   [SOL]Hecha un mar de [MIm]lágrimas...
//   {soc} ... {eoc}        estribillo (se muestra en negrita)
//   {c: Intro}              comentario
//
// Un "acorde" entre corchetes puede contener anotaciones: [(RE LA SOL) x2], [FA#m-SOL].
// Al transportar sólo cambian las palabras que son acordes.

import { parseChord, transposeChord, parseKey, keyName, keyUsesFlats, isMinor } from './chords.js';

const DIRECTIVE_RE = /^\{\s*([a-zA-Z_]+)\s*(?::\s*([\s\S]*?))?\s*\}$/;
const ALIASES = { t: 'title', st: 'subtitle', k: 'key', c: 'comment', soc: 'start_of_chorus', eoc: 'end_of_chorus' };

/** Parsea texto ChordPro a {meta, lines}. */
export function parseSong(text) {
  const meta = {};
  const lines = [];
  let chorus = false;
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    const d = line.trim().match(DIRECTIVE_RE);
    if (d) {
      const name = ALIASES[d[1].toLowerCase()] ?? d[1].toLowerCase();
      const val = d[2] ?? '';
      if (name === 'start_of_chorus') { chorus = true; continue; }
      if (name === 'end_of_chorus') { chorus = false; continue; }
      if (name === 'comment' || name === 'comment_italic' || name === 'ci') { lines.push({ type: 'comment', text: val, chorus }); continue; }
      meta[name] = val;
      continue;
    }
    if (!line.trim()) { lines.push({ type: 'blank' }); continue; }
    lines.push({ type: 'lyric', parts: parseLyricLine(line), chorus });
  }
  // quitar líneas en blanco del principio y del final
  while (lines.length && lines[0].type === 'blank') lines.shift();
  while (lines.length && lines.at(-1).type === 'blank') lines.pop();
  return { meta, lines };
}

/** "[SOL]Hecha un [MIm]mar" -> [{chord:'SOL', text:'Hecha un '}, {chord:'MIm', text:'mar'}] */
export function parseLyricLine(line) {
  const parts = [];
  const re = /\[([^\]]*)\]/g;
  let last = 0, m, chord = null;
  while ((m = re.exec(line))) {
    const text = line.slice(last, m.index);
    if (text || chord !== null) parts.push({ chord, text });
    chord = m[1];
    last = re.lastIndex;
  }
  const tail = line.slice(last);
  if (tail || chord !== null) parts.push({ chord, text: tail });
  return parts;
}

export function serializeSong({ meta, lines }) {
  const out = [];
  for (const [k, v] of Object.entries(meta)) if (v !== undefined && v !== '') out.push(`{${k}: ${v}}`);
  if (out.length) out.push('');
  let chorus = false;
  for (const l of lines) {
    const c = l.type !== 'blank' && !!l.chorus;
    if (c !== chorus && (l.type !== 'blank')) { out.push(c ? '{soc}' : '{eoc}'); chorus = c; }
    if (l.type === 'blank') out.push('');
    else if (l.type === 'comment') out.push(`{c: ${l.text}}`);
    else out.push(l.parts.map(p => (p.chord !== null ? `[${p.chord}]` : '') + p.text).join(''));
  }
  if (chorus) out.push('{eoc}');
  return out.join('\n') + '\n';
}

/** Todos los acordes (palabras-acorde) de la canción, en orden. */
export function songChords(song) {
  const res = [];
  for (const l of song.lines) if (l.type === 'lyric')
    for (const p of l.parts) if (p.chord) for (const w of chordWords(p.chord)) res.push(w);
  return res;
}

const WORD_RE = /[^\s()[\]{}\-–—→←♪,;:|]+/g;
const chordWords = s => (s.match(WORD_RE) || []).filter(w => parseChord(w));

/** Transpone el texto de un "acorde" que puede tener anotaciones. */
export function transposeChordText(text, semis, opts) {
  if (!semis && !opts.forceNotation) return text;
  return text.replace(WORD_RE, w => (parseChord(w) ? transposeChord(w, semis, opts) : w));
}

/** Tonalidad original de la canción: {key:} o, si falta, el primer acorde. */
export function songKey(song) {
  const k = parseKey(song.meta.key);
  if (k) return k;
  for (const w of songChords(song)) { const c = parseChord(w); return { root: c.root, minor: isMinor(c.quality) }; }
  return null;
}

/** Opciones de escritura (sostenidos/bemoles) para la tonalidad destino. */
export function spellingFor(origKey, semis, notation) {
  if (!origKey) return { notation, flats: false, forceNotation: notation !== 'latin' };
  return { notation, flats: keyUsesFlats(origKey.root + semis, origKey.minor), forceNotation: notation !== 'latin' };
}

export function transposedKeyName(origKey, semis, notation) {
  return origKey ? keyName({ root: (origKey.root + semis + 120) % 12, minor: origKey.minor }, notation) : '';
}

/** Texto plano (sin acordes) de la canción, para búsquedas. */
export function songPlainText(song) {
  return song.lines.filter(l => l.type === 'lyric').map(l => l.parts.map(p => p.text).join('')).join(' ');
}
