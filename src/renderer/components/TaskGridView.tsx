import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, ChevronLeft, ChevronRight, GripVertical, Layers, Plus } from 'lucide-react';
import { makePtyId } from '@shared/ptyId';
import { getTaskEnvVars } from '@shared/task/envVars';
import { PROVIDER_IDS, type ProviderId } from '@shared/providers/registry';
import { TerminalPane } from './TerminalPane';
import AgentLogo from './AgentLogo';
import { CreateChatModal } from './CreateChatModal';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Spinner } from './ui/spinner';
import { cn } from '@/lib/utils';
import { useTaskBusy } from '../hooks/useTaskBusy';
import { useTheme } from '../hooks/useTheme';
import { agentConfig } from '../lib/agentConfig';
import { extractDroppedFilePaths, hasFilesInDataTransfer } from '../lib/dndFilePaths';
import { agentMeta } from '../providers/meta';
import type { Project, Task } from '../types/app';
import { type Conversation } from '../../main/services/DatabaseService';
import { rpc } from '@/lib/rpc';

const CONVERSATIONS_CHANGED_EVENT = 'emdash:conversations-changed';
const GRID_SLOT_OPTIONS = [2, 4, 6, 9] as const;
type GridSlotCount = (typeof GRID_SLOT_OPTIONS)[number];

const GRID_SCOPE_KEY = 'taskGrid:scopeProjectId';
const GRID_SLOT_COUNT_KEY = 'taskGrid:slotCount';
const GRID_ORDER_PROJECT_KEY = (projectId: string) => `taskGrid:order:project:${projectId}`;
const GRID_ORDER_ALL_KEY = 'taskGrid:order:all-projects';

const GRID_LAYOUT: Record<GridSlotCount, { columns: number; rows: number }> = {
  2: { columns: 2, rows: 1 },
  4: { columns: 2, rows: 2 },
  6: { columns: 3, rows: 2 },
  9: { columns: 3, rows: 3 },
};

const MIN_COLUMN_SIZE_PX = 220;
const MIN_ROW_SIZE_PX = 140;
const RESIZE_HANDLE_SIZE_PX = 8;

const createEqualFractions = (count: number): number[] =>
  count <= 0 ? [] : Array.from({ length: count }, () => 1 / count);

const normalizeFractions = (fractions: number[], expectedCount: number): number[] => {
  if (expectedCount <= 0) return [];

  if (fractions.length !== expectedCount) {
    return createEqualFractions(expectedCount);
  }

  const cleaned = fractions.map((value) => (Number.isFinite(value) && value > 0 ? value : 0));
  const total = cleaned.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return createEqualFractions(expectedCount);
  return cleaned.map((value) => value / total);
};

const fractionsEqual = (left: number[], right: number[]) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (Math.abs(left[index] - right[index]) > 0.0001) {
      return false;
    }
  }
  return true;
};

const getBoundaryPercents = (fractions: number[]) => {
  let running = 0;
  const boundaries: number[] = [];
  for (let index = 0; index < fractions.length - 1; index += 1) {
    running += fractions[index];
    boundaries.push(running * 100);
  }
  return boundaries;
};

const getVisiblePageIndexes = (pageCount: number, activePageIndex: number) => {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, index) => index);
  }

  const windowSize = 5;
  const startIndex = Math.max(0, Math.min(activePageIndex - 2, pageCount - windowSize));
  return Array.from({ length: windowSize }, (_, offset) => startIndex + offset);
};

const escapeShellArg = (value: string) => `'${value.replace(/'/g, "'\\''")}'`;

const sendEscapedPathsToPty = (ptyId: string, paths: string[]) => {
  if (paths.length === 0) return;
  const escaped = paths.map((path) => escapeShellArg(path)).join(' ');
  window.electronAPI.ptyInput({ id: ptyId, data: `${escaped} ` });
};

type ResizeAxis = 'column' | 'row';

type ResizeDragState = {
  axis: ResizeAxis;
  boundaryIndex: number;
  startPointer: number;
  containerSize: number;
  startBeforePx: number;
  startAfterPx: number;
};

type TerminalTarget = {
  id: string;
  provider: ProviderId;
};

type GridTaskItem = {
  key: string;
  task: Task;
  project: Project;
  projectPath: string;
  projectRemoteConnectionId: string | null;
  defaultBranch: string | null;
};

const makeGridTaskKey = (projectId: string, taskId: string) => `${projectId}::${taskId}`;

const isProviderId = (value: unknown): value is ProviderId => {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
};

const resolveStoredProvider = (taskId: string, taskAgentId?: string): ProviderId => {
  if (isProviderId(taskAgentId)) {
    return taskAgentId;
  }

  try {
    const stored = localStorage.getItem(`taskAgent:${taskId}`);
    if (isProviderId(stored)) {
      return stored;
    }
  } catch {
    // Ignore localStorage failures.
  }

  return 'codex';
};

const buildMainTarget = (taskId: string, provider: ProviderId): TerminalTarget => ({
  id: makePtyId(provider, 'main', taskId),
  provider,
});

const sortConversations = (conversations: Conversation[]): Conversation[] => {
  return [...conversations].sort((left, right) => {
    if (left.displayOrder !== undefined && right.displayOrder !== undefined) {
      return left.displayOrder - right.displayOrder;
    }
    return new Date(left.createdAt).getTime() - new Date(right.createdAt).getTime();
  });
};

const resolveConversationProvider = (
  conversation: Pick<Conversation, 'provider'> | null | undefined,
  fallbackProvider: ProviderId
): ProviderId => {
  return isProviderId(conversation?.provider)
    ? (conversation.provider as ProviderId)
    : fallbackProvider;
};

const buildTargetFromConversation = (
  taskId: string,
  fallbackProvider: ProviderId,
  conversation: Conversation | null | undefined
): TerminalTarget => {
  const provider = resolveConversationProvider(conversation, fallbackProvider);
  if (conversation && !conversation.isMain && conversation.id) {
    return {
      id: makePtyId(provider, 'chat', String(conversation.id)),
      provider,
    };
  }
  return buildMainTarget(taskId, provider);
};

