const { app, BrowserWindow, globalShortcut, clipboard, desktopCapturer, ipcMain, screen } = require('electron');
const Tesseract = require('tesseract.js');
const { execSync } = require('child_process');

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
let isProcessing = false;

// ─── Win32 Stealth API (zero dependencies) ───────────────────────
// Three layers of stealth:
// 1. WDA_EXCLUDEFROMCAPTURE (0x11) — invisible to screen capture/recording
// 2. WS_EX_NOACTIVATE (0x08000000) — clicking the window does NOT steal
//    focus from the browser, so proctoring focus-detection is never triggered
// 3. WS_EX_TOOLWINDOW (0x80) — hidden from Alt+Tab

const fs = require('fs');
const path = require('path');

function applyWindowStealth(win) {
  win.setContentProtection(true);

  if (process.platform !== 'win32') return;

  try {
    const hwndBuf = win.getNativeWindowHandle();
    const hwnd = hwndBuf.readUInt32LE(0);

    const scriptPath = path.join(app.getPath('temp'), 'ghost_stealth.ps1');
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class G {
  [DllImport("user32.dll")] public static extern bool SetWindowDisplayAffinity(IntPtr h, uint a);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);
  [DllImport("user32.dll")] public static extern int SetWindowLong(IntPtr h, int i, int v);
}
"@ -Language CSharp
$h = [IntPtr]::new(${hwnd})
[G]::SetWindowDisplayAffinity($h, 0x11)
$s = [G]::GetWindowLong($h, -20)
[G]::SetWindowLong($h, -20, $s -bor 0x08000000 -bor 0x80)
`;

    fs.writeFileSync(scriptPath, script, 'utf8');

    // Run async so it doesn't block app startup
    const { exec } = require('child_process');
    exec(`powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`, {
      windowsHide: true,
      timeout: 30000
    }, (err) => {
      try { fs.unlinkSync(scriptPath); } catch (e) {}
      if (!err) {
        console.log('[Ghost] FULL STEALTH: Capture-proof + Focus-proof + Alt-Tab hidden');
      } else {
        console.log('[Ghost] Stealth partial (fallback active)');
      }
    });
  } catch (e) {
    console.log('[Ghost] Stealth error:', e.message);
  }
}

// ─── Pre-init Tesseract Worker ───────────────────────────────────
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
    x: screenW - 440,
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
  mainWindow.setMenuBarVisibility(false);

  // Apply stealth after the window is fully created
  mainWindow.once('ready-to-show', () => applyWindowStealth(mainWindow));
  applyWindowStealth(mainWindow);
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
