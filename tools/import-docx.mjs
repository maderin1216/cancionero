// Convierte los .docx de canciones (acordes en una línea encima de la letra, alineados con
// espacios en Calibri) a archivos ChordPro, ubicando cada acorde según el ancho real de la fuente.
//
//   node tools/import-docx.mjs <carpeta-docx> <carpeta-salida>
import fs from 'node:fs';
import path from 'node:path';
import opentype from 'opentype.js';
import { readDocx } from './docx-read.mjs';
import { parseChord } from '../app/js/chords.js';
import { serializeSong, songKey, parseSong } from '../app/js/song.js';
import { keyName } from '../app/js/chords.js';
import { slugify } from '../app/js/util.js';

const loadFont = f => { const b = fs.readFileSync(f); return opentype.parse(b.buffer.slice(b.byteOffset, b.byteOffset + b.length)); };
const FONTS = {
  regular: loadFont('C:/Windows/Fonts/calibri.ttf'),
  bold: loadFont('C:/Windows/Fonts/calibrib.ttf'),
};
const TAB = 35.4; // tabulación por defecto de Word (1,25 cm)
const widthCache = new Map();
function charWidth(ch, bold, size) {
  const k = ch + (bold ? 'b' : 'r');
  let w = widthCache.get(k);
  if (w === undefined) {
    const f = bold ? FONTS.bold : FONTS.regular;
    w = f.charToGlyph(ch).advanceWidth / f.unitsPerEm;
    widthCache.set(k, w);
  }
  return w * size;
}

/** Párrafo -> líneas de caracteres con su posición x en puntos. */
function layout(para) {
  const lines = [[]];
  let x = 0;
  for (const r of para.runs) for (const ch of r.text) {
    if (ch === '\n') { lines.push([]); x = 0; continue; }
    const start = x;
    if (ch === '\t') x = (Math.floor(x / TAB) + 1) * TAB;
    else x += charWidth(ch, r.bold, r.size);
    lines.at(-1).push({ ch: ch === '\t' ? ' ' : ch, x: start, w: x - start, bold: r.bold });
  }
  return lines;
}

const ANNOT_RE = /^(x\d+|bis|intro:?|puente:?|final:?|interludio:?|coro:?|estribillo:?|\d+x)$/i;
const PUNCT_RE = /[[\](){}\-–—→←♪,;:|]+/;

function isChordishToken(tok) {
  if (ANNOT_RE.test(tok)) return 'annot';
  const pieces = tok.split(PUNCT_RE).filter(Boolean);
  if (!pieces.length) return 'annot';
  return pieces.every(p => parseChord(p) || ANNOT_RE.test(p)) ? (pieces.some(p => parseChord(p)) ? 'chord' : 'annot') : null;
}

/** Tokens (palabra + x) de una línea de caracteres. */
function tokens(chars) {
  const res = [];
  let cur = null;
  for (const c of chars) {
    if (/\s/.test(c.ch)) { cur = null; continue; }
    if (!cur) { cur = { text: '', x: c.x }; res.push(cur); }
    cur.text += c.ch;
  }
  return res;
}

function isChordLine(chars) {
  const toks = tokens(chars);
  if (!toks.length) return false;
  const kinds = toks.map(t => isChordishToken(t.text));
  return kinds.every(Boolean) && kinds.includes('chord');
}

const cleanChord = s => s.replace(/\[/g, '(').replace(/\]/g, ')');

/** Une línea de acordes con la línea de letra de abajo. */
function merge(chordChars, lyricChars) {
  const toks = tokens(chordChars);
  const text = lyricChars.map(c => c.ch).join('').replace(/\s+$/, '');
  const n = text.length;
  const xs = lyricChars.map(c => c.x);
  const end = n ? lyricChars[n - 1].x + lyricChars[n - 1].w : 0;
  const placed = []; // {idx, chord}
  for (const t of toks) {
    let idx;
    if (t.x >= end - 1) idx = n;
    else {
      idx = 0;
      for (let i = 0; i < n; i++) if (xs[i] <= t.x + 1.5) idx = i;
      // si el acorde cae sobre un espacio, pasarlo al comienzo de la palabra siguiente
      while (idx < n && text[idx] === ' ') idx++;
    }
    placed.push({ idx, chord: cleanChord(t.text) });
  }
  // los acordes que caen después del final de la letra (un pasaje instrumental) van en un solo bloque
  const tail = placed.filter(p => p.idx >= n);
  if (tail.length > 1) {
    placed.splice(placed.length - tail.length, tail.length, { idx: n, chord: tail.map(p => p.chord).join(' ') });
  }
  let out = '', pos = 0;
  for (const p of placed) {
    if (p.idx > pos) { out += text.slice(pos, p.idx); pos = p.idx; }
    if (p.idx >= n && out && !out.endsWith(' ')) out += ' ';
    out += `[${p.chord}]`;
  }
  out += text.slice(pos);
  out = out.replace(/ {4,}/g, '   ').trimStart();
  return out;
}

