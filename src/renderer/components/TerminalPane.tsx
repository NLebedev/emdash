import React, {
  useEffect,
  useRef,
  forwardRef,
  useImperativeHandle,
  useState,
  useCallback,
} from 'react';
import { terminalSessionRegistry } from '../terminal/SessionRegistry';
import type { SessionTheme } from '../terminal/TerminalSessionManager';
import { log } from '../lib/logger';
import { cn } from '@/lib/utils';
import { extractDroppedFilePaths } from '../lib/dndFilePaths';
import ExternalLinkModal from './ExternalLinkModal';

const escapeShellArg = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const sendEscapedPathsToPty = (ptyId: string, paths: string[]) => {
  if (paths.length === 0) return;
  const escaped = paths.map((path) => escapeShellArg(path)).join(' ');
  window.electronAPI.ptyInput({ id: ptyId, data: `${escaped} ` });
};

type Props = {
  id: string;
  cwd?: string;
  remote?: { connectionId: string };
  providerId?: string;
  autoApprove?: boolean;
  env?: Record<string, string>;
  mapShiftEnterToCtrlJ?: boolean;
  disableSnapshots?: boolean;
  onActivity?: () => void;
  onStartError?: (message: string) => void;
  onStartSuccess?: () => void;
  variant?: 'light' | 'dark';
  themeOverride?: SessionTheme;
  contentFilter?: string;
  initialPrompt?: string;
  onFirstMessage?: (message: string) => void;
  className?: string;
};

const TerminalPaneComponent = forwardRef<{ focus: () => void }, Props>(
  (
    {
      id,
      cwd,
      remote,
      providerId,
      autoApprove = false,
      env,
      mapShiftEnterToCtrlJ = false,
      disableSnapshots = false,
      onActivity,
      onStartError,
      onStartSuccess,
      variant = 'dark',
      themeOverride,
      contentFilter,
      initialPrompt,
      onFirstMessage,
      className,
    },
    ref
  ) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const terminalIdRef = useRef(id);
    const remoteRef = useRef(remote);
    const onStartSuccessRef = useRef(onStartSuccess);
    const onStartErrorRef = useRef(onStartError);
    const initialPromptRef = useRef(initialPrompt);
    const onFirstMessageRef = useRef(onFirstMessage);

    // Keep refs in sync so effects don't need to re-run on prop change
    useEffect(() => {
      terminalIdRef.current = id;
      remoteRef.current = remote;
      onStartSuccessRef.current = onStartSuccess;
      onStartErrorRef.current = onStartError;
      initialPromptRef.current = initialPrompt;
      onFirstMessageRef.current = onFirstMessage;
    });

    useImperativeHandle(ref, () => ({
      focus: () => {
        const session = terminalSessionRegistry.getSession(terminalIdRef.current);
        if (session) {
          session.focus();
        }
      },
    }));

    useEffect(() => {
      const ptyId = id;
      const container = containerRef.current;
      if (!container) return;

      try {
        terminalSessionRegistry.attach({
          taskId: ptyId,
          container,
          cwd,
          remote: remoteRef.current,
          providerId,
          autoApprove,
          env,
          mapShiftEnterToCtrlJ,
          disableSnapshots,
          theme: themeOverride || { base: variant === 'dark' ? 'dark' : 'light' },
          initialPrompt: initialPromptRef.current,
          onFirstMessage: (msg: string) => onFirstMessageRef.current?.(msg),
          initialSize: { cols: 80, rows: 24 }, // initial size will be adjusted by ResizeObserver in TerminalSessionManager
        });

        onStartSuccessRef.current?.();
      } catch (error) {
        log.error('[TerminalPane] failed to attach session', error);
        onStartErrorRef.current?.(error instanceof Error ? error.message : String(error));
      }

      return () => {
        terminalSessionRegistry.detach(ptyId);
      };
    }, [
      id,
      cwd,
      providerId,
      autoApprove,
      env,
      mapShiftEnterToCtrlJ,
      disableSnapshots,
      variant,
      themeOverride,
    ]);

    // Track active terminal state for context injection
    useEffect(() => {
      const ptyId = id;
      window.dispatchEvent(new CustomEvent('emdash:terminal:active', { detail: { ptyId } }));
      return () => {
        window.dispatchEvent(new CustomEvent('emdash:terminal:inactive', { detail: { ptyId } }));
      };
    }, [id]);

    const handleDragOver = (event: React.DragEvent) => {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    };

    const handleDrop = async (event: React.DragEvent) => {
      try {
        event.preventDefault();
        const dt = event.dataTransfer;
        if (!dt) return;
        const paths = extractDroppedFilePaths(dt, (file) =>
          window.electronAPI.resolveFilePath?.(file)
        );
        if (paths.length === 0) return;

        if (remoteRef.current?.connectionId) {
          // SSH terminal: transfer files to remote first via scp
          try {
            const result = await window.electronAPI.ptyScpToRemote({
              connectionId: remoteRef.current.connectionId,
              localPaths: paths,
            });
            if (result.success && result.remotePaths) {
              sendEscapedPathsToPty(terminalIdRef.current, result.remotePaths);
            } else if (result.error) {
              log.error('[TerminalPane] SCP failed', result.error);
            }
          } catch (err) {
            log.error('[TerminalPane] SCP exception', err);
          }
        } else {
          // Local terminal: send local paths
          sendEscapedPathsToPty(terminalIdRef.current, paths);
        }
      } catch (err) {
        log.error('[TerminalPane] onDrop failed', err);
      }
    };

    const [externalLink, setExternalLink] = useState<string | null>(null);

    const handleExternalLink = useCallback((event: Event) => {
      const customEvent = event as CustomEvent<{ url: string; ptyId: string }>;
      if (customEvent.detail?.ptyId === terminalIdRef.current) {
        setExternalLink(customEvent.detail.url);
      }
    }, []);

    useEffect(() => {
      window.addEventListener('emdash:terminal:external-link', handleExternalLink);
      return () => {
        window.removeEventListener('emdash:terminal:external-link', handleExternalLink);
      };
    }, [handleExternalLink]);

    return (
      <div
        className={cn('relative flex h-full w-full flex-col overflow-hidden', className)}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <div
          ref={containerRef}
          className="h-full w-full bg-inherit"
          style={{ filter: contentFilter }}
        />
        <ExternalLinkModal
          url={externalLink || ''}
          open={!!externalLink}
          onOpenChange={(open) => !open && setExternalLink(null)}
          onConfirm={() => {
            if (externalLink) window.electronAPI.openExternal(externalLink);
            setExternalLink(null);
          }}
        />
      </div>
    );
  }
);

TerminalPaneComponent.displayName = 'TerminalPane';

export const TerminalPane = React.memo(TerminalPaneComponent);
