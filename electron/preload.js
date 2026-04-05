'use strict';
/**
 * Preload script — runs in renderer context with access to
 * a limited Node.js API via contextBridge.
 * contextIsolation: true ensures the renderer cannot access
 * Node.js APIs directly.
 */
const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe, minimal API to the renderer (web pages)
contextBridge.exposeInMainWorld('electronAPI', {
  // App version
  getVersion: () => process.env.npm_package_version || '2.0.0',

  // Platform info
  platform: process.platform,

  // Notify main process (for future IPC use)
  send: (channel, data) => {
    const allowedChannels = ['app:minimize', 'app:maximize', 'app:close', 'app:reload'];
    if (allowedChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },

  // Receive events from main process
  on: (channel, callback) => {
    const allowedChannels = ['app:update', 'server:error'];
    if (allowedChannels.includes(channel)) {
      ipcRenderer.on(channel, (event, ...args) => callback(...args));
    }
  },
});

// DOM ready — inject Electron-specific helpers
window.addEventListener('DOMContentLoaded', () => {
  // Flag that we're running in Electron (for conditional UI)
  document.documentElement.setAttribute('data-electron', 'true');

  // Prevent default drag behaviour on non-input elements
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => e.preventDefault());
});
