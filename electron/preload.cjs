// Puente seguro entre la página y el disco: sólo expone estas operaciones.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cancioneroFS', {
  list: () => ipcRenderer.invoke('fs:list'),
  read: p => ipcRenderer.invoke('fs:read', p),
  write: (p, t) => ipcRenderer.invoke('fs:write', p, t),
  remove: p => ipcRenderer.invoke('fs:remove', p),
  getRoot: () => ipcRenderer.invoke('root:get'),
  chooseRoot: () => ipcRenderer.invoke('root:choose'),
});
