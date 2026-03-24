/**
 * preload.js — Secure IPC bridge
 * يربط الـ renderer بالـ main process بشكل آمن
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('siem', {
  // Get initial state (agents + events + server info)
  getState:     ()         => ipcRenderer.invoke('siem:get-state'),
  serverInfo:   ()         => ipcRenderer.invoke('siem:server-info'),
  disconnectAgent: (id)    => ipcRenderer.invoke('siem:disconnect-agent', id),
  openAgentFolder: ()      => ipcRenderer.invoke('siem:open-agent-folder'),

  // Listen for real-time events from main
  onEvent: (callback) => {
    ipcRenderer.on('siem:event', (_, data) => callback(data));
  },

  // Window controls
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close:    () => ipcRenderer.send('window:close'),
});

// Window controls handled via contextBridge above
