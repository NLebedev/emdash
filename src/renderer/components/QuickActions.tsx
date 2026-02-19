import React, { useEffect, useState, useCallback } from 'react';
import type { QuickAction } from '../../main/services/LifecycleScriptsService';

interface Props {
  projectPath: string | null | undefined;
  terminalId: string;
}

export const QuickActions: React.FC<Props> = ({ projectPath, terminalId }) => {
  const [actions, setActions] = useState<QuickAction[]>([]);

  useEffect(() => {
    if (!projectPath) return;

    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI.getProjectConfig(projectPath);
        if (cancelled || !result.success || !result.content) return;
        const config = JSON.parse(result.content);
        if (Array.isArray(config.quickActions)) {
          setActions(config.quickActions);
        }
      } catch {
        // ignore – no config or invalid JSON
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectPath]);

  const handleClick = useCallback(
    (action: QuickAction) => {
      const autoSubmit = action.autoSubmit !== false;
      // Send text first, then Enter separately after a short delay.
      // Sending them together causes Claude Code to treat it as a pasted
      // multi-line block instead of typed input + submit.
      window.electronAPI?.ptyInput?.({
        id: terminalId,
        data: autoSubmit ? action.command : action.command + ' ',
      });
      if (autoSubmit) {
        setTimeout(() => {
          window.electronAPI?.ptyInput?.({ id: terminalId, data: '\r' });
        }, 50);
      }
    },
    [terminalId]
  );

  if (actions.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto">
      {actions.map((action, i) => (
        <button
          key={i}
          onClick={() => handleClick(action)}
          className="inline-flex h-7 shrink-0 items-center rounded-md border border-border bg-muted px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/80 hover:text-foreground"
          title={action.command}
        >
          {action.label}
        </button>
      ))}
    </div>
  );
};
