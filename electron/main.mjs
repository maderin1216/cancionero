// App de escritorio: muestra la misma app web (los datos vienen del servidor, como en el celular).
import { app, BrowserWindow, Menu, protocol, net, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.join(here, '..', 'app');

protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

function createWindow() {
  const win = new BrowserWindow({
    width: 1280, height: 900, title: 'Cancionero', autoHideMenuBar: true,
    icon: path.join(here, 'icon.png'),
    webPreferences: { contextIsolation: true, sandbox: true },
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
  Menu.setApplicationMenu(null); // sin menú: Alt+letra queda libre para los atajos de acordes
  protocol.handle('app', req => {
    const { pathname } = new URL(req.url);
    const file = path.join(appDir, decodeURIComponent(pathname));
    if (!file.startsWith(appDir)) return new Response('', { status: 403 });
    return net.fetch(pathToFileURL(file).toString());
  });
  createWindow();
});

app.on('window-all-closed', () => app.quit());
