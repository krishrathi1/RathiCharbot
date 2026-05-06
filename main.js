const { app, BrowserWindow, globalShortcut, clipboard, desktopCapturer, ipcMain, screen } = require('electron');
const Tesseract = require('tesseract.js');

// ─── GPU & Display Fixes ────────────────────────────────────────
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'ColorCorrectRendering,GpuProcessHighPriority');
app.commandLine.appendSwitch('use-angle', 'gl');
app.commandLine.appendSwitch('disable-direct-composition');

// ─── Single Instance Lock (prevents zombie shortcut conflicts) ──
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

// ─── State ───────────────────────────────────────────────────────
let mainWindow;
let worker;
let lastClipboardText = '';
let isProcessing = false; // Prevent overlapping scans

// ─── Pre-init Tesseract Worker (runs once at startup) ────────────
(async () => {
  try {
    worker = await Tesseract.createWorker('eng');
    console.log('[Ghost] Tesseract Worker Ready');
  } catch (e) {
    console.error('[Ghost] Worker Init Error:', e.message);
  }
})();

// ─── Window Creation ─────────────────────────────────────────────
function createWindow() {
  const { width: screenW, height: screenH } = screen.getPrimaryDisplay().workAreaSize;

  mainWindow = new BrowserWindow({
    width: 420,
    height: 650,
    x: screenW - 440,  // Bottom-right positioning
    y: screenH - 670,
    resizable: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
  mainWindow.setContentProtection(true);
  mainWindow.setMenuBarVisibility(false);

  // Clipboard auto-detection (disabled — use explicit scan instead)
  // Uncomment below if you want auto clipboard detection:
  // setInterval(() => {
  //   const text = clipboard.readText();
  //   if (text && text !== lastClipboardText && text.trim().length > 10) {
  //     lastClipboardText = text;
  //     if (mainWindow.isVisible()) {
  //       mainWindow.webContents.send('clipboard-data', text);
  //     }
  //   }
  // }, 1500);
}

// ─── Screen Capture + OCR ────────────────────────────────────────
async function captureAndOCR() {
  if (!mainWindow || isProcessing) return;
  if (!worker) {
    mainWindow.webContents.send('status-update', '⚠️ OCR engine not ready');
    return;
  }

  isProcessing = true;

  const wasVisible = mainWindow.isVisible();
  try {
    // Hide window so it doesn't capture itself
    if (wasVisible) {
      mainWindow.hide();
      await new Promise(r => setTimeout(r, 150));
    }

    // Use 1280px width for fast OCR (good enough accuracy, much faster)
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1280, height: 720 }
    });

    const primarySource = sources[0];
    if (!primarySource) {
      if (wasVisible) mainWindow.showInactive();
      mainWindow.webContents.send('status-update', '⚠️ No screen source');
      isProcessing = false;
      return;
    }

    const screenshot = primarySource.thumbnail.toDataURL();

    // Show window back immediately so user sees progress
    if (wasVisible) {
      mainWindow.showInactive();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }

    mainWindow.webContents.send('status-update', '🔍 Analyzing...');

    const { data: { text } } = await worker.recognize(screenshot);
    const cleaned = text ? text.trim() : '';

    if (cleaned.length > 5) {
      mainWindow.webContents.send('screen-captured', cleaned);
    } else {
      mainWindow.webContents.send('status-update', '⚠️ No readable text found');
    }
  } catch (err) {
    console.error('[Ghost] OCR Error:', err.message);
    if (wasVisible && !mainWindow.isVisible()) {
      mainWindow.showInactive();
    }
    mainWindow.webContents.send('status-update', '⚠️ Scan failed');
  } finally {
    isProcessing = false;
  }
}

// ─── IPC Handlers ────────────────────────────────────────────────
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

ipcMain.on('trigger-scan', () => {
  captureAndOCR();
});

// ─── App Lifecycle ───────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();

  // Register shortcuts with individual error reporting
  const shortcuts = {
    'CommandOrControl+L': () => {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.showInactive();
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    },
    'CommandOrControl+A': () => captureAndOCR()
  };

  let allRegistered = true;
  for (const [key, handler] of Object.entries(shortcuts)) {
    const ok = globalShortcut.register(key, handler);
    if (!ok) {
      console.error(`[Ghost] Failed to register: ${key}`);
      allRegistered = false;
    }
  }

  if (allRegistered) {
    console.log('[Ghost] All shortcuts registered (Ctrl+L, Ctrl+A)');
  }
});

app.on('will-quit', async () => {
  globalShortcut.unregisterAll();
  if (worker) {
    try { await worker.terminate(); } catch (e) {}
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
