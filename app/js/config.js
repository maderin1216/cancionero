// Configuración de la app.

// Versión de la app: se sube en cada lote de correcciones (1.0, 1.1, 1.2… 2.0…).
// Al cambiarla, actualizar también CACHE en sw.js y "version" en package.json.
export const APP_VERSION = '2.8';

// Dirección del servidor (Cloudflare). La app web se sirve desde ahí mismo, así que en el navegador
// la API está en el mismo sitio; la app de escritorio (app://) necesita la dirección completa.
export const SERVER_URL = 'https://cancionero.cancionero.workers.dev';
export const API_BASE = location.protocol === 'app:' ? SERVER_URL : '';
