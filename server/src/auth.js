// Contraseñas y sesiones. Las contraseñas se guardan con PBKDF2-SHA256 y sal aleatoria.

const ITER = 100000; // máximo que permite Cloudflare Workers
const enc = new TextEncoder();

const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function pbkdf2(password, salt, iter) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITER))}`;
}

export async function verifyPassword(password, stored) {
  const [kind, iter, salt, hash] = (stored || '').split('$');
  if (kind !== 'pbkdf2') return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt), +iter));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i]; // comparación en tiempo constante
  return diff === 0;
}

export function newToken() {
  return b64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function tokenHash(token) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(token));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function checkPasswordStrength(p) {
  if (typeof p !== 'string' || p.length < 6) return 'La contraseña tiene que tener al menos 6 caracteres';
  if (p.length > 200) return 'Contraseña demasiado larga';
  return null;
}
