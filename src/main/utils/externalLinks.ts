import { BrowserWindow, shell } from 'electron';

function resolveDevAppUrlPrefix(): string {
  const parsed = Number(process.env.EMDASH_DEV_PORT || 3000);
  const port = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 3000;
  return `http://localhost:${port}`;
}

/**
 * Ensure any external HTTP(S) links open in the user’s default browser
 * rather than inside the Electron window. Keeps app navigation scoped
 * to our renderer while preserving expected link behavior.
 */
export function registerExternalLinkHandlers(win: BrowserWindow, isDev: boolean) {
  const wc = win.webContents;
  const devAppUrlPrefix = resolveDevAppUrlPrefix();

  // Handle window.open and target="_blank"
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Intercept navigations that would leave the app
  wc.on('will-navigate', (event, url) => {
    const isAppUrl = isDev ? url.startsWith(devAppUrlPrefix) : url.startsWith('file://');
    if (!isAppUrl && /^https?:\/\//i.test(url)) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });
}
