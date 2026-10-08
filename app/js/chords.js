// Acordes: reconocimiento, transporte y notación (latina DO RE MI… o americana C D E…).

const LATIN_ROOTS = { DO: 0, RE: 2, MI: 4, FA: 5, SOL: 7, LA: 9, SI: 11 };
const US_ROOTS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

const SHARP_LATIN = ['DO', 'DO#', 'RE', 'RE#', 'MI', 'FA', 'FA#', 'SOL', 'SOL#', 'LA', 'LA#', 'SI'];
const FLAT_LATIN = ['DO', 'REb', 'RE', 'MIb', 'MI', 'FA', 'SOLb', 'SOL', 'LAb', 'LA', 'SIb', 'SI'];
const SHARP_US = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_US = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

// Tonalidades (por semitono de la tónica) que se escriben con bemoles.
const FLAT_MAJOR = new Set([5, 10, 3, 8, 1]);   // FA SIb MIb LAb REb
const FLAT_MINOR = new Set([2, 7, 0, 5, 10]);   // REm SOLm DOm FAm SIbm

const ROOT_RE = '(DO|RE|MI|FA|SOL|LA|SI|Do|Re|Mi|Fa|Sol|La|Si|[A-G])([#b♯♭]?)';
const QUAL_RE = '((?:maj|min|dim|aug|sus|add|m|M|[0-9]|[+°º-])*)';
const CHORD_RE = new RegExp(`^${ROOT_RE}${QUAL_RE}(?:\\((${ROOT_RE.slice(1, -1)}[#b♯♭]?)\\)|/(${ROOT_RE.slice(1, -1)}[#b♯♭]?))?$`);

function rootIndex(name, acc) {
  const up = name.toUpperCase();
  let i = LATIN_ROOTS[up] ?? US_ROOTS[up];
  if (i === undefined) return null;
  if (acc === '#' || acc === '♯') i++;
  if (acc === 'b' || acc === '♭') i--;
  return (i + 12) % 12;
}

function parseNote(s) {
  const m = s.match(new RegExp(`^${ROOT_RE}$`));
  return m ? rootIndex(m[1], m[2]) : null;
}

/** Devuelve {root, quality, bass, bassStyle} o null si no es un acorde. */
export function parseChord(str) {
  const m = str.match(CHORD_RE);
  if (!m) return null;
  const root = rootIndex(m[1], m[2]);
  if (root === null) return null;
  const bassStr = m[4] ?? m[5];
  return {
    root,
    quality: m[3] || '',
    bass: bassStr ? parseNote(bassStr) : null,
    bassStyle: m[4] ? 'paren' : 'slash',
  };
}

export const isChordToken = t => parseChord(t) !== null;

export const isMinor = q => /^m(?!aj)/.test(q) || q.startsWith('min');

/** Escribe un semitono como nota, según notación y si la tonalidad usa bemoles. */
export function noteName(i, { notation = 'latin', flats = false } = {}) {
  const t = notation === 'latin' ? (flats ? FLAT_LATIN : SHARP_LATIN) : (flats ? FLAT_US : SHARP_US);
  return t[((i % 12) + 12) % 12];
}

/** ¿La tonalidad con tónica `i` (mayor o menor) se escribe con bemoles? */
export function keyUsesFlats(i, minor) {
  return (minor ? FLAT_MINOR : FLAT_MAJOR).has(((i % 12) + 12) % 12);
}

/** Transpone un acorde `semis` semitonos. Si no se reconoce lo devuelve tal cual. */
export function transposeChord(str, semis, opts = {}) {
  const c = parseChord(str);
  if (!c) return str;
  const o = { notation: opts.notation ?? 'latin', flats: opts.flats ?? false };
  let out = noteName(c.root + semis, o) + c.quality;
  if (c.bass !== null) {
    const b = noteName(c.bass + semis, o);
    out += c.bassStyle === 'paren' ? `(${b})` : `/${b}`;
  }
  return out;
}

/** Parsea una tonalidad como "SOL", "MIm", "Bb". Devuelve {root, minor} o null. */
export function parseKey(str) {
  const c = str && parseChord(str.trim());
  return c ? { root: c.root, minor: isMinor(c.quality) } : null;
}

export function keyName(k, notation = 'latin') {
  if (!k) return '';
  return noteName(k.root, { notation, flats: keyUsesFlats(k.root, k.minor) }) + (k.minor ? 'm' : '');
}

/** Adivina la tonalidad: el primer acorde suele ser la tónica. */
export function guessKey(chords) {
  for (const ch of chords) {
    const c = parseChord(ch);
    if (c) return { root: c.root, minor: isMinor(c.quality) };
  }
  return null;
}