const loadConversationsForTask = async (taskId: string): Promise<Conversation[]> => {
  try {
    const conversations = await rpc.db.getConversations(taskId);
    if (conversations && Array.isArray(conversations) && conversations.length > 0) {
      return sortConversations(conversations as Conversation[]);
    }

    const defaultConversation = await rpc.db.getOrCreateDefaultConversation({
      taskId,
      provider: 'claude',
    });
    if (defaultConversation) {
      return [defaultConversation as Conversation];
    }
  } catch (error) {
    console.error('Failed to load conversations for grid task', error);
  }

  return [];
};

const loadGridScopeProjectId = (): string | null => {
  try {
    const raw = localStorage.getItem(GRID_SCOPE_KEY);
    if (!raw || raw === 'all') return null;
    return raw;
  } catch {
    // Ignore localStorage failures.
  }
  return null;
};

const loadGridSlotCount = (): GridSlotCount => {
  try {
    const raw = localStorage.getItem(GRID_SLOT_COUNT_KEY);
    const parsed = Number(raw);
    if ((GRID_SLOT_OPTIONS as readonly number[]).includes(parsed)) {
      return parsed as GridSlotCount;
    }
  } catch {
    // Ignore localStorage failures.
  }
  return 4;
};

const loadTaskOrder = (storageKey: string): string[] => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    return [];
  }
};

const dedupeIds = (ids: string[]) => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
};

const moveIdToIndex = (ids: string[], id: string, targetIndex: number): string[] => {
  const unique = dedupeIds(ids);
  const sourceIndex = unique.indexOf(id);
  if (sourceIndex === -1) return unique;

  const next = [...unique];
  next.splice(sourceIndex, 1);

  const clampedTarget = Math.max(0, Math.min(targetIndex, next.length));
  next.splice(clampedTarget, 0, id);
  return next;
};

const SplitButton: React.FC<{
  option: GridSlotCount;
  active: boolean;
  onClick: () => void;
}> = ({ option, active, onClick }) => {
  const gridColsClass = option === 2 ? 'grid-cols-2' : option === 4 ? 'grid-cols-2' : 'grid-cols-3';

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded px-2 text-xs font-medium transition-colors',
        active
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
      )}
      aria-label={`Set grid split to ${option}`}
      title={`Split ${option}`}
    >
      <span className={cn('grid h-3.5 w-3.5 gap-[2px]', gridColsClass)}>
        {Array.from({ length: option }).map((_, index) => (
          <span
            key={`${option}-${index}`}
            className={cn(
              'border-current/40 rounded-[1px] border',
              active ? 'bg-current/80' : 'bg-current/30'
            )}
          />
        ))}
      </span>
      <span>{option}</span>
    </button>
  );
};

interface TaskTerminalTileProps {
  item: GridTaskItem;
  active: boolean;
  isDropTarget: boolean;
  showProjectBadge: boolean;
  installedAgents: string[];
  onSelectTaskInProject: (project: Project, task: Task) => void;
  onOpenTaskInProject: (project: Project, task: Task) => void;
  onDragHandleStart: (itemKey: string) => void;
  onDragHandleEnd: () => void;
  onDragOverSlot: (index: number, event: React.DragEvent<HTMLElement>) => void;
  onDropSlot: (index: number) => void;
  slotIndex: number;
}

