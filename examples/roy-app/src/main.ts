import { app, BrowserWindow } from 'electron';
import * as path from 'node:path';
import { initBellstate } from 'bellstate/main';

function createWindow(): void {
  const win = new BrowserWindow({
    width: 480,
    height: 620,
    title: 'roy-app — shared todos',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // The preload requires the bellstate npm package, which the default
      // renderer sandbox forbids. Context isolation stays on.
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'index.html'));
}

app.whenReady().then(async () => {
  // Every roy-app instance on this machine shares this store. The first
  // one spawns the daemon; it exits 60s after the last instance closes.
  await initBellstate({ namespace: 'roy-app', idleTimeout: 60 });
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
