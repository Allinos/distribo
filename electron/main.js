'use strict';

const { app, BrowserWindow, Menu, dialog, shell } = require('electron');
const path = require('path');
const { fork } = require('child_process');

const PORT = process.env.PORT || 3000;
const SERVER_URL = `http://localhost:${PORT}`;
const MAX_RETRIES = 30;
const RETRY_INTERVAL = 500; // ms

let mainWindow = null;
let serverProcess = null;
let serverReady = false;

// ─── Start Express Server ────────────────────────────────────────────────────
function startExpressServer() {
  return new Promise((resolve, reject) => {
    const serverPath = path.join(__dirname, '..', 'src', 'app.js');

    serverProcess = fork(serverPath, [], {
      env: {
        ...process.env,
        PORT: String(PORT),
        NODE_ENV: 'production',
        ELECTRON: 'true',
        // Use app.getPath for user-data in packaged apps
        USER_DATA_PATH: app.getPath('userData'),
      },
      silent: true,
    });

    serverProcess.stdout?.on('data', (data) => {
      const msg = data.toString();
      console.log('[Express]', msg.trim());
      if (msg.includes('ERP Server running')) {
        serverReady = true;
        resolve();
      }
    });

    serverProcess.stderr?.on('data', (data) => {
      console.error('[Express Error]', data.toString().trim());
    });

    serverProcess.on('error', (err) => {
      console.error('Failed to start Express server:', err);
      reject(err);
    });

    serverProcess.on('exit', (code, signal) => {
      if (code !== 0 && code !== null) {
        console.error(`Express server exited with code ${code}`);
        if (!serverReady) reject(new Error(`Server exited with code ${code}`));
      }
    });

    // Timeout fallback
    setTimeout(() => {
      if (!serverReady) reject(new Error('Server startup timed out after 15s'));
    }, 15000);
  });
}

// ─── Poll until server responds ──────────────────────────────────────────────
function waitForServer(retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    let attempts = 0;

    const check = () => {
      attempts++;
      const req = http.get(SERVER_URL, (res) => {
        resolve();
      });
      req.on('error', () => {
        if (attempts >= retries) {
          reject(new Error(`Server not reachable after ${retries} attempts`));
        } else {
          setTimeout(check, RETRY_INTERVAL);
        }
      });
      req.setTimeout(1000, () => {
        req.destroy();
        if (attempts >= retries) {
          reject(new Error('Server connection timed out'));
        } else {
          setTimeout(check, RETRY_INTERVAL);
        }
      });
    };

    check();
  });
}

// ─── Create Window ───────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    title: 'ERP System',
    show: false, // show after ready-to-show
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webSecurity: true,
    },
  });

  // Remove native menu bar
  Menu.setApplicationMenu(null);

  // Show window once DOM is ready (prevents white flash)
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(SERVER_URL)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

// ─── Show Loading Screen ─────────────────────────────────────────────────────
function showLoadingScreen(win) {
  win.loadURL(`data:text/html,
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          background: linear-gradient(135deg, #1e1b4b 0%, #4f46e5 100%);
          display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          height: 100vh; font-family: 'Segoe UI', sans-serif; color: white;
        }
        .logo { width: 64px; height: 64px; background: rgba(255,255,255,0.2);
          border-radius: 16px; display: flex; align-items: center;
          justify-content: center; font-size: 2rem; margin-bottom: 1.5rem; }
        h1 { font-size: 1.5rem; font-weight: 700; margin-bottom: 0.5rem; }
        p { opacity: 0.7; font-size: 0.9rem; margin-bottom: 2rem; }
        .spinner { width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.2);
          border-top-color: white; border-radius: 50%;
          animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .status { margin-top: 1rem; font-size: 0.8rem; opacity: 0.6; }
      </style>
    </head>
    <body>
      <div class="logo">⚡</div>
      <h1>ERP System</h1>
      <p>Starting application server...</p>
      <div class="spinner"></div>
      <div class="status">Please wait</div>
    </body>
    </html>
  `);
}

// ─── Show Error Screen ────────────────────────────────────────────────────────
function showErrorScreen(win, errorMessage) {
  win.loadURL(`data:text/html,
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          background: #1e1b4b; display: flex; flex-direction: column;
          align-items: center; justify-content: center;
          height: 100vh; font-family: 'Segoe UI', sans-serif; color: white;
        }
        .icon { font-size: 3rem; margin-bottom: 1rem; }
        h1 { font-size: 1.3rem; font-weight: 600; color: #f87171; margin-bottom: 0.75rem; }
        p { opacity: 0.7; font-size: 0.85rem; max-width: 400px; text-align: center; margin-bottom: 1.5rem; }
        code { background: rgba(255,255,255,0.1); padding: 0.5rem 1rem;
          border-radius: 6px; font-size: 0.78rem; display: block;
          max-width: 500px; word-break: break-all; margin-bottom: 1.5rem; }
        button { background: #4f46e5; color: white; border: none;
          padding: 0.6rem 1.5rem; border-radius: 6px; cursor: pointer; font-size: 0.9rem; }
        button:hover { background: #3730a3; }
      </style>
    </head>
    <body>
      <div class="icon">⚠️</div>
      <h1>Failed to Start Server</h1>
      <p>The ERP server could not be started. Please check your database configuration.</p>
      <code>${errorMessage}</code>
      <button onclick="location.reload()">Retry</button>
    </body>
    </html>
  `);
}

// ─── App Lifecycle ────────────────────────────────────────────────────────────
app.whenReady().then(async () => {
  const win = createWindow();
  showLoadingScreen(win);
  win.show();

  try {
    await startExpressServer();
    await waitForServer();
    console.log('✅ Server ready — loading app');
    win.loadURL(SERVER_URL);
  } catch (err) {
    console.error('Startup failed:', err.message);
    showErrorScreen(win, err.message);
  }
});

app.on('window-all-closed', () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
    serverProcess = null;
  }
});

// Handle unhandled rejections gracefully
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection in main process:', err);
});