const TaskTerminalTile: React.FC<TaskTerminalTileProps> = ({
  item,
  active,
  isDropTarget,
  showProjectBadge,
  installedAgents,
  onSelectTaskInProject,
  onOpenTaskInProject,
  onDragHandleStart,
  onDragHandleEnd,
  onDragOverSlot,
  onDropSlot,
  slotIndex,
}) => {
  const { effectiveTheme } = useTheme();
  const busy = useTaskBusy(item.task.id);
  const [target, setTarget] = useState<TerminalTarget | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [showCreateChatModal, setShowCreateChatModal] = useState(false);
  const [needsAttention, setNeedsAttention] = useState(false);
  const taskId = item.task.id;
  const taskAgentId = item.task.agentId;
  const prevBusyRef = useRef<boolean>(busy);
  const busySinceClearRef = useRef<boolean>(busy);
  const fallbackProvider = useMemo(
    () => resolveStoredProvider(taskId, taskAgentId),
    [taskId, taskAgentId]
  );
  const sortedConversations = useMemo(() => sortConversations(conversations), [conversations]);

  const taskEnv = useMemo(() => {
    return getTaskEnvVars({
      taskId: item.task.id,
      taskName: item.task.name,
      taskPath: item.task.path,
      projectPath: item.projectPath,
      defaultBranch: item.defaultBranch || undefined,
    });
  }, [item.task.id, item.task.name, item.task.path, item.projectPath, item.defaultBranch]);

  const applyConversations = useCallback(
    async (rawConversations: Conversation[]) => {
      const sorted = sortConversations(rawConversations);
      const nextActiveConversation =
        sorted.find((conversation) => conversation.isActive) ?? sorted[0] ?? null;

      if (nextActiveConversation && !nextActiveConversation.isActive) {
        try {
          await rpc.db.setActiveConversation({
            taskId,
            conversationId: nextActiveConversation.id,
          });
        } catch {
          // Ignore best-effort active conversation sync failures.
        }
      }

      setConversations(
        nextActiveConversation
          ? sorted.map((conversation) => ({
              ...conversation,
              isActive: conversation.id === nextActiveConversation.id,
            }))
          : sorted
      );
      setActiveConversationId(nextActiveConversation?.id ?? null);
      setTarget(buildTargetFromConversation(taskId, fallbackProvider, nextActiveConversation));
    },
    [fallbackProvider, taskId]
  );

  const reloadConversations = useCallback(async () => {
    try {
      const loadedConversations = await loadConversationsForTask(taskId);
      await applyConversations(loadedConversations);
    } catch {
      setConversations([]);
      setActiveConversationId(null);
      setTarget(buildMainTarget(taskId, fallbackProvider));
    }
  }, [applyConversations, fallbackProvider, taskId]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const loadedConversations = await loadConversationsForTask(taskId);
        if (cancelled) return;
        await applyConversations(loadedConversations);
      } catch {
        if (cancelled) return;
        setConversations([]);
        setActiveConversationId(null);
        setTarget(buildMainTarget(taskId, fallbackProvider));
      }
    };

    const handleConversationsChanged = (event: Event) => {
      const customEvent = event as CustomEvent<{ taskId?: string }>;
      if (customEvent.detail?.taskId !== taskId) {
        return;
      }
      void load();
    };

    void load();
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, handleConversationsChanged);

    return () => {
      cancelled = true;
      window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, handleConversationsChanged);
    };
  }, [applyConversations, fallbackProvider, taskId]);

  useEffect(() => {
    if (busy) {
      busySinceClearRef.current = true;
    }

    if (prevBusyRef.current && !busy && busySinceClearRef.current) {
      setNeedsAttention(true);
    }

    prevBusyRef.current = busy;
  }, [busy]);

  const clearAttention = () => {
    setNeedsAttention(false);
    busySinceClearRef.current = busy;
  };

  useEffect(() => {
    if (!target?.provider) return;
    try {
      localStorage.setItem(`taskAgent:${taskId}`, target.provider);
    } catch {
      // Ignore localStorage failures.
    }
  }, [taskId, target?.provider]);

  const handleSwitchConversation = async (conversationId: string) => {
    if (!conversationId || conversationId === activeConversationId) return;

    const selectedConversation = sortedConversations.find(
      (conversation) => conversation.id === conversationId
    );
    if (!selectedConversation) return;

    try {
      await rpc.db.setActiveConversation({ taskId, conversationId });
    } catch {
      // Ignore DB sync failures and still switch locally.
    }

    setActiveConversationId(conversationId);
    setConversations((current) =>
      current.map((conversation) => ({
        ...conversation,
        isActive: conversation.id === conversationId,
      }))
    );
    setTarget(buildTargetFromConversation(taskId, fallbackProvider, selectedConversation));
  };

  const handleCreateChat = async (title: string, newAgent: string) => {
    try {
      const result = await rpc.db.createConversation({
        taskId,
        title,
        provider: newAgent,
        isMain: false,
      });
      if (!result) return;

      await reloadConversations();
      try {
        window.dispatchEvent(new CustomEvent(CONVERSATIONS_CHANGED_EVENT, { detail: { taskId } }));
      } catch {
        // Ignore best-effort event dispatch failures.
      }
    } catch {
      // Ignore chat creation errors.
    }
  };

  const provider = target?.provider ?? fallbackProvider;
  const providerInfo = agentConfig[provider];
  const autoApproveEnabled =
    Boolean(item.task.metadata?.autoApprove) && Boolean(agentMeta[provider]?.autoApproveFlag);
  const isMultiAgentTask = Boolean(item.task.metadata?.multiAgent?.enabled);
  const modalInstalledAgents = installedAgents.length > 0 ? installedAgents : [provider];

  const conversationTabs = useMemo(() => {
    if (sortedConversations.length === 0) {
      return [];
    }

    const totalByProvider = new Map<ProviderId, number>();
    for (const conversation of sortedConversations) {
      const conversationProvider = resolveConversationProvider(conversation, fallbackProvider);
      totalByProvider.set(
        conversationProvider,
        (totalByProvider.get(conversationProvider) || 0) + 1
      );
    }

    const seenByProvider = new Map<ProviderId, number>();
    return sortedConversations.map((conversation) => {
      const conversationProvider = resolveConversationProvider(conversation, fallbackProvider);
      const index = (seenByProvider.get(conversationProvider) || 0) + 1;
      seenByProvider.set(conversationProvider, index);
      const duplicateCount = totalByProvider.get(conversationProvider) || 0;

      return {
        id: conversation.id,
        provider: conversationProvider,
        providerInfo: agentConfig[conversationProvider],
        label: agentConfig[conversationProvider]?.name || conversationProvider,
        index: duplicateCount > 1 ? index : null,
      };
    });
  }, [sortedConversations, fallbackProvider]);

  const handleTileDragOver = (event: React.DragEvent<HTMLElement>) => {
    if (hasFilesInDataTransfer(event.dataTransfer)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      return;
    }

    onDragOverSlot(slotIndex, event);
  };

  const sendPathsToTerminal = async (paths: string[]) => {
    if (!target || paths.length === 0) return;

    if (item.projectRemoteConnectionId) {
      try {
        const result = await window.electronAPI.ptyScpToRemote({
          connectionId: item.projectRemoteConnectionId,
          localPaths: paths,
        });
        if (!result.success || !result.remotePaths) return;
        const remotePaths = result.remotePaths.filter((path): path is string => Boolean(path));
        sendEscapedPathsToPty(target.id, remotePaths);
      } catch {
        // Ignore transfer errors.
      }
      return;
    }

    sendEscapedPathsToPty(target.id, paths);
  };

  const handleTileDrop = (event: React.DragEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;

    const droppedPaths = extractDroppedFilePaths(event.dataTransfer, (file) =>
      window.electronAPI.resolveFilePath?.(file)
    );
    if (droppedPaths.length > 0) {
      event.preventDefault();
      void sendPathsToTerminal(droppedPaths);
      return;
    }

    onDropSlot(slotIndex);
  };

  const isDark = effectiveTheme === 'dark' || effectiveTheme === 'dark-black';

  return (
    <section
      className={cn(
        'flex h-full min-h-0 w-full flex-col overflow-hidden bg-card transition-colors',
        needsAttention && 'bg-orange-500/10',
        isDropTarget && 'ring-2 ring-inset ring-primary/60'
      )}
      onDragOver={handleTileDragOver}
      onDrop={handleTileDrop}
      onMouseDownCapture={() => {
        clearAttention();
        if (!active) {
          onSelectTaskInProject(item.project, item.task);
        }
      }}
    >
      <CreateChatModal
        isOpen={showCreateChatModal}
        onClose={() => setShowCreateChatModal(false)}
        onCreateChat={handleCreateChat}
        installedAgents={modalInstalledAgents}
      />

      <header
        className={cn(
          'flex h-[clamp(36px,5.4vh,46px)] items-center gap-1.5 overflow-hidden border-b border-border bg-muted/30 px-2.5 py-0.5 transition-colors',
          active && 'bg-accent/70',
          needsAttention && 'bg-orange-500/15'
        )}
      >
        <button
          type="button"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', item.key);
            onDragHandleStart(item.key);
          }}
          onDragEnd={onDragHandleEnd}
          onMouseDown={(event) => event.stopPropagation()}
          className="inline-flex h-5 w-5 shrink-0 cursor-grab items-center justify-center rounded-sm border border-border bg-background text-muted-foreground hover:bg-muted active:cursor-grabbing"
          title="Drag to reorder"
          aria-label={`Drag task ${item.task.name}`}
        >
          <GripVertical className="h-2.5 w-2.5" />
        </button>

        <div className="flex min-w-0 shrink-0 items-center gap-1 overflow-hidden whitespace-nowrap text-[10px]">
          <span className="max-w-[12rem] truncate text-[12px] font-medium text-foreground">
            {item.task.name}
          </span>
          {showProjectBadge ? (
            <span className="max-w-[8rem] shrink-0 truncate rounded-sm border border-border bg-muted/60 px-1 py-0 text-[9px] text-muted-foreground">
              {item.project.name}
            </span>
          ) : null}
        </div>

        {!isMultiAgentTask ? (
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto py-0.5">
            {conversationTabs.length > 0 ? (
              conversationTabs.map((tab) => {
                const isActiveTab = tab.id === activeConversationId;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void handleSwitchConversation(tab.id);
                    }}
                    aria-current={isActiveTab ? 'page' : undefined}
                    className={cn(
                      'inline-flex h-6 shrink-0 items-center gap-1 rounded border px-1.5 text-[10px] font-medium transition-colors',
                      isActiveTab
                        ? 'border-primary bg-primary/10 text-foreground'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                    title={tab.label}
                  >
                    {tab.providerInfo?.logo ? (
                      <AgentLogo
                        logo={tab.providerInfo.logo}
                        alt={tab.providerInfo.alt}
                        isSvg={tab.providerInfo.isSvg}
                        invertInDark={tab.providerInfo.invertInDark}
                        className="h-3 w-3 shrink-0"
                      />
                    ) : null}
                    <span className="max-w-[8rem] truncate">
                      {tab.label}
                      {tab.index ? <span className="ml-1 opacity-60">{tab.index}</span> : null}
                    </span>
                  </button>
                );
              })
            ) : (
              <span className="inline-flex h-6 items-center rounded border border-border bg-background px-1.5 text-[10px] text-muted-foreground">
                {providerInfo?.name || provider}
              </span>
            )}

            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-6 w-6 shrink-0 p-0"
              onClick={(event) => {
                event.stopPropagation();
                setShowCreateChatModal(true);
              }}
              title="New chat"
              aria-label={`Create new chat for ${item.task.name}`}
            >
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>
        ) : (
          <div className="min-w-0 flex-1" />
        )}

        <div className="flex shrink-0 items-center gap-0.5">
          {busy ? <Spinner size="sm" className="h-3 w-3 text-muted-foreground" /> : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-5 w-5 p-0"
            onClick={(event) => {
              event.stopPropagation();
              clearAttention();
              onOpenTaskInProject(item.project, item.task);
            }}
            title={`Open ${item.task.name}`}
            aria-label={`Open ${item.task.name}`}
          >
            <ArrowUpRight className="h-3 w-3" />
          </Button>
        </div>
      </header>

      <div className="min-h-0 flex-1 bg-background">
        {isMultiAgentTask ? (
          <div className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground">
            <div className="space-y-2">
              <div className="mx-auto inline-flex h-8 w-8 items-center justify-center rounded-md border border-border">
                <Layers className="h-4 w-4" />
              </div>
              <div>Multi-agent task. Open it for the full orchestrated view.</div>
            </div>
          </div>
        ) : target ? (
          <TerminalPane
            id={target.id}
            cwd={item.task.path}
            remote={
              item.projectRemoteConnectionId
                ? { connectionId: item.projectRemoteConnectionId }
                : undefined
            }
            providerId={target.provider}
            autoApprove={autoApproveEnabled}
            env={taskEnv}
            mapShiftEnterToCtrlJ
            variant={isDark ? 'dark' : 'light'}
            themeOverride={{ base: isDark ? 'dark' : 'light' }}
            className="h-full w-full"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Spinner size="sm" />
          </div>
        )}
      </div>
    </section>
  );
};

