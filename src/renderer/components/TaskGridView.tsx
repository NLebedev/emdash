import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, GitBranch, GripVertical, Layers, Plus } from 'lucide-react';
import { makePtyId } from '@shared/ptyId';
import { getTaskEnvVars } from '@shared/task/envVars';
import { PROVIDER_IDS, type ProviderId } from '@shared/providers/registry';
import { TerminalPane } from './TerminalPane';
import AgentLogo from './AgentLogo';
import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';
import { Spinner } from './ui/spinner';
import { cn } from '@/lib/utils';
import { useTaskBusy } from '../hooks/useTaskBusy';
import { useTheme } from '../hooks/useTheme';
import { agentConfig } from '../lib/agentConfig';
import { agentMeta } from '../providers/meta';
import type { Project, Task } from '../types/app';

const CONVERSATIONS_CHANGED_EVENT = 'emdash:conversations-changed';
const GRID_SLOT_OPTIONS = [2, 4, 6, 9] as const;
type GridSlotCount = (typeof GRID_SLOT_OPTIONS)[number];

const GRID_SCOPE_KEY = 'taskGrid:scopeProjectId';
const GRID_SLOT_COUNT_KEY = 'taskGrid:slotCount';
const GRID_ORDER_PROJECT_KEY = (projectId: string) => `taskGrid:order:project:${projectId}`;
const GRID_ORDER_ALL_KEY = 'taskGrid:order:all-projects';

const GRID_COLUMNS_CLASS: Record<GridSlotCount, string> = {
  2: 'grid-cols-1 xl:grid-cols-2',
  4: 'grid-cols-1 md:grid-cols-2',
  6: 'grid-cols-1 md:grid-cols-2 xl:grid-cols-3',
  9: 'grid-cols-1 md:grid-cols-3',
};

