const { app, BrowserWindow, globalShortcut, clipboard, desktopCapturer, ipcMain, screen } = require('electron');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ─── GPU & Display Fixes ────────────────────────────────────────
app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('force-color-profile', 'srgb');
app.commandLine.appendSwitch('disable-features', 'ColorCorrectRendering,GpuProcessHighPriority');
app.commandLine.appendSwitch('use-angle', 'gl');
app.commandLine.appendSwitch('disable-direct-composition');

// ─── Single Instance Lock ────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

// ─── State ───────────────────────────────────────────────────────
let mainWindow;
let isProcessing = false;

// ─── Win32 Stealth API ───────────────────────────────────────────
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
  mainWindow.once('ready-to-show', () => applyWindowStealth(mainWindow));
  applyWindowStealth(mainWindow);
}

// ─── Screen Capture (NO OCR — sends raw image to vision model) ───
async function captureScreen() {
  if (!mainWindow || isProcessing) return;
  isProcessing = true;

  const wasVisible = mainWindow.isVisible();
  try {
    if (wasVisible) {
      mainWindow.hide();
      await new Promise(r => setTimeout(r, 150));
    }

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 1920, height: 1080 }
    });

    const primarySource = sources[0];
    if (!primarySource) {
      if (wasVisible) mainWindow.showInactive();
      mainWindow.webContents.send('status-update', '⚠️ No screen source');
      isProcessing = false;
      return;
    }

    // Use JPEG for smaller size + better 10-bit display compatibility
    const screenshot = primarySource.thumbnail.toJPEG(85);
    const base64Image = screenshot.toString('base64');

    if (wasVisible) {
      mainWindow.showInactive();
      mainWindow.setAlwaysOnTop(true, 'screen-saver');
    }

    // Send raw image to frontend for vision model processing
    mainWindow.webContents.send('screen-captured-image', base64Image);

  } catch (err) {
    console.error('[Ghost] Capture Error:', err.message);
    if (wasVisible && !mainWindow.isVisible()) {
      mainWindow.showInactive();
    }
    mainWindow.webContents.send('status-update', '⚠️ Capture failed');
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
  captureScreen();
});

// ─── App Lifecycle ───────────────────────────────────────────────
app.whenReady().then(() => {
  createWindow();

  const shortcuts = {
    'CommandOrControl+L': () => {
      if (mainWindow.isVisible()) {
        mainWindow.hide();
      } else {
        mainWindow.showInactive();
        mainWindow.setAlwaysOnTop(true, 'screen-saver');
      }
    },
    'CommandOrControl+A': () => captureScreen()
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

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