const EmptySlotCard: React.FC<{
  slotIndex: number;
  isDropTarget: boolean;
  onCreateTaskInSlot: (slotIndex: number) => void;
  onDragOverSlot: (index: number, event: React.DragEvent<HTMLElement>) => void;
  onDropSlot: (index: number) => void;
}> = ({ slotIndex, isDropTarget, onCreateTaskInSlot, onDragOverSlot, onDropSlot }) => {
  const handleDragOver = (event: React.DragEvent<HTMLButtonElement>) => {
    if (hasFilesInDataTransfer(event.dataTransfer)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      return;
    }
    onDragOverSlot(slotIndex, event);
  };

  const handleDrop = (event: React.DragEvent<HTMLButtonElement>) => {
    const droppedPaths = extractDroppedFilePaths(event.dataTransfer, (file) =>
      window.electronAPI.resolveFilePath?.(file)
    );
    if (droppedPaths.length > 0) {
      event.preventDefault();
      return;
    }
    onDropSlot(slotIndex);
  };

  return (
    <button
      type="button"
      onClick={() => onCreateTaskInSlot(slotIndex)}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={cn(
        'flex h-full min-h-0 w-full items-center justify-center border border-dashed border-border bg-muted/20 text-muted-foreground transition-colors hover:bg-muted/35',
        isDropTarget && 'ring-2 ring-inset ring-primary/60'
      )}
      aria-label={`Create task in slot ${slotIndex + 1}`}
      title="Create task"
    >
      <Plus className="h-16 w-16 stroke-[1.5]" />
    </button>
  );
};

