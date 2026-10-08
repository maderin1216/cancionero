// App de escritorio: muestra la misma app web y le da acceso a la carpeta local de Dropbox.
import { app, BrowserWindow, ipcMain, dialog, protocol, net, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeFsApi } from './fs-api.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', 'app');
const configFile = () => path.join(app.getPath('userData'), 'config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
}
function writeConfig(c) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(c, null, 2));
}

/** Busca la carpeta de la app dentro de Dropbox: Dropbox/Aplicaciones/<app>/ con una subcarpeta canciones. */
function detectRoot() {
  let dropbox = path.join(app.getPath('home'), 'Dropbox');
  try {
    const info = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA || '', 'Dropbox', 'info.json'), 'utf8'));
    dropbox = info.personal?.path || info.business?.path || dropbox;
  } catch { /* Dropbox no instalado o sin info.json */ }
  for (const apps of ['Aplicaciones', 'Apps']) {
    let names = [];
    try { names = fs.readdirSync(path.join(dropbox, apps)); } catch { continue; }
    for (const n of names) {
      const dir = path.join(dropbox, apps, n);
      if (fs.existsSync(path.join(dir, 'canciones'))) return dir;
    }
  }
  return null;
}

let root = readConfig().root;
if (!root || !fs.existsSync(root)) {
  root = null;
  app.whenReady().then(() => { root = detectRoot(); if (root) writeConfig({ ...readConfig(), root }); });
}

const api = makeFsApi(() => root);

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

ipcMain.handle('fs:list', () => (root ? api.list() : []));
ipcMain.handle('fs:read', (_e, p) => api.read(p));
ipcMain.handle('fs:write', (_e, p, t) => api.write(p, t));
ipcMain.handle('fs:remove', (_e, p) => api.remove(p));
ipcMain.handle('root:get', () => root);
ipcMain.handle('root:choose', async e => {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showOpenDialog(win, {
    title: 'Elegí la carpeta del Cancionero (la que tiene "canciones" y "listas")',
    defaultPath: root || app.getPath('home'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return false;
  root = r.filePaths[0];
  writeConfig({ ...readConfig(), root });
  return true;
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 900, title: 'Cancionero', autoHideMenuBar: true,
    icon: path.join(here, 'icon.png'),
    webPreferences: { preload: path.join(here, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  win.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') win.setFullScreen(!win.isFullScreen());
    if (input.key === 'F5') win.webContents.reload();
    if (input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.loadURL('app://cancionero/index.html');
}

app.whenReady().then(() => {
  protocol.handle('app', req => {
    const { pathname } = new URL(req.url);
    const file = path.join(appDir, decodeURIComponent(pathname));
    if (!file.startsWith(appDir)) return new Response('', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