function chordOnlyLine(chars) {
  const toks = tokens(chars);
  // separar los acordes con espacios proporcionales a su distancia (mínimo 1)
  let out = '';
  toks.forEach((t, i) => {
    if (i) {
      const prev = toks[i - 1];
      const gap = t.x - (prev.x + prev.text.length * 6);
      out += ' '.repeat(Math.max(1, Math.min(6, Math.round(gap / 12))));
    }
    out += t.text;
  });
  return `[${cleanChord(out)}]`;
}

const isBoldLine = chars => {
  const vis = chars.filter(c => !/\s/.test(c.ch));
  return vis.length > 0 && vis.filter(c => c.bold).length / vis.length > 0.6;
};

export async function convert(file) {
  const paras = await readDocx(file);
  let all = paras.flatMap(layout);
  const textOf = l => l.map(c => c.ch).join('');
  // título: primera línea no vacía
  while (all.length && !textOf(all[0]).trim()) all.shift();
  const docTitle = textOf(all.shift() || []).trim();
  const lines = [];
  for (let i = 0; i < all.length; i++) {
    const cur = all[i];
    if (!textOf(cur).trim()) { lines.push({ type: 'blank' }); continue; }
    if (isChordLine(cur)) {
      const next = all[i + 1];
      if (next && textOf(next).trim() && !isChordLine(next)) {
        lines.push({ text: merge(cur, next), chorus: isBoldLine(next) });
        i++;
      } else {
        lines.push({ text: chordOnlyLine(cur), chorus: false, chordOnly: true });
      }
      continue;
    }
    lines.push({ text: textOf(cur).trim().replace(/ {4,}/g, '   '), chorus: isBoldLine(cur) });
  }
  // una línea sólo de acordes dentro del estribillo hereda su estado
  for (let i = 0; i < lines.length; i++) if (lines[i].chordOnly) {
    const nb = lines.slice(i + 1).find(l => l.type !== 'blank' && !l.chordOnly);
    const pb = lines.slice(0, i).reverse().find(l => l.type !== 'blank' && !l.chordOnly);
    if (nb?.chorus && pb?.chorus) lines[i].chorus = true;
  }
  // colapsar blancos repetidos
  const body = [];
  let chorus = false;
  for (const l of lines) {
    if (l.type === 'blank') { if (body.length && body.at(-1) !== '') body.push(''); continue; }
    if (l.chorus !== chorus) {
      if (chorus) body.push('{eoc}');
      else { if (body.length && body.at(-1) !== '') body.push(''); body.push('{soc}'); }
      chorus = l.chorus;
      if (!chorus && body.at(-1) === '{eoc}') { /* ok */ }
    }
    body.push(l.text);
  }
  if (chorus) body.push('{eoc}');
  // un blanco justo antes de {eoc} va después
  const fixed = [];
  for (const b of body) {
    if (b === '{eoc}' && fixed.at(-1) === '') { fixed.pop(); fixed.push('{eoc}', ''); continue; }
    fixed.push(b);
  }
  while (fixed.at(-1) === '') fixed.pop();
  return { docTitle, body: fixed.join('\n') };
}

if (process.argv[1].endsWith('import-docx.mjs')) {
  const [src, out] = process.argv.slice(2);
  fs.mkdirSync(out, { recursive: true });
  const files = fs.readdirSync(src).filter(f => /\.doc[xm]$/i.test(f) && !f.startsWith('~$'));
  const used = new Set();
  let ok = 0;
  for (const f of files) {
    try {
      const { body } = await convert(path.join(src, f));
      const title = f.replace(/\.doc[xm]$/i, '').trim();
      const song = parseSong(body);
      const k = songKey(song);
      let header = `{title: ${title}}\n`;
      if (k) header += `{key: ${keyName(k)}}\n`;
      let slug = slugify(title), s = slug, n = 2;
      while (used.has(s)) s = `${slug}-${n++}`;
      used.add(s);
      fs.writeFileSync(path.join(out, s + '.cho'), header + '\n' + body + '\n');
      ok++;
    } catch (e) {
      console.log('ERROR', f, e.message);
    }
  }
  console.log(`${ok}/${files.length} canciones convertidas`);
}
