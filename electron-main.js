'use strict';

const { app, BrowserWindow } = require('electron');
const path = require('path');

let mainWindow;

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'CodeDB',
    icon: path.join(__dirname, 'public', 'favicon.ico'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  mainWindow.loadURL(`http://127.0.0.1:${port}`);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  const port = process.env.PORT || 3030;
  // Require and start embedded express server
  require('./server.js');
  setTimeout(() => createWindow(port), 800);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    const port = process.env.PORT || 3030;
    createWindow(port);
  }
});
