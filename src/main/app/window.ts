import { BrowserWindow } from 'electron';
import { join } from 'path';
import { isDev } from '../utils/dev';
import { registerExternalLinkHandlers } from '../utils/externalLinks';
import { ensureRendererServer } from './staticServer';

let mainWindow: BrowserWindow | null = null;
const E2E_DIFF_SMOKE_HASH = '/e2e/diff-smoke';

function appendHash(url: string, hashPath?: string | null): string {
  if (!hashPath) return url;
  return `${url}#${hashPath}`;
}

function resolveDevRendererUrl(): string {
  const parsed = Number(process.env.EMDASH_DEV_PORT || 3000);
  const port = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3000;
  return `http://localhost:${port}`;
}

export function createMainWindow(): BrowserWindow {
  // In development, resolve icon from src/assets
  // In production (packaged), electron-builder handles the icon
  const iconPath = isDev
    ? join(__dirname, '..', '..', '..', 'src', 'assets', 'images', 'emdash', 'emdash_logo.png')
    : undefined;

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1200,
    minHeight: 800,
    title: 'Emdash',
    ...(iconPath && { icon: iconPath }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // Allow using <webview> in renderer for in‑app browser pane.
      // The webview runs in a separate process; nodeIntegration remains disabled.
      webviewTag: true,
      // __dirname here resolves to dist/main/main/app at runtime (dev)
      // Preload is emitted to dist/main/main/preload.js
      preload: join(__dirname, '..', 'preload.js'),
    },
    titleBarStyle: 'hiddenInset',
    show: false,
  });

  const e2eHashPath = process.argv.includes('--e2e-diff-smoke') ? E2E_DIFF_SMOKE_HASH : null;

  if (isDev) {
    mainWindow.loadURL(appendHash(resolveDevRendererUrl(), e2eHashPath));
  } else {
    // Serve renderer over an HTTP origin in production so embeds work.
    const rendererRoot = join(__dirname, '..', '..', '..', 'renderer');
    void ensureRendererServer(rendererRoot)
      .then((url: string) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.loadURL(appendHash(url, e2eHashPath));
        }
      })
      .catch(() => {
        // Fallback to file load if server fails for any reason.
        if (mainWindow && !mainWindow.isDestroyed()) {
          if (e2eHashPath) {
            mainWindow.loadFile(join(rendererRoot, 'index.html'), { hash: e2eHashPath });
          } else {
            mainWindow.loadFile(join(rendererRoot, 'index.html'));
          }
        }
      });
  }

  // Route external links to the user’s default browser
  registerExternalLinkHandlers(mainWindow, isDev);

  // Show when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
  });

  // Track window focus for telemetry
  mainWindow.on('focus', () => {
    // Lazy import to avoid circular dependencies
    void import('../telemetry').then(({ capture, checkAndReportDailyActiveUser }) => {
      void capture('app_window_focused');
      // Also check for daily active user when window gains focus
      checkAndReportDailyActiveUser();
    });
  });

  // Cleanup reference on close
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