interface TaskGridViewProps {
  project: Project;
  projects: Project[];
  activeTask: Task | null;
  isGridEnabled: boolean;
  onGridEnabledChange: (enabled: boolean) => void;
  singleView: React.ReactNode;
  onSelectTaskInProject: (project: Project, task: Task) => void;
  onOpenTaskInProject: (project: Project, task: Task) => void;
  onCreateTaskForProject: (project: Project) => void;
  projectRemoteConnectionId?: string | null;
  defaultBranch?: string | null;
}

const TaskGridView: React.FC<TaskGridViewProps> = ({
  project,
  projects,
  activeTask,
  isGridEnabled,
  onGridEnabledChange,
  singleView,
  onSelectTaskInProject,
  onOpenTaskInProject,
  onCreateTaskForProject,
  projectRemoteConnectionId,
  defaultBranch,
}) => {
  const [scopeProjectId, setScopeProjectId] = useState<string | null>(null);
  const [slotCount, setSlotCount] = useState<GridSlotCount>(4);
  const [orderedItemKeys, setOrderedItemKeys] = useState<string[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [draggedItemKey, setDraggedItemKey] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [pendingCreateSlot, setPendingCreateSlot] = useState<{ index: number } | null>(null);
  const [projectPickerSlotIndex, setProjectPickerSlotIndex] = useState<number | null>(null);
  const [columnFractions, setColumnFractions] = useState<number[]>(createEqualFractions(2));
  const [rowFractions, setRowFractions] = useState<number[]>(createEqualFractions(2));
  const [installedAgents, setInstalledAgents] = useState<string[]>([]);
  const prevScopedKeysRef = useRef<string[]>([]);
  const gridSurfaceRef = useRef<HTMLDivElement | null>(null);
  const resizeDragRef = useRef<ResizeDragState | null>(null);
  const resizeMoveListenerRef = useRef<((event: PointerEvent) => void) | null>(null);
  const resizeUpListenerRef = useRef<((event: PointerEvent) => void) | null>(null);
  const gridLayout = GRID_LAYOUT[slotCount];

  useEffect(() => {
    setScopeProjectId(loadGridScopeProjectId());
    setSlotCount(loadGridSlotCount());
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadInstalledAgents = async () => {
      try {
        const getProviderStatuses = window.electronAPI.getProviderStatuses;
        if (typeof getProviderStatuses !== 'function') return;

        const res = await getProviderStatuses();
        if (cancelled) return;
        if (!res?.success || !res.statuses) return;

        const statuses = res.statuses as Record<string, { installed?: boolean } | undefined>;
        const nextInstalled = Object.entries(statuses)
          .filter(([, status]) => status?.installed === true)
          .map(([providerId]) => providerId);
        setInstalledAgents(nextInstalled);
      } catch {
        // Ignore provider status load failures.
      }
    };

    const offProviderStatusUpdated = window.electronAPI.onProviderStatusUpdated?.(
      (payload: { providerId: string; status?: { installed?: boolean } }) => {
        if (!payload?.providerId) return;
        setInstalledAgents((current) => {
          const isInstalled = payload.status?.installed === true;
          if (isInstalled) {
            if (current.includes(payload.providerId)) return current;
            return [...current, payload.providerId];
          }
          return current.filter((providerId) => providerId !== payload.providerId);
        });
      }
    );

    void loadInstalledAgents();

    return () => {
      cancelled = true;
      offProviderStatusUpdated?.();
    };
  }, []);

  const clearResizeListeners = () => {
    if (resizeMoveListenerRef.current) {
      window.removeEventListener('pointermove', resizeMoveListenerRef.current);
      resizeMoveListenerRef.current = null;
    }
    if (resizeUpListenerRef.current) {
      window.removeEventListener('pointerup', resizeUpListenerRef.current);
      resizeUpListenerRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearResizeListeners();
    };
  }, []);

  useEffect(() => {
    if (!scopeProjectId) return;
    if (projects.some((projectItem) => projectItem.id === scopeProjectId)) return;
    setScopeProjectId(project.id);
  }, [scopeProjectId, projects, project.id]);

  const scopedProjects = useMemo(() => {
    if (scopeProjectId === null) return projects;
    const match = projects.find((projectItem) => projectItem.id === scopeProjectId);
    return match ? [match] : [project];
  }, [scopeProjectId, projects, project]);

  const scopedItems = useMemo<GridTaskItem[]>(() => {
    return scopedProjects.flatMap((projectItem) => {
      const tasks = projectItem.tasks || [];
      return tasks.map((task) => ({
        key: makeGridTaskKey(projectItem.id, task.id),
        task,
        project: projectItem,
        projectPath: projectItem.path,
        projectRemoteConnectionId:
          projectItem.id === project.id
            ? projectRemoteConnectionId || projectItem.sshConnectionId || null
            : projectItem.sshConnectionId || null,
        defaultBranch:
          projectItem.id === project.id
            ? defaultBranch || projectItem.gitInfo?.baseRef || null
            : projectItem.gitInfo?.baseRef || null,
      }));
    });
  }, [scopedProjects, project.id, projectRemoteConnectionId, defaultBranch]);

  const scopedItemKeys = useMemo(() => scopedItems.map((item) => item.key), [scopedItems]);
  const itemByKey = useMemo(() => {
    const map = new Map<string, GridTaskItem>();
    for (const item of scopedItems) {
      map.set(item.key, item);
    }
    return map;
  }, [scopedItems]);

  const orderStorageKey =
    scopeProjectId === null ? GRID_ORDER_ALL_KEY : GRID_ORDER_PROJECT_KEY(scopeProjectId);
  const showProjectBadge = scopeProjectId === null;

  useEffect(() => {
    setOrderedItemKeys(loadTaskOrder(orderStorageKey));
    prevScopedKeysRef.current = scopedItemKeys;
    setPageIndex(0);
    setDragOverIndex(null);
    setDraggedItemKey(null);
    setPendingCreateSlot(null);
    setProjectPickerSlotIndex(null);
    resizeDragRef.current = null;
    clearResizeListeners();
  }, [orderStorageKey, scopedItemKeys]);

  useEffect(() => {
    try {
      localStorage.setItem(GRID_SCOPE_KEY, scopeProjectId ?? 'all');
    } catch {
      // Ignore localStorage failures.
    }
  }, [scopeProjectId]);

  useEffect(() => {
    try {
      localStorage.setItem(GRID_SLOT_COUNT_KEY, String(slotCount));
    } catch {
      // Ignore localStorage failures.
    }
  }, [slotCount]);

  useEffect(() => {
    setColumnFractions((current) => {
      const next = normalizeFractions(current, gridLayout.columns);
      return fractionsEqual(current, next) ? current : next;
    });
    setRowFractions((current) => {
      const next = normalizeFractions(current, gridLayout.rows);
      return fractionsEqual(current, next) ? current : next;
    });
  }, [gridLayout.columns, gridLayout.rows]);

  useEffect(() => {
    try {
      localStorage.setItem(orderStorageKey, JSON.stringify(orderedItemKeys));
    } catch {
      // Ignore localStorage failures.
    }
  }, [orderStorageKey, orderedItemKeys]);

  useEffect(() => {
    const scopedKeySet = new Set(scopedItemKeys);
    const prevScopedKeys = prevScopedKeysRef.current;
    const prevScopedSet = new Set(prevScopedKeys);
    const newlyAddedKeys = scopedItemKeys.filter((key) => !prevScopedSet.has(key));

    setOrderedItemKeys((current) => {
      const filtered = dedupeIds(current).filter((key) => scopedKeySet.has(key));
      const missing = scopedItemKeys.filter((key) => !filtered.includes(key));
      let next = [...filtered, ...missing];

      if (pendingCreateSlot && newlyAddedKeys.length > 0) {
        const createdAtByKey = new Map(
          scopedItems.map((item) => [item.key, new Date(item.task.createdAt || 0).getTime() || 0])
        );
        const newestKey = [...newlyAddedKeys].sort(
          (a, b) => (createdAtByKey.get(b) || 0) - (createdAtByKey.get(a) || 0)
        )[0];
        next = moveIdToIndex(next, newestKey || newlyAddedKeys[0], pendingCreateSlot.index);
      }

      if (next.length === current.length && next.every((key, index) => key === current[index])) {
        return current;
      }

      return next;
    });

    if (pendingCreateSlot) {
      if (newlyAddedKeys.length > 0) {
        setPendingCreateSlot(null);
      }
    }

    prevScopedKeysRef.current = scopedItemKeys;
  }, [scopedItemKeys, scopedItems, pendingCreateSlot]);

  const orderedItems = useMemo(() => {
    const fromSavedOrder = orderedItemKeys
      .map((itemKey) => itemByKey.get(itemKey))
      .filter((item): item is GridTaskItem => Boolean(item));
    const missing = scopedItems.filter((item) => !orderedItemKeys.includes(item.key));
    return [...fromSavedOrder, ...missing];
  }, [orderedItemKeys, itemByKey, scopedItems]);

  const displayCount = slotCount;
  const pageCount = Math.max(1, Math.ceil(orderedItems.length / slotCount));
  const pageStartIndex = pageIndex * slotCount;
  const pageEndIndex = pageStartIndex + slotCount;
  const pagedItems = useMemo(
    () => orderedItems.slice(pageStartIndex, pageEndIndex),
    [orderedItems, pageStartIndex, pageEndIndex]
  );

  const normalizedColumnFractions = useMemo(
    () => normalizeFractions(columnFractions, gridLayout.columns),
    [columnFractions, gridLayout.columns]
  );
  const normalizedRowFractions = useMemo(
    () => normalizeFractions(rowFractions, gridLayout.rows),
    [rowFractions, gridLayout.rows]
  );
  const columnBoundaryPercents = useMemo(
    () => getBoundaryPercents(normalizedColumnFractions),
    [normalizedColumnFractions]
  );
  const rowBoundaryPercents = useMemo(
    () => getBoundaryPercents(normalizedRowFractions),
    [normalizedRowFractions]
  );
  const visiblePageIndexes = useMemo(
    () => getVisiblePageIndexes(pageCount, pageIndex),
    [pageCount, pageIndex]
  );
  const visibleStart = orderedItems.length === 0 ? 0 : pageStartIndex + 1;
  const visibleEnd = Math.min(pageStartIndex + displayCount, orderedItems.length);

  useEffect(() => {
    setPageIndex((current) => Math.min(current, pageCount - 1));
  }, [pageCount]);

  const handleDragOverSlot = (index: number, event: React.DragEvent<HTMLElement>) => {
    if (!draggedItemKey) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDropSlot = (index: number) => {
    if (!draggedItemKey) return;
    // TODO: support dragging across pages (e.g., drag-hover pager to switch pages).
    const absoluteTargetIndex = pageStartIndex + index;
    setOrderedItemKeys((current) => {
      const normalized = dedupeIds([
        ...current.filter((key) => itemByKey.has(key)),
        ...scopedItems.map((item) => item.key),
      ]).filter((key) => itemByKey.has(key));
      return moveIdToIndex(normalized, draggedItemKey, absoluteTargetIndex);
    });
    setDragOverIndex(null);
    setDraggedItemKey(null);
  };

  const triggerCreateTask = (targetProject: Project, slotIndex: number) => {
    setPendingCreateSlot({ index: slotIndex });
    onCreateTaskForProject(targetProject);
  };

  const handleCreateTaskInSlot = (slotIndex: number) => {
    const absoluteIndex = pageStartIndex + slotIndex;

    if (scopeProjectId === null && projects.length > 1) {
      setProjectPickerSlotIndex(absoluteIndex);
      return;
    }

    if (scopeProjectId === null) {
      const onlyProject = projects[0] || project;
      triggerCreateTask(onlyProject, absoluteIndex);
      return;
    }

    const scopedProject =
      projects.find((projectItem) => projectItem.id === scopeProjectId) || project;
    triggerCreateTask(scopedProject, absoluteIndex);
  };

  const startResize = (
    axis: ResizeAxis,
    boundaryIndex: number,
    event: React.PointerEvent<HTMLDivElement>
  ) => {
    if (event.button !== 0) return;

    const surface = gridSurfaceRef.current;
    if (!surface) return;

    const rect = surface.getBoundingClientRect();
    const containerSize = axis === 'column' ? rect.width : rect.height;
    if (!Number.isFinite(containerSize) || containerSize <= 0) return;

    const fractions = axis === 'column' ? normalizedColumnFractions : normalizedRowFractions;
    if (boundaryIndex < 0 || boundaryIndex >= fractions.length - 1) return;

    const startBeforePx = fractions[boundaryIndex] * containerSize;
    const startAfterPx = fractions[boundaryIndex + 1] * containerSize;
    if (startBeforePx <= 0 || startAfterPx <= 0) return;

    clearResizeListeners();
    resizeDragRef.current = {
      axis,
      boundaryIndex,
      startPointer: axis === 'column' ? event.clientX : event.clientY,
      containerSize,
      startBeforePx,
      startAfterPx,
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const drag = resizeDragRef.current;
      if (!drag) return;

      const pointer = drag.axis === 'column' ? moveEvent.clientX : moveEvent.clientY;
      const delta = pointer - drag.startPointer;
      const pairSize = drag.startBeforePx + drag.startAfterPx;
      const requestedMinSize = drag.axis === 'column' ? MIN_COLUMN_SIZE_PX : MIN_ROW_SIZE_PX;
      const minSize = Math.min(requestedMinSize, Math.max(1, pairSize / 2 - 1));
      const rawBeforePx = drag.startBeforePx + delta;
      const beforePx = Math.max(minSize, Math.min(pairSize - minSize, rawBeforePx));
      const afterPx = pairSize - beforePx;

      if (drag.axis === 'column') {
        setColumnFractions((current) => {
          const normalized = normalizeFractions(current, gridLayout.columns);
          if (drag.boundaryIndex >= normalized.length - 1) return normalized;

          const next = [...normalized];
          next[drag.boundaryIndex] = beforePx / drag.containerSize;
          next[drag.boundaryIndex + 1] = afterPx / drag.containerSize;
          return next;
        });
        return;
      }

      setRowFractions((current) => {
        const normalized = normalizeFractions(current, gridLayout.rows);
        if (drag.boundaryIndex >= normalized.length - 1) return normalized;

        const next = [...normalized];
        next[drag.boundaryIndex] = beforePx / drag.containerSize;
        next[drag.boundaryIndex + 1] = afterPx / drag.containerSize;
        return next;
      });
    };

    const onPointerUp = () => {
      resizeDragRef.current = null;
      clearResizeListeners();
    };

    resizeMoveListenerRef.current = onPointerMove;
    resizeUpListenerRef.current = onPointerUp;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    event.preventDefault();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-muted/20 px-4 py-2">
        {isGridEnabled ? (
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              className={cn(
                'shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                scopeProjectId === null
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
              onClick={() => setScopeProjectId(null)}
            >
              All Projects
            </button>
            {projects.map((projectItem) => (
              <button
                key={projectItem.id}
                type="button"
                className={cn(
                  'shrink-0 rounded-md px-2 py-1 text-xs font-medium transition-colors',
                  scopeProjectId === projectItem.id
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                )}
                onClick={() => setScopeProjectId(projectItem.id)}
                title={projectItem.name}
              >
                {projectItem.name}
              </button>
            ))}
          </div>
        ) : (
          <div className="flex-1" />
        )}

        <div className="flex items-center gap-2">
          <div className="text-xs text-muted-foreground">
            {orderedItems.length} task{orderedItems.length === 1 ? '' : 's'}
          </div>
          <div className="inline-flex items-center gap-1 rounded-md border border-border bg-background p-1">
            <button
              type="button"
              onClick={() => onGridEnabledChange(false)}
              className={cn(
                'inline-flex h-7 items-center rounded px-2 text-xs font-medium transition-colors',
                !isGridEnabled
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground'
              )}
              aria-label="Disable grid and show single-task mode"
              title="No grid"
            >
              No grid
            </button>
            {GRID_SLOT_OPTIONS.map((option) => (
              <SplitButton
                key={option}
                option={option}
                active={isGridEnabled && slotCount === option}
                onClick={() => {
                  setSlotCount(option);
                  if (!isGridEnabled) {
                    onGridEnabledChange(true);
                  }
                }}
              />
            ))}
          </div>
        </div>
      </div>

      {!isGridEnabled ? <div className="min-h-0 flex-1 overflow-hidden">{singleView}</div> : null}

      {isGridEnabled ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            ref={gridSurfaceRef}
            className={cn(
              'relative min-h-0 w-full flex-1 overflow-hidden bg-background',
              pageCount > 1 ? '' : 'border-b border-border'
            )}
          >
            <div
              className="grid h-full w-full overflow-hidden"
              style={{
                gridTemplateColumns: normalizedColumnFractions
                  .map((value) => `${value}fr`)
                  .join(' '),
                gridTemplateRows: normalizedRowFractions.map((value) => `${value}fr`).join(' '),
              }}
            >
              {Array.from({ length: displayCount }).map((_, index) => {
                const item = pagedItems[index] || null;

                return (
                  <div
                    key={item?.key || `slot-empty-${index}`}
                    className="min-h-0 min-w-0 overflow-hidden"
                  >
                    {item ? (
                      <TaskTerminalTile
                        item={item}
                        active={
                          activeTask?.id === item.task.id &&
                          activeTask?.projectId === item.project.id
                        }
                        isDropTarget={draggedItemKey !== null && dragOverIndex === index}
                        showProjectBadge={showProjectBadge}
                        installedAgents={installedAgents}
                        onSelectTaskInProject={onSelectTaskInProject}
                        onOpenTaskInProject={onOpenTaskInProject}
                        onDragHandleStart={setDraggedItemKey}
                        onDragHandleEnd={() => {
                          setDraggedItemKey(null);
                          setDragOverIndex(null);
                        }}
                        onDragOverSlot={handleDragOverSlot}
                        onDropSlot={handleDropSlot}
                        slotIndex={index}
                      />
                    ) : (
                      <EmptySlotCard
                        slotIndex={index}
                        isDropTarget={draggedItemKey !== null && dragOverIndex === index}
                        onCreateTaskInSlot={handleCreateTaskInSlot}
                        onDragOverSlot={handleDragOverSlot}
                        onDropSlot={handleDropSlot}
                      />
                    )}
                  </div>
                );
              })}
            </div>

            {columnBoundaryPercents.map((leftPercent, boundaryIndex) => (
              <div
                key={`col-resize-${boundaryIndex}`}
                className="absolute inset-y-0 z-20 -translate-x-1/2 cursor-col-resize touch-none"
                style={{ left: `${leftPercent}%`, width: `${RESIZE_HANDLE_SIZE_PX}px` }}
                onPointerDown={(event) => startResize('column', boundaryIndex, event)}
                title="Drag to resize columns"
                aria-label="Resize columns"
                role="separator"
                aria-orientation="vertical"
              >
                <div className="pointer-events-none absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-border/90" />
              </div>
            ))}

            {rowBoundaryPercents.map((topPercent, boundaryIndex) => (
              <div
                key={`row-resize-${boundaryIndex}`}
                className="absolute inset-x-0 z-20 -translate-y-1/2 cursor-row-resize touch-none"
                style={{ top: `${topPercent}%`, height: `${RESIZE_HANDLE_SIZE_PX}px` }}
                onPointerDown={(event) => startResize('row', boundaryIndex, event)}
                title="Drag to resize rows"
                aria-label="Resize rows"
                role="separator"
                aria-orientation="horizontal"
              >
                <div className="pointer-events-none absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-border/90" />
              </div>
            ))}
          </div>

          {pageCount > 1 ? (
            <div className="flex items-center justify-between border-t border-border bg-muted/20 px-3 py-2">
              <div className="text-xs text-muted-foreground">
                Showing {visibleStart}-{visibleEnd} of {orderedItems.length}
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setPageIndex((current) => Math.max(0, current - 1))}
                  disabled={pageIndex === 0}
                  className={cn(
                    'inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-background text-muted-foreground transition-colors',
                    pageIndex === 0
                      ? 'cursor-not-allowed opacity-40'
                      : 'hover:bg-muted hover:text-foreground'
                  )}
                  aria-label="Previous grid page"
                  title="Previous page"
                >
                  <ChevronLeft className="h-3.5 w-3.5" />
                </button>

                {visiblePageIndexes[0] > 0 ? (
                  <>
                    <button
                      type="button"
                      onClick={() => setPageIndex(0)}
                      className="inline-flex h-7 min-w-7 items-center justify-center rounded border border-border bg-background px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      1
                    </button>
                    {visiblePageIndexes[0] > 1 ? (
                      <span className="px-1 text-xs text-muted-foreground">...</span>
                    ) : null}
                  </>
                ) : null}

                {visiblePageIndexes.map((index) => (
                  <button
                    key={`grid-page-${index}`}
                    type="button"
                    onClick={() => setPageIndex(index)}
                    className={cn(
                      'inline-flex h-7 min-w-7 items-center justify-center rounded border px-2 text-xs transition-colors',
                      pageIndex === index
                        ? 'border-primary bg-primary text-primary-foreground'
                        : 'border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground'
                    )}
                    aria-label={`Go to grid page ${index + 1}`}
                  >
                    {index + 1}
                  </button>
                ))}

                {visiblePageIndexes[visiblePageIndexes.length - 1] < pageCount - 1 ? (
                  <>
                    {visiblePageIndexes[visiblePageIndexes.length - 1] < pageCount - 2 ? (
                      <span className="px-1 text-xs text-muted-foreground">...</span>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => setPageIndex(pageCount - 1)}
                      className="inline-flex h-7 min-w-7 items-center justify-center rounded border border-border bg-background px-2 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                    >
                      {pageCount}
                    </button>
                  </>
                ) : null}

                <button
                  type="button"
                  onClick={() => setPageIndex((current) => Math.min(pageCount - 1, current + 1))}
                  disabled={pageIndex >= pageCount - 1}
                  className={cn(
                    'inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-background text-muted-foreground transition-colors',
                    pageIndex >= pageCount - 1
                      ? 'cursor-not-allowed opacity-40'
                      : 'hover:bg-muted hover:text-foreground'
                  )}
                  aria-label="Next grid page"
                  title="Next page"
                >
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <Dialog
        open={projectPickerSlotIndex !== null}
        onOpenChange={(open) => !open && setProjectPickerSlotIndex(null)}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Create Task In Project</DialogTitle>
            <DialogDescription>Select which project should own this new task.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            {projects.map((projectItem) => (
              <button
                key={projectItem.id}
                type="button"
                className="rounded-md border border-border px-3 py-2 text-left transition-colors hover:bg-muted"
                onClick={() => {
                  if (projectPickerSlotIndex === null) return;
                  const slotIndex = projectPickerSlotIndex;
                  setProjectPickerSlotIndex(null);
                  triggerCreateTask(projectItem, slotIndex);
                }}
              >
                <div className="truncate text-sm font-medium text-foreground">
                  {projectItem.name}
                </div>
                <div className="truncate text-xs text-muted-foreground">{projectItem.path}</div>
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
};

export default TaskGridView;