const GRID_TILE_HEIGHT_CLASS: Record<GridSlotCount, string> = {
  2: 'h-[clamp(520px,74vh,920px)]',
  4: 'h-[clamp(290px,42vh,560px)]',
  6: 'h-[clamp(240px,34vh,460px)]',
  9: 'h-[clamp(190px,28vh,340px)]',
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

async function resolveTerminalTarget(taskId: string, taskAgentId?: string): Promise<TerminalTarget> {
  const fallbackProvider = resolveStoredProvider(taskId, taskAgentId);

  try {
    const response = await window.electronAPI.getActiveConversation(taskId);
    const activeConversation = response?.success ? response.conversation : null;
    if (!activeConversation) {
      return buildMainTarget(taskId, fallbackProvider);
    }

    const provider = isProviderId(activeConversation.provider)
      ? activeConversation.provider
      : fallbackProvider;

    if (!activeConversation.isMain && activeConversation.id) {
      return {
        id: makePtyId(provider, 'chat', String(activeConversation.id)),
        provider,
      };
    }

    return buildMainTarget(taskId, provider);
  } catch {
    return buildMainTarget(taskId, fallbackProvider);
  }
}

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
  const gridColsClass =
    option === 2 ? 'grid-cols-2' : option === 4 ? 'grid-cols-2' : 'grid-cols-3';

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
              'rounded-[1px] border border-current/40',
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
  tileHeightClass: string;
  showProjectBadge: boolean;
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
  tileHeightClass,
  showProjectBadge,
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
  const [needsAttention, setNeedsAttention] = useState(false);
  const taskId = item.task.id;
  const taskAgentId = item.task.agentId;
  const prevBusyRef = useRef<boolean>(busy);
  const busySinceClearRef = useRef<boolean>(busy);

  const taskEnv = useMemo(() => {
    return getTaskEnvVars({
      taskId: item.task.id,
      taskName: item.task.name,
      taskPath: item.task.path,
      projectPath: item.projectPath,
      defaultBranch: item.defaultBranch || undefined,
    });
  }, [item.task.id, item.task.name, item.task.path, item.projectPath, item.defaultBranch]);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const resolved = await resolveTerminalTarget(taskId, taskAgentId);
      if (!cancelled) {
        setTarget(resolved);
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
  }, [taskId, taskAgentId]);

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

  const provider = target?.provider ?? resolveStoredProvider(taskId, taskAgentId);
  const providerInfo = agentConfig[provider];
  const autoApproveEnabled =
    Boolean(item.task.metadata?.autoApprove) && Boolean(agentMeta[provider]?.autoApproveFlag);
  const isMultiAgentTask = Boolean(item.task.metadata?.multiAgent?.enabled);

  return (
    <section
      className={cn(
        'flex min-h-0 flex-col overflow-hidden rounded-xl border bg-card shadow-sm transition-colors',
        tileHeightClass,
        active ? 'border-primary' : 'border-border',
        needsAttention && 'border-orange-400/80 bg-orange-500/10',
        isDropTarget && 'ring-2 ring-primary/60 ring-offset-2 ring-offset-background'
      )}
      onDragOver={(event) => onDragOverSlot(slotIndex, event)}
      onDrop={() => onDropSlot(slotIndex)}
      onMouseDownCapture={() => {
        clearAttention();
        if (!active) {
          onSelectTaskInProject(item.project, item.task);
        }
      }}
    >
      <header
        className={cn(
          'flex items-start justify-between gap-3 border-b border-border bg-muted/30 px-3 py-2.5',
          needsAttention && 'bg-orange-500/15'
        )}
      >
        <div className="min-w-0 space-y-1">
          <div className="truncate text-sm font-medium text-foreground">{item.task.name}</div>
          <div className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <GitBranch className="h-3 w-3" />
            <span className="truncate font-mono">origin/{item.task.branch}</span>
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
            {providerInfo?.logo ? (
              <AgentLogo
                logo={providerInfo.logo}
                alt={providerInfo.alt}
                isSvg={providerInfo.isSvg}
                invertInDark={providerInfo.invertInDark}
                className="h-3.5 w-3.5"
              />
            ) : null}
            <span className="truncate">{providerInfo?.name || provider}</span>
            {showProjectBadge ? (
              <span className="rounded border border-border bg-muted/60 px-1 py-0.5 text-[10px] text-muted-foreground">
                {item.project.name}
              </span>
            ) : null}
            {autoApproveEnabled ? (
              <span className="rounded bg-orange-500/15 px-1 py-0.5 text-[10px] text-orange-600">
                Auto
              </span>
            ) : null}
            {needsAttention ? (
              <span className="rounded bg-orange-500/20 px-1 py-0.5 text-[10px] font-medium text-orange-700">
                Needs input
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1">
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
            className="inline-flex h-7 w-7 items-center justify-center rounded border border-border bg-background text-muted-foreground hover:bg-muted"
            title="Drag to reorder"
            aria-label={`Drag task ${item.task.name}`}
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          {busy ? <Spinner size="sm" className="h-3.5 w-3.5 text-muted-foreground" /> : null}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={(event) => {
              event.stopPropagation();
              clearAttention();
              onOpenTaskInProject(item.project, item.task);
            }}
          >
            Open
            <ArrowUpRight className="ml-1 h-3 w-3" />
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
            keepAlive
            mapShiftEnterToCtrlJ
            variant={
              effectiveTheme === 'dark' || effectiveTheme === 'dark-black' ? 'dark' : 'light'
            }
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
  tileHeightClass: string;
  isDropTarget: boolean;
  onCreateTaskInSlot: (slotIndex: number) => void;
  onDragOverSlot: (index: number, event: React.DragEvent<HTMLElement>) => void;
  onDropSlot: (index: number) => void;
}> = ({ slotIndex, tileHeightClass, isDropTarget, onCreateTaskInSlot, onDragOverSlot, onDropSlot }) => {
  return (
    <button
      type="button"
      onClick={() => onCreateTaskInSlot(slotIndex)}
      onDragOver={(event) => onDragOverSlot(slotIndex, event)}
      onDrop={() => onDropSlot(slotIndex)}
      className={cn(
        'flex min-h-0 items-center justify-center rounded-xl border border-dashed border-border bg-muted/20 text-muted-foreground transition-colors hover:bg-muted/35',
        tileHeightClass,
        isDropTarget && 'ring-2 ring-primary/60 ring-offset-2 ring-offset-background'
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
  const [draggedItemKey, setDraggedItemKey] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [pendingCreateSlot, setPendingCreateSlot] = useState<{ index: number } | null>(null);
  const [projectPickerSlotIndex, setProjectPickerSlotIndex] = useState<number | null>(null);
  const prevScopedKeysRef = useRef<string[]>([]);

  useEffect(() => {
    setScopeProjectId(loadGridScopeProjectId());
    setSlotCount(loadGridSlotCount());
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
    setDragOverIndex(null);
    setDraggedItemKey(null);
    setPendingCreateSlot(null);
    setProjectPickerSlotIndex(null);
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

      if (
        pendingCreateSlot &&
        newlyAddedKeys.length > 0
      ) {
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

  const displayCount = Math.max(slotCount, orderedItems.length);
  const isTwoSlotExpanded = slotCount === 2 && displayCount <= 2;

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
    setOrderedItemKeys((current) => {
      const normalized = dedupeIds([
        ...current.filter((key) => itemByKey.has(key)),
        ...scopedItems.map((item) => item.key),
      ]).filter((key) => itemByKey.has(key));
      return moveIdToIndex(normalized, draggedItemKey, index);
    });
    setDragOverIndex(null);
    setDraggedItemKey(null);
  };

  const triggerCreateTask = (targetProject: Project, slotIndex: number) => {
    setPendingCreateSlot({ index: slotIndex });
    onCreateTaskForProject(targetProject);
  };

  const handleCreateTaskInSlot = (slotIndex: number) => {
    if (scopeProjectId === null && projects.length > 1) {
      setProjectPickerSlotIndex(slotIndex);
      return;
    }

    if (scopeProjectId === null) {
      const onlyProject = projects[0] || project;
      triggerCreateTask(onlyProject, slotIndex);
      return;
    }

    const scopedProject = projects.find((projectItem) => projectItem.id === scopeProjectId) || project;
    triggerCreateTask(scopedProject, slotIndex);
  };

  const tileHeightClass = isTwoSlotExpanded ? 'h-full' : GRID_TILE_HEIGHT_CLASS[slotCount];

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

      {!isGridEnabled ? (
        <div className="min-h-0 flex-1 overflow-hidden">{singleView}</div>
      ) : null}

      <div className={cn('min-h-0 flex-1 overflow-auto p-4', !isGridEnabled && 'hidden')}>
        <div
          className={cn(
            'grid gap-4',
            GRID_COLUMNS_CLASS[slotCount],
            isTwoSlotExpanded && 'h-full auto-rows-fr'
          )}
        >
          {Array.from({ length: displayCount }).map((_, index) => {
            const item = orderedItems[index] || null;

            if (!item) {
              return (
                <EmptySlotCard
                  key={`slot-empty-${index}`}
                  slotIndex={index}
                  tileHeightClass={tileHeightClass}
                  isDropTarget={draggedItemKey !== null && dragOverIndex === index}
                  onCreateTaskInSlot={handleCreateTaskInSlot}
                  onDragOverSlot={handleDragOverSlot}
                  onDropSlot={handleDropSlot}
                />
              );
            }

            return (
              <TaskTerminalTile
                key={item.key}
                item={item}
                active={activeTask?.id === item.task.id && activeTask?.projectId === item.project.id}
                isDropTarget={draggedItemKey !== null && dragOverIndex === index}
                tileHeightClass={tileHeightClass}
                showProjectBadge={showProjectBadge}
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
            );
          })}
        </div>
      </div>

      <Dialog open={projectPickerSlotIndex !== null} onOpenChange={(open) => !open && setProjectPickerSlotIndex(null)}>
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
                <div className="truncate text-sm font-medium text-foreground">{projectItem.name}</div>
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
