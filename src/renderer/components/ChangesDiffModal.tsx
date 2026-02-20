import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Copy, Check, Plus, Minus, Loader2 } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { DiffEditor, loader } from '@monaco-editor/react';
import type * as monaco from 'monaco-editor';
import { type FileChange } from '../hooks/useFileChanges';
import { useToast } from '../hooks/use-toast';
import { useTheme } from '../hooks/useTheme';
import type { DiffLine } from '../hooks/useFileDiff';
import {
  convertDiffLinesToMonacoFormat,
  getMonacoLanguageId,
  isBinaryFile,
  isImageFile,
} from '../lib/diffUtils';
import { MONACO_DIFF_COLORS } from '../lib/monacoDiffColors';
import { configureDiffEditorDiagnostics, resetDiagnosticOptions } from '../lib/monacoDiffConfig';
import { dispatchFileChangeEvent } from '../lib/fileChangeEvents';
import { useDiffEditorComments } from '../hooks/useDiffEditorComments';
import { useTaskComments } from '../hooks/useLineComments';
import { registerActiveCodeEditor } from '../lib/activeCodeEditor';
import {
  applyBlockStageLocally,
  getAnchorLinesFromDiffChanges,
  buildStageDecorations,
  getChangeCountsForSection,
  getStageAnchorLines,
  splitChangesByStage,
  STAGE_CHANGE_GLYPH_CLASS,
  UNSTAGE_CHANGE_GLYPH_CLASS,
  type StageAction,
} from '../lib/diffStaging';
import { useTaskScope } from './TaskScopeContext';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './ui/tooltip';
import { FileIcon } from './FileExplorer/FileIcons';

interface ChangesDiffModalProps {
  open: boolean;
  onClose: () => void;
  taskId?: string;
  taskPath?: string;
  files: FileChange[];
  initialFile?: string;
  initialSection?: 'staged' | 'unstaged';
  onRefreshChanges?: () => Promise<void> | void;
  onToggleView?: () => void;
}

type DiffSection = 'staged' | 'unstaged';
type DiffScope = 'staged' | 'unstaged';
type MonacoLineChange = {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
};

function splitLines(text: string): string[] {
  return text.length === 0 ? [] : text.split('\n');
}

function pickLineRange(lines: string[], startLine: number, endLine: number): string[] {
  if (startLine <= 0 || endLine < startLine) return [];
  const startIndex = Math.max(0, startLine - 1);
  const endExclusive = Math.max(startIndex, Math.min(lines.length, endLine));
  return lines.slice(startIndex, endExclusive);
}

function replaceLineRange(
  lines: string[],
  startLine: number,
  endLine: number,
  replacement: string[]
): string[] {
  const normalizedStart = Math.max(1, startLine || 1);
  const startIndex = Math.min(lines.length, normalizedStart - 1);
  let deleteCount = 0;
  if (startLine > 0 && endLine >= startLine) {
    const clampedEnd = Math.min(lines.length, endLine);
    deleteCount = Math.max(0, clampedEnd - normalizedStart + 1);
  }
  return [...lines.slice(0, startIndex), ...replacement, ...lines.slice(startIndex + deleteCount)];
}

function lineMatchesChange(change: MonacoLineChange, lineNumber: number): boolean {
  if (
    change.modifiedStartLineNumber > 0 &&
    change.modifiedEndLineNumber >= change.modifiedStartLineNumber
  ) {
    return (
      lineNumber >= change.modifiedStartLineNumber && lineNumber <= change.modifiedEndLineNumber
    );
  }

  const anchor =
    change.modifiedStartLineNumber > 0
      ? change.modifiedStartLineNumber
      : change.modifiedEndLineNumber > 0
        ? change.modifiedEndLineNumber
        : change.originalStartLineNumber > 0
          ? change.originalStartLineNumber
          : 1;
  return lineNumber === anchor;
}

function applyStageChangeToModels(
  diffEditor: monaco.editor.IStandaloneDiffEditor,
  lineNumber: number,
  section: DiffSection
): { original: string; modified: string } | null {
  const lineChanges = diffEditor.getLineChanges() as MonacoLineChange[] | null;
  if (!lineChanges || lineChanges.length === 0) return null;
  const targetChange = lineChanges.find((change) => lineMatchesChange(change, lineNumber));
  if (!targetChange) return null;

  const originalModel = diffEditor.getOriginalEditor().getModel();
  const modifiedModel = diffEditor.getModifiedEditor().getModel();
  if (!originalModel || !modifiedModel) return null;

  const originalLines = splitLines(originalModel.getValue());
  const modifiedLines = splitLines(modifiedModel.getValue());

  if (section === 'unstaged') {
    const replacement = pickLineRange(
      modifiedLines,
      targetChange.modifiedStartLineNumber,
      targetChange.modifiedEndLineNumber
    );
    const nextOriginal = replaceLineRange(
      originalLines,
      targetChange.originalStartLineNumber,
      targetChange.originalEndLineNumber,
      replacement
    ).join('\n');
    originalModel.setValue(nextOriginal);
    return { original: nextOriginal, modified: modifiedModel.getValue() };
  }

  const replacement = pickLineRange(
    originalLines,
    targetChange.originalStartLineNumber,
    targetChange.originalEndLineNumber
  );
  const nextModified = replaceLineRange(
    modifiedLines,
    targetChange.modifiedStartLineNumber,
    targetChange.modifiedEndLineNumber,
    replacement
  ).join('\n');
  modifiedModel.setValue(nextModified);
  return { original: originalModel.getValue(), modified: nextModified };
}

export const ChangesDiffModal: React.FC<ChangesDiffModalProps> = ({
  open,
  onClose,
  taskId,
  taskPath,
  files,
  initialFile,
  initialSection,
  onRefreshChanges,
  onToggleView,
}) => {
  const { taskId: scopedTaskId, taskPath: scopedTaskPath } = useTaskScope();
  const resolvedTaskId = taskId ?? scopedTaskId;
  const resolvedTaskPath = taskPath ?? scopedTaskPath;
  const safeTaskId = resolvedTaskId ?? '';
  const safeTaskPath = resolvedTaskPath ?? '';

  const resolveDefaultSection = (
    filePath: string | undefined,
    preferred?: DiffSection
  ): DiffSection => {
    if (preferred) return preferred;
    const file = filePath ? files.find((candidate) => candidate.path === filePath) : undefined;
    if (!file) return 'unstaged';
    return file.hasUnstaged || !file.isStaged ? 'unstaged' : 'staged';
  };

  const initialSelectedFilePath = initialFile || files[0]?.path;
  const [selected, setSelected] = useState<string | undefined>(initialSelectedFilePath);
  const [selectedSection, setSelectedSection] = useState<DiffSection>(() =>
    resolveDefaultSection(initialSelectedFilePath, initialSection)
  );
  const [copiedFile, setCopiedFile] = useState<string | null>(null);
  const shouldReduceMotion = useReducedMotion();
  const { toast } = useToast();
  const { effectiveTheme } = useTheme();
  const isDark = effectiveTheme === 'dark' || effectiveTheme === 'dark-black';
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneDiffEditor | null>(
    null
  );
  const editorRef = useRef<monaco.editor.IStandaloneDiffEditor | null>(null);
  const changeDisposableRef = useRef<monaco.IDisposable | null>(null);
  const diffUpdateDisposableRef = useRef<monaco.IDisposable | null>(null);
  const stageClickDisposableRef = useRef<monaco.IDisposable | null>(null);
  const stageDecorationIdsRef = useRef<string[]>([]);
  const activeEditorCleanupRef = useRef<(() => void) | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [decorationNonce, setDecorationNonce] = useState(0);
  const [isStagingRange, setIsStagingRange] = useState(false);
  const [isTogglingFileStage, setIsTogglingFileStage] = useState<Set<string>>(new Set());

  // Integrate line comments - use state (not ref) so hook re-runs when editor mounts
  useDiffEditorComments({
    editor: editorInstance,
    taskId: safeTaskId,
    filePath: selected || '',
  });

  // Get comment counts for all files in this task (for sidebar display)
  const { countsByFile: commentCounts } = useTaskComments(safeTaskId);

  // File data state for Monaco editor
  const [fileData, setFileData] = useState<{
    original: string;
    modified: string;
    initialModified: string;
    diffLines: DiffLine[];
    language: string;
    loading: boolean;
    error: string | null;
    isImage?: boolean;
    imageDataUrl?: string;
    imageMimeType?: string;
  } | null>(null);
  const [modifiedDraft, setModifiedDraft] = useState<string>('');
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const selectedFileChange = selected ? files.find((file) => file.path === selected) : undefined;
  const selectedHasUnstagedChanges =
    selectedSection === 'unstaged' && selectedFileChange
      ? selectedFileChange.hasUnstaged || !selectedFileChange.isStaged
      : false;
  const selectedHasStagedChanges =
    selectedSection === 'staged' && selectedFileChange ? selectedFileChange.isStaged : false;
  const selectedBlockAction: StageAction | null = selectedHasUnstagedChanges
    ? 'stage'
    : selectedHasStagedChanges
      ? 'unstage'
      : null;
  const isDirty = fileData ? modifiedDraft !== fileData.initialModified : false;

  // Close on escape key
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      const nextPath = initialFile || files[0]?.path;
      setSelected(nextPath);
      setSelectedSection(resolveDefaultSection(nextPath, initialSection));
    }
    wasOpenRef.current = open;
  }, [files, initialFile, initialSection, open]);

  // Load file data when selected file changes
  useEffect(() => {
    if (!open || !selected || !safeTaskPath) {
      setFileData(null);
      setModifiedDraft('');
      setSaveError(null);
      setIsSaving(false);
      return;
    }

    let cancelled = false;

    const loadFileData = async () => {
      // Find file from current files array (but don't depend on it in useEffect)
      const selectedFile = files.find((f) => f.path === selected);
      if (!selectedFile) {
        if (!cancelled) {
          setFileData({
            original: '',
            modified: '',
            initialModified: '',
            diffLines: [],
            language: 'plaintext',
            loading: false,
            error: 'File not found',
            isImage: false,
          });
          setModifiedDraft('');
        }
        return;
      }

      const filePath = selectedFile.path;
      const language = getMonacoLanguageId(filePath);

      // Binary files: preview images, otherwise show placeholder error
      if (isBinaryFile(filePath)) {
        if (isImageFile(filePath)) {
          setFileData({
            original: '',
            modified: '',
            initialModified: '',
            diffLines: [],
            language: 'plaintext',
            loading: true,
            error: null,
            isImage: true,
          });
          setModifiedDraft('');

          if (selectedFile.status === 'deleted') {
            if (!cancelled) {
              setFileData({
                original: '',
                modified: '',
                initialModified: '',
                diffLines: [],
                language: 'plaintext',
                loading: false,
                error: 'Deleted image - preview unavailable',
                isImage: true,
              });
            }
            return;
          }

          try {
            const imageRes = await window.electronAPI.fsReadImage(safeTaskPath, filePath);
            if (cancelled) return;

            if (imageRes?.success && imageRes.dataUrl) {
              setFileData({
                original: '',
                modified: '',
                initialModified: '',
                diffLines: [],
                language: 'plaintext',
                loading: false,
                error: null,
                isImage: true,
                imageDataUrl: imageRes.dataUrl,
                imageMimeType: imageRes.mimeType,
              });
            } else {
              setFileData({
                original: '',
                modified: '',
                initialModified: '',
                diffLines: [],
                language: 'plaintext',
                loading: false,
                error: imageRes?.error || 'Failed to load image preview',
                isImage: true,
              });
            }
          } catch (error: any) {
            if (!cancelled) {
              setFileData({
                original: '',
                modified: '',
                initialModified: '',
                diffLines: [],
                language: 'plaintext',
                loading: false,
                error: error?.message || 'Failed to load image preview',
                isImage: true,
              });
            }
          }
        } else {
          setFileData({
            original: '',
            modified: '',
            initialModified: '',
            diffLines: [],
            language: 'plaintext',
            loading: false,
            error: 'Binary file - diff not available',
            isImage: false,
          });
          setModifiedDraft('');
        }
        return;
      }

      // Set loading state
      setFileData({
        original: '',
        modified: '',
        initialModified: '',
        diffLines: [],
        language,
        loading: true,
        error: null,
        isImage: false,
        imageDataUrl: undefined,
        imageMimeType: undefined,
      });
      setModifiedDraft('');

      try {
        const diffScope: DiffScope = selectedSection === 'staged' ? 'staged' : 'unstaged';

        // Get diff lines
        if (!safeTaskPath) return;
        const diffRes = await window.electronAPI.getFileDiff({
          taskPath: safeTaskPath,
          filePath,
          scope: diffScope,
        });
        if (!diffRes?.success || !diffRes.diff) {
          throw new Error(diffRes?.error || 'Failed to load diff');
        }

        const diffLines: DiffLine[] = diffRes.diff.lines;

        let originalContent = '';
        let modifiedContent = '';

        if (selectedFile.status === 'deleted') {
          const converted = convertDiffLinesToMonacoFormat(diffLines);
          originalContent = converted.original;
          modifiedContent = '';
        } else if (selectedFile.status === 'added') {
          const converted = convertDiffLinesToMonacoFormat(diffLines);
          originalContent = '';
          modifiedContent = converted.modified;

          // For unstaged view, prefer current file content when available.
          if (diffScope === 'unstaged') {
            const readRes = await window.electronAPI.fsRead(
              safeTaskPath,
              filePath,
              2 * 1024 * 1024
            );
            if (readRes?.success && readRes.content) {
              modifiedContent = readRes.content;
            }
          }
        } else {
          // Modified file: reconstruct from diff
          const converted = convertDiffLinesToMonacoFormat(diffLines);
          originalContent = converted.original;
          modifiedContent = converted.modified;

          // For unstaged view, prefer actual current content for better accuracy.
          if (diffScope === 'unstaged') {
            try {
              const readRes = await window.electronAPI.fsRead(
                safeTaskPath,
                filePath,
                2 * 1024 * 1024
              );
              if (readRes?.success && readRes.content) {
                modifiedContent = readRes.content;
              }
            } catch {
              // Fallback to diff-based content
            }
          }
        }

        if (!cancelled) {
          setFileData({
            original: originalContent,
            modified: modifiedContent,
            initialModified: modifiedContent,
            diffLines,
            language,
            loading: false,
            error: null,
            isImage: false,
            imageDataUrl: undefined,
            imageMimeType: undefined,
          });
          setModifiedDraft(modifiedContent);
          setSaveError(null);
          setIsSaving(false);
        }
      } catch (error: any) {
        if (!cancelled) {
          setFileData({
            original: '',
            modified: '',
            initialModified: '',
            diffLines: [],
            language,
            loading: false,
            error: error?.message || 'Failed to load file diff',
            isImage: false,
            imageDataUrl: undefined,
            imageMimeType: undefined,
          });
          setModifiedDraft('');
          setSaveError(error?.message || 'Failed to load file diff');
        }
      }
    };

    loadFileData();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, selected, selectedSection, safeTaskPath, reloadNonce]); // Removed 'files' to prevent constant reloading - files array changes every 5s

  // Add Monaco theme and styles
  useEffect(() => {
    if (!open) return;

    const styleId = 'changes-diff-modal-styles';
    const existingStyle = document.getElementById(styleId);
    if (existingStyle) {
      existingStyle.remove();
    }

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      /* Fix Monaco diff editor spacing */
      .monaco-diff-editor .diffViewport {
        padding-left: 0 !important;
      }
      /* Right-align line numbers and optimize spacing */
      .monaco-diff-editor .line-numbers {
        text-align: right !important;
        padding-right: 12px !important;
        padding-left: 4px !important;
        min-width: 40px !important;
      }
      /* Add padding between line numbers and code content border */
      .monaco-diff-editor .monaco-editor .margin {
        padding-right: 8px !important;
      }
      /* Hide left/original line numbers in unified diff view */
      .monaco-diff-editor .original .line-numbers {
        display: none !important;
      }
      .monaco-diff-editor .original .margin {
        display: none !important;
      }
      /* Make overview ruler thinner */
      .monaco-diff-editor .monaco-editor .overview-ruler {
        width: 3px !important;
      }
      .monaco-diff-editor .monaco-editor .overview-ruler .overview-ruler-content {
        width: 3px !important;
      }
      /* Add thin border between line numbers and code content */
      .monaco-diff-editor .modified .margin-view-overlays {
        border-right: 1px solid ${isDark ? 'rgba(156, 163, 175, 0.2)' : 'rgba(107, 114, 128, 0.2)'} !important;
      }
      .monaco-diff-editor .monaco-editor .margin {
        border-right: 1px solid ${isDark ? 'rgba(156, 163, 175, 0.2)' : 'rgba(107, 114, 128, 0.2)'} !important;
      }
      .monaco-diff-editor .monaco-editor-background {
        margin-left: 0 !important;
      }
      /* Hide diff viewport indicator (the grey bar in overview ruler) */
      .monaco-diff-editor .diffViewport {
        display: none !important;
      }
      .monaco-diff-editor .monaco-scrollable-element {
        box-shadow: none !important;
      }
      .monaco-diff-editor .overflow-guard {
        box-shadow: none !important;
      }
      /* Hover indicator for adding comments (plus icon) - shown dynamically via decoration */
      /* Icon only appears when mouse is in gutter area (via JS), so always use active color */
      .comment-hover-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        margin: 1px auto;
        position: relative;
        left: 8px;
        border-radius: 6px;
        border: 1px solid transparent;
        background: transparent;
        box-sizing: border-box;
        cursor: pointer;
        pointer-events: auto;
        transition: background-color 0.15s ease, border-color 0.15s ease;
      }
      .comment-hover-icon::before {
        content: '';
        display: block;
        width: 12px;
        height: 12px;
        background-color: hsl(var(--muted-foreground));
        mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='currentColor' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cline x1='12' y1='5' x2='12' y2='19'%3E%3C/line%3E%3Cline x1='5' y1='12' x2='19' y2='12'%3E%3C/line%3E%3C/svg%3E");
        mask-size: contain;
        mask-repeat: no-repeat;
        mask-position: center;
      }
      .comment-hover-icon:hover,
      .comment-hover-icon.comment-hover-icon-pinned {
        background-color: hsl(var(--foreground) / 0.08);
        border-color: hsl(var(--border));
      }
      .comment-hover-icon:hover::before,
      .comment-hover-icon.comment-hover-icon-pinned::before {
        background-color: hsl(var(--foreground));
      }
      .${STAGE_CHANGE_GLYPH_CLASS},
      .${UNSTAGE_CHANGE_GLYPH_CLASS} {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 14px !important;
        height: 14px !important;
        margin: 2px auto;
        position: relative;
        left: -12px;
        border-radius: 4px;
        box-sizing: border-box;
        cursor: pointer;
        pointer-events: auto;
        transition: background-color 0.15s ease, border-color 0.15s ease;
      }
      .${STAGE_CHANGE_GLYPH_CLASS} {
        border: 1px solid hsl(142 71% 45% / 0.65);
        background: hsl(142 71% 45% / 0.18);
      }
      .${UNSTAGE_CHANGE_GLYPH_CLASS} {
        border: 1px solid hsl(0 84% 60% / 0.65);
        background: hsl(0 84% 60% / 0.16);
      }
      .${STAGE_CHANGE_GLYPH_CLASS}::before,
      .${UNSTAGE_CHANGE_GLYPH_CLASS}::before {
        content: '+';
        display: block;
        width: 8px;
        height: 8px;
        line-height: 8px;
        text-align: center;
        font-size: 10px;
        font-weight: 700;
        background: none !important;
        mask-image: none !important;
      }
      .${STAGE_CHANGE_GLYPH_CLASS}::before {
        color: hsl(142 76% 36%);
      }
      .${UNSTAGE_CHANGE_GLYPH_CLASS}::before {
        content: '-';
        color: hsl(0 72% 45%);
      }
      .${STAGE_CHANGE_GLYPH_CLASS}:hover {
        background-color: hsl(142 71% 45% / 0.28);
        border-color: hsl(142 71% 45% / 0.8);
      }
      .${STAGE_CHANGE_GLYPH_CLASS}:hover::before {
        color: hsl(142 76% 30%);
      }
      .${UNSTAGE_CHANGE_GLYPH_CLASS}:hover {
        background-color: hsl(0 84% 60% / 0.24);
        border-color: hsl(0 84% 60% / 0.8);
      }
      .${UNSTAGE_CHANGE_GLYPH_CLASS}:hover::before {
        color: hsl(0 72% 38%);
      }
      /* Remove any borders from glyph margin items */
      .monaco-editor .glyph-margin > div {
        border: none !important;
        outline: none !important;
        box-shadow: none !important;
      }
      /* Remove borders from diff editor revert/undo decorations */
      .monaco-diff-editor .margin-view-overlays .cgmr,
      .monaco-diff-editor .margin-view-overlays .codicon,
      .monaco-diff-editor .glyph-margin-widgets .codicon,
      .monaco-diff-editor .line-decorations .codicon,
      .monaco-diff-editor .margin-view-overlays [class*="codicon-"] {
        border: none !important;
        outline: none !important;
        box-shadow: none !important;
      }
      .monaco-diff-editor .dirty-diff-deleted-indicator,
      .monaco-diff-editor .dirty-diff-modified-indicator,
      .monaco-diff-editor .dirty-diff-added-indicator {
        border: none !important;
        box-shadow: none !important;
      }
      /* Ensure view zones (comment widgets) are interactive */
      .monaco-editor .view-zones {
        pointer-events: auto !important;
      }
      .monaco-editor .view-zone {
        pointer-events: auto !important;
      }
    `;
    document.head.appendChild(style);

    // Define Monaco themes
    const defineThemes = async () => {
      try {
        const monaco = await loader.init();
        monaco.editor.defineTheme('custom-diff-dark', {
          base: 'vs-dark',
          inherit: true,
          rules: [],
          colors: {
            'editor.background': MONACO_DIFF_COLORS.dark.editorBackground,
            'editorGutter.background': MONACO_DIFF_COLORS.dark.editorBackground,
            'diffEditor.insertedTextBackground': MONACO_DIFF_COLORS.dark.insertedTextBackground,
            'diffEditor.insertedLineBackground': MONACO_DIFF_COLORS.dark.insertedLineBackground,
            'diffEditor.removedTextBackground': MONACO_DIFF_COLORS.dark.removedTextBackground,
            'diffEditor.removedLineBackground': MONACO_DIFF_COLORS.dark.removedLineBackground,
            'diffEditor.unchangedRegionBackground': '#1a2332',
          },
        });

        // Black theme with pure black background
        monaco.editor.defineTheme('custom-diff-black', {
          base: 'vs-dark',
          inherit: true,
          rules: [],
          colors: {
            'editor.background': MONACO_DIFF_COLORS['dark-black'].editorBackground,
            'editorGutter.background': MONACO_DIFF_COLORS['dark-black'].editorBackground,
            'diffEditor.insertedTextBackground':
              MONACO_DIFF_COLORS['dark-black'].insertedTextBackground,
            'diffEditor.insertedLineBackground':
              MONACO_DIFF_COLORS['dark-black'].insertedLineBackground,
            'diffEditor.removedTextBackground':
              MONACO_DIFF_COLORS['dark-black'].removedTextBackground,
            'diffEditor.removedLineBackground':
              MONACO_DIFF_COLORS['dark-black'].removedLineBackground,
            'diffEditor.unchangedRegionBackground': '#0a0a0a',
          },
        });

        monaco.editor.defineTheme('custom-diff-light', {
          base: 'vs',
          inherit: true,
          rules: [],
          colors: {
            'diffEditor.insertedTextBackground': MONACO_DIFF_COLORS.light.insertedTextBackground,
            'diffEditor.insertedLineBackground': MONACO_DIFF_COLORS.light.insertedLineBackground,
            'diffEditor.removedTextBackground': MONACO_DIFF_COLORS.light.removedTextBackground,
            'diffEditor.removedLineBackground': MONACO_DIFF_COLORS.light.removedLineBackground,
            'diffEditor.unchangedRegionBackground': '#e2e8f0',
          },
        });

        const currentTheme =
          effectiveTheme === 'dark-black'
            ? 'custom-diff-black'
            : effectiveTheme === 'dark'
              ? 'custom-diff-dark'
              : 'custom-diff-light';
        monaco.editor.setTheme(currentTheme);
      } catch (error) {
        console.warn('Failed to define Monaco themes:', error);
      }
    };
    defineThemes();

    return () => {
      const existingStyle = document.getElementById(styleId);
      if (existingStyle) {
        existingStyle.remove();
      }
    };
  }, [open, isDark, effectiveTheme]);

  // Cleanup editor on unmount
  useEffect(() => {
    return () => {
      const currentEditor = editorRef.current;
      if (currentEditor) {
        try {
          currentEditor.getModifiedEditor().deltaDecorations(stageDecorationIdsRef.current, []);
        } catch {
          // ignore
        }
        try {
          currentEditor.dispose();
        } catch {
          // Ignore disposal errors
        }
      }
      editorRef.current = null;
      try {
        changeDisposableRef.current?.dispose();
      } catch {
        // ignore
      }
      changeDisposableRef.current = null;
      try {
        diffUpdateDisposableRef.current?.dispose();
      } catch {
        // ignore
      }
      diffUpdateDisposableRef.current = null;
      try {
        stageClickDisposableRef.current?.dispose();
      } catch {
        // ignore
      }
      stageClickDisposableRef.current = null;
      try {
        activeEditorCleanupRef.current?.();
      } catch {
        // ignore
      }
      activeEditorCleanupRef.current = null;
      stageDecorationIdsRef.current = [];

      // Reset diagnostic options when closing modal
      loader
        .init()
        .then((monaco) => {
          resetDiagnosticOptions(monaco);
        })
        .catch(() => {
          // Ignore errors during cleanup
        });
    };
  }, []);

  const handleEditorDidMount = async (editor: monaco.editor.IStandaloneDiffEditor) => {
    editorRef.current = editor;
    setEditorInstance(editor); // Trigger re-render so useDiffEditorComments sees the editor
    try {
      activeEditorCleanupRef.current?.();
    } catch {
      // ignore
    }
    activeEditorCleanupRef.current = registerActiveCodeEditor(editor.getModifiedEditor());

    // Define themes when editor is ready
    try {
      const monaco = await loader.init();

      // Add Save Command (Cmd+S / Ctrl+S)
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        handleSaveRef.current();
      });

      // Configure diagnostics to suppress warnings in diff viewer
      // Disabling all validation since diff viewer is read-only
      configureDiffEditorDiagnostics(editor, monaco, {
        disableAllValidation: true,
        suppressSpecificErrors: false,
      });
      monaco.editor.defineTheme('custom-diff-dark', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': MONACO_DIFF_COLORS.dark.editorBackground,
          'editorGutter.background': MONACO_DIFF_COLORS.dark.editorBackground,
          'diffEditor.insertedTextBackground': MONACO_DIFF_COLORS.dark.insertedTextBackground,
          'diffEditor.insertedLineBackground': MONACO_DIFF_COLORS.dark.insertedLineBackground,
          'diffEditor.removedTextBackground': MONACO_DIFF_COLORS.dark.removedTextBackground,
          'diffEditor.removedLineBackground': MONACO_DIFF_COLORS.dark.removedLineBackground,
          'diffEditor.unchangedRegionBackground': '#1a2332',
        },
      });

      // Black theme with pure black background
      monaco.editor.defineTheme('custom-diff-black', {
        base: 'vs-dark',
        inherit: true,
        rules: [],
        colors: {
          'editor.background': MONACO_DIFF_COLORS['dark-black'].editorBackground,
          'editorGutter.background': MONACO_DIFF_COLORS['dark-black'].editorBackground,
          'diffEditor.insertedTextBackground':
            MONACO_DIFF_COLORS['dark-black'].insertedTextBackground,
          'diffEditor.insertedLineBackground':
            MONACO_DIFF_COLORS['dark-black'].insertedLineBackground,
          'diffEditor.removedTextBackground':
            MONACO_DIFF_COLORS['dark-black'].removedTextBackground,
          'diffEditor.removedLineBackground':
            MONACO_DIFF_COLORS['dark-black'].removedLineBackground,
          'diffEditor.unchangedRegionBackground': '#0a0a0a',
        },
      });

      monaco.editor.defineTheme('custom-diff-light', {
        base: 'vs',
        inherit: true,
        rules: [],
        colors: {
          'diffEditor.insertedTextBackground': MONACO_DIFF_COLORS.light.insertedTextBackground,
          'diffEditor.insertedLineBackground': MONACO_DIFF_COLORS.light.insertedLineBackground,
          'diffEditor.removedTextBackground': MONACO_DIFF_COLORS.light.removedTextBackground,
          'diffEditor.removedLineBackground': MONACO_DIFF_COLORS.light.removedLineBackground,
          'diffEditor.unchangedRegionBackground': '#e2e8f0',
        },
      });
      const currentTheme =
        effectiveTheme === 'dark-black'
          ? 'custom-diff-black'
          : effectiveTheme === 'dark'
            ? 'custom-diff-dark'
            : 'custom-diff-light';
      monaco.editor.setTheme(currentTheme);
    } catch (error) {
      console.warn('Failed to define Monaco themes:', error);
    }

    try {
      const modifiedEditor = editor.getModifiedEditor();
      changeDisposableRef.current?.dispose();
      changeDisposableRef.current = modifiedEditor.onDidChangeModelContent(() => {
        const value = modifiedEditor.getValue() ?? '';
        setModifiedDraft(value);
        setSaveError(null);
      });
    } catch {
      // best effort
    }

    try {
      diffUpdateDisposableRef.current?.dispose();
      diffUpdateDisposableRef.current = editor.onDidUpdateDiff(() => {
        setDecorationNonce((prev) => prev + 1);
      });
    } catch {
      // best effort
    }
  };

  useEffect(() => {
    const diffEditor = editorInstance ?? editorRef.current;
    if (!diffEditor) return;

    const modifiedEditor = diffEditor.getModifiedEditor();
    if (!fileData || fileData.loading || fileData.error || !selectedBlockAction) {
      try {
        stageDecorationIdsRef.current = modifiedEditor.deltaDecorations(
          stageDecorationIdsRef.current,
          []
        );
      } catch {
        // ignore decoration cleanup errors
      }
      return;
    }

    const lineChanges = diffEditor.getLineChanges();
    const anchorLines =
      lineChanges && lineChanges.length > 0
        ? getAnchorLinesFromDiffChanges(lineChanges)
        : getStageAnchorLines(fileData.diffLines);
    const stageDecorations = buildStageDecorations(anchorLines, selectedBlockAction);

    try {
      stageDecorationIdsRef.current = modifiedEditor.deltaDecorations(
        stageDecorationIdsRef.current,
        stageDecorations
      );
    } catch {
      // ignore decoration errors
    }
  }, [editorInstance, fileData, selectedBlockAction, decorationNonce]);

  useEffect(() => {
    const diffEditor = editorInstance ?? editorRef.current;
    if (!diffEditor) return;

    const modifiedEditor = diffEditor.getModifiedEditor();
    try {
      stageClickDisposableRef.current?.dispose();
    } catch {
      // ignore
    }

    stageClickDisposableRef.current = modifiedEditor.onMouseDown((event) => {
      const element = event.target.element as HTMLElement | null;
      const clickedStageAction = element?.closest(
        `.${STAGE_CHANGE_GLYPH_CLASS}, .${UNSTAGE_CHANGE_GLYPH_CLASS}`
      );
      if (!clickedStageAction) return;

      event.event.preventDefault();
      event.event.stopPropagation();

      if (!selected || !safeTaskPath) return;
      if (!selectedBlockAction) return;
      const lineNumber = event.target.position?.lineNumber;
      if (!lineNumber) return;

      if (isDirty) {
        toast({
          title: 'Save required',
          description: 'Save this file before changing staged state for a block.',
          variant: 'destructive',
        });
        return;
      }

      if (isStagingRange) return;

      void (async () => {
        setIsStagingRange(true);
        try {
          if (selectedBlockAction === 'stage') {
            const result = await window.electronAPI.stageDiffRange({
              taskPath: safeTaskPath,
              filePath: selected,
              startLine: lineNumber,
              endLine: lineNumber,
            });

            if (!result?.success) {
              throw new Error(result?.error || 'Failed to stage selected change block');
            }

            if (!result.staged) {
              toast({
                title: 'Nothing to stage',
                description: 'No unstaged change block was found at this location.',
              });
              return;
            }
          } else {
            const result = await window.electronAPI.unstageDiffRange({
              taskPath: safeTaskPath,
              filePath: selected,
              startLine: lineNumber,
              endLine: lineNumber,
            });

            if (!result?.success) {
              throw new Error(result?.error || 'Failed to unstage selected change block');
            }

            if (!result.unstaged) {
              toast({
                title: 'Nothing to unstage',
                description: 'No staged change block was found at this location.',
              });
              return;
            }
          }

          const localApplyResult =
            fileData && !fileData.loading && !fileData.error
              ? applyBlockStageLocally(fileData.diffLines, lineNumber, selectedSection)
              : null;

          let appliedInEditor = false;
          if (localApplyResult?.applied && localApplyResult.hasRemainingChanges) {
            const diffEditor = editorInstance ?? editorRef.current;
            const modelUpdate = diffEditor
              ? applyStageChangeToModels(diffEditor, lineNumber, selectedSection)
              : null;

            if (modelUpdate) {
              appliedInEditor = true;
              setFileData((prev) =>
                prev
                  ? {
                      ...prev,
                      original: modelUpdate.original,
                      modified: modelUpdate.modified,
                      initialModified: modelUpdate.modified,
                      diffLines: localApplyResult.lines,
                    }
                  : prev
              );
              setModifiedDraft(modelUpdate.modified);
            }
          }

          dispatchFileChangeEvent(safeTaskPath, selected);
          if (onRefreshChanges) {
            void Promise.resolve(onRefreshChanges()).catch(() => {});
          }

          if (localApplyResult?.applied) {
            if (!localApplyResult.hasRemainingChanges) {
              setSelectedSection(selectedSection === 'unstaged' ? 'staged' : 'unstaged');
              return;
            }
            if (!appliedInEditor) {
              setReloadNonce((prev) => prev + 1);
            }
          } else {
            setReloadNonce((prev) => prev + 1);
          }
        } catch (error: any) {
          toast({
            title: selectedBlockAction === 'stage' ? 'Stage Failed' : 'Unstage Failed',
            description:
              error?.message ||
              (selectedBlockAction === 'stage'
                ? 'Failed to stage selected change block.'
                : 'Failed to unstage selected change block.'),
            variant: 'destructive',
          });
        } finally {
          setIsStagingRange(false);
        }
      })();
    });

    return () => {
      try {
        stageClickDisposableRef.current?.dispose();
      } catch {
        // ignore
      }
      stageClickDisposableRef.current = null;
    };
  }, [
    selected,
    safeTaskPath,
    editorInstance,
    isDirty,
    isStagingRange,
    onRefreshChanges,
    fileData,
    selectedSection,
    selectedBlockAction,
    toast,
  ]);

  const handleSave = async () => {
    if (!selected || !fileData || !safeTaskPath) return;
    setIsSaving(true);
    setSaveError(null);
    try {
      const res = await window.electronAPI.fsWriteFile(safeTaskPath, selected, modifiedDraft, true);
      if (!res?.success) {
        throw new Error(res?.error || 'Failed to save file');
      }
      setFileData((prev) =>
        prev
          ? {
              ...prev,
              modified: modifiedDraft,
              initialModified: modifiedDraft,
            }
          : prev
      );
      // Dispatch file change event to update editor
      dispatchFileChangeEvent(safeTaskPath, selected);
      if (onRefreshChanges) {
        await onRefreshChanges();
      }
      setReloadNonce((prev) => prev + 1);
    } catch (error: any) {
      const message = error?.message || 'Failed to save file';
      setSaveError(message);
      toast({
        title: 'Save failed',
        description: message,
        variant: 'destructive',
      });
    } finally {
      setIsSaving(false);
    }
  };

  // Keep a ref to the latest handleSave callback so it can be used in listeners
  const handleSaveRef = useRef(handleSave);
  useEffect(() => {
    handleSaveRef.current = handleSave;
  }, [handleSave]);

  const { staged: stagedFiles, unstaged: unstagedFiles } = splitChangesByStage(files);

  const handleToggleFileStage = async (
    filePath: string,
    sectionKey: 'staged' | 'unstaged',
    event: React.MouseEvent<HTMLButtonElement>
  ) => {
    event.preventDefault();
    event.stopPropagation();

    if (!safeTaskPath) return;
    const action = sectionKey === 'unstaged' ? 'stage' : 'unstage';
    const opKey = `${action}:${filePath}`;

    setIsTogglingFileStage((prev) => {
      const next = new Set(prev);
      next.add(opKey);
      return next;
    });

    try {
      const result =
        action === 'stage'
          ? await window.electronAPI.stageFile({ taskPath: safeTaskPath, filePath })
          : await window.electronAPI.unstageFile({ taskPath: safeTaskPath, filePath });

      if (!result?.success) {
        throw new Error(
          result?.error ||
            (action === 'stage' ? 'Failed to stage file.' : 'Failed to unstage file.')
        );
      }

      dispatchFileChangeEvent(safeTaskPath, filePath);
      if (selected === filePath) {
        setSelectedSection(action === 'stage' ? 'staged' : 'unstaged');
      }
      if (onRefreshChanges) {
        await onRefreshChanges();
      }
      setReloadNonce((prev) => prev + 1);
    } catch (error: any) {
      toast({
        title: action === 'stage' ? 'Stage Failed' : 'Unstage Failed',
        description:
          error?.message ||
          (action === 'stage' ? 'Failed to stage file.' : 'Failed to unstage file.'),
        variant: 'destructive',
      });
    } finally {
      setIsTogglingFileStage((prev) => {
        const next = new Set(prev);
        next.delete(opKey);
        return next;
      });
    }
  };

  const renderSidebarFile = (file: FileChange, sectionKey: 'staged' | 'unstaged', index: number) => {
    const sectionCounts = getChangeCountsForSection(file, sectionKey);
    const actionKey = `${sectionKey === 'unstaged' ? 'stage' : 'unstage'}:${file.path}`;
    const isActionLoading = isTogglingFileStage.has(actionKey);

    return (
      <div
        key={`${sectionKey}-${file.path}-${index}`}
        className={`group flex w-full items-center gap-2 border-b border-border px-3 py-2 text-left text-sm hover:bg-muted dark:border-border dark:hover:bg-accent ${
          selected === file.path && selectedSection === sectionKey
            ? 'bg-muted text-foreground dark:bg-muted dark:text-foreground'
            : 'text-foreground'
        }`}
        role="button"
        tabIndex={0}
        onClick={() => {
          setSelected(file.path);
          setSelectedSection(sectionKey);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            setSelected(file.path);
            setSelectedSection(sectionKey);
          }
        }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1">
            <span className="inline-flex items-center justify-center text-muted-foreground">
              <FileIcon filename={file.path} isDirectory={false} size={14} />
            </span>
            <div className="truncate font-medium">{file.path}</div>
            {selected === file.path && selectedSection === sectionKey && isDirty && (
              <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-500" />
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {file.status} • +{sectionCounts.additions} / -{sectionCounts.deletions}
            {commentCounts[file.path] > 0 && (
              <span className="text-blue-600 dark:text-blue-400">
                {' '}
                • {commentCounts[file.path]} {commentCounts[file.path] === 1 ? 'comment' : 'comments'}
              </span>
            )}
          </div>
        </div>
        <TooltipProvider delayDuration={100}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={(event) => {
                  void handleToggleFileStage(file.path, sectionKey, event);
                }}
                disabled={isActionLoading}
                className={`inline-flex h-6 w-6 flex-shrink-0 self-center items-center justify-center rounded border border-border/70 text-muted-foreground transition hover:bg-accent hover:text-foreground ${
                  isActionLoading
                    ? 'opacity-100'
                    : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100'
                }`}
                aria-label={sectionKey === 'unstaged' ? 'Stage file' : 'Unstage file'}
              >
                {isActionLoading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : sectionKey === 'unstaged' ? (
                  <Plus className="h-3.5 w-3.5" />
                ) : (
                  <Minus className="h-3.5 w-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent
              side="right"
              className="border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-lg"
            >
              {sectionKey === 'unstaged' ? 'Stage file' : 'Unstage file'}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  };

  if (typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm"
          role="dialog"
          aria-modal="true"
          initial={shouldReduceMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={shouldReduceMotion ? { opacity: 1 } : { opacity: 0 }}
          transition={shouldReduceMotion ? { duration: 0 } : { duration: 0.12, ease: 'easeOut' }}
          onClick={onClose}
        >
          <motion.div
            onClick={(e) => e.stopPropagation()}
            initial={shouldReduceMotion ? false : { opacity: 0, y: 8, scale: 0.995 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={
              shouldReduceMotion
                ? { opacity: 1, y: 0, scale: 1 }
                : { opacity: 0, y: 6, scale: 0.995 }
            }
            transition={
              shouldReduceMotion ? { duration: 0 } : { duration: 0.2, ease: [0.22, 1, 0.36, 1] }
            }
            className="flex h-[82vh] w-[92vw] transform-gpu overflow-hidden rounded-xl border border-border bg-white shadow-2xl will-change-transform dark:border-border dark:bg-card"
          >
            <div className="w-72 overflow-y-auto border-r border-border bg-muted dark:border-border dark:bg-muted/40">
              <div className="px-3 py-2 text-xs tracking-wide text-muted-foreground">
                Changed Files
              </div>
              {stagedFiles.length > 0 && (
                <div className="border-y border-border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Staged
                </div>
              )}
              {stagedFiles.map((file, index) => renderSidebarFile(file, 'staged', index))}
              {unstagedFiles.length > 0 && (
                <div className="border-y border-border px-3 py-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Unstaged
                </div>
              )}
              {unstagedFiles.map((file, index) => renderSidebarFile(file, 'unstaged', index))}
            </div>

            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex items-center justify-between border-b border-border bg-white/80 px-4 py-2.5 dark:border-border dark:bg-muted/50">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <div className="flex min-w-0 items-center gap-1">
                    <span className="truncate font-mono text-sm text-foreground">{selected}</span>
                    {isDirty && (
                      <div className="h-1.5 w-1.5 flex-shrink-0 rounded-full bg-blue-500" />
                    )}
                  </div>
                  <span className="shrink-0 rounded border border-border/60 bg-muted/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {selectedSection}
                  </span>
                  {selected && (
                    <button
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(selected);
                          setCopiedFile(selected);
                          setTimeout(() => {
                            setCopiedFile(null);
                          }, 2000);
                        } catch (error) {
                          toast({
                            title: 'Copy failed',
                            description: 'Failed to copy file path',
                            variant: 'destructive',
                          });
                        }
                      }}
                      className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-muted-foreground"
                      title="Copy file path"
                      aria-label="Copy file path"
                    >
                      {copiedFile === selected ? (
                        <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
                      ) : (
                        <Copy className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}
                  {onToggleView && (
                    <button
                      onClick={onToggleView}
                      className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground dark:text-muted-foreground dark:hover:bg-accent dark:hover:text-foreground"
                    >
                      File View
                    </button>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  {(isDirty || isSaving) && !fileData?.error && (
                    <button
                      onClick={handleSave}
                      disabled={!isDirty || isSaving}
                      className={`inline-flex items-center rounded-md px-3 py-1 text-sm font-medium transition ${
                        !isDirty || isSaving
                          ? 'cursor-not-allowed bg-muted text-muted-foreground dark:bg-muted dark:text-muted-foreground'
                          : 'dark:bg-muted0 bg-muted text-white hover:bg-accent dark:hover:bg-muted'
                      }`}
                    >
                      {isSaving ? 'Saving…' : 'Save'}
                    </button>
                  )}
                  <button
                    onClick={onClose}
                    className="rounded-md p-1 text-muted-foreground hover:bg-muted dark:text-muted-foreground dark:hover:bg-accent"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
              </div>

              <div className="relative flex-1 overflow-hidden">
                {fileData?.loading ? (
                  <div className="flex h-full items-center justify-center text-muted-foreground">
                    <div className="flex items-center gap-2">
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-border border-t-gray-600 dark:border-border dark:border-t-gray-400"></div>
                      <span className="text-sm">Loading diff...</span>
                    </div>
                  </div>
                ) : fileData?.isImage ? (
                  <div className="flex h-full items-center justify-center overflow-auto bg-muted/20 p-6">
                    {fileData.imageDataUrl ? (
                      <img
                        src={fileData.imageDataUrl}
                        alt={selected || 'Image preview'}
                        className="max-h-full max-w-full rounded-md border border-border bg-background object-contain shadow-sm"
                      />
                    ) : (
                      <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-muted-foreground">
                        <span className="text-sm">{fileData.error || 'Image preview unavailable'}</span>
                      </div>
                    )}
                  </div>
                ) : fileData?.error ? (
                  <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-muted-foreground">
                    <span className="text-sm">{fileData.error}</span>
                  </div>
                ) : fileData ? (
                  <>
                    <div className="h-full">
                      <DiffEditor
                        height="100%"
                        language={fileData.language}
                        original={fileData.original}
                        modified={modifiedDraft}
                        theme={isDark ? 'custom-diff-dark' : 'custom-diff-light'}
                        options={{
                          readOnly: false,
                          originalEditable: false,
                          renderSideBySide: false, // Unified/inline view
                          fontSize: 13,
                          lineHeight: 20,
                          minimap: { enabled: false },
                          scrollBeyondLastLine: false,
                          wordWrap: 'on',
                          lineNumbers: 'on',
                          lineNumbersMinChars: 2,
                          renderIndicators: true,
                          overviewRulerLanes: 3,
                          renderOverviewRuler: true,
                          overviewRulerBorder: false,
                          automaticLayout: true,
                          scrollbar: {
                            vertical: 'auto',
                            horizontal: 'auto',
                            useShadows: false,
                            verticalScrollbarSize: 4,
                            horizontalScrollbarSize: 4,
                            arrowSize: 0,
                            verticalHasArrows: false,
                            horizontalHasArrows: false,
                            alwaysConsumeMouseWheel: false,
                            verticalSliderSize: 4,
                            horizontalSliderSize: 4,
                          },
                          hideUnchangedRegions: {
                            enabled: true,
                          },
                          diffWordWrap: 'on',
                          enableSplitViewResizing: false,
                          smoothScrolling: true,
                          cursorSmoothCaretAnimation: 'on',
                          padding: { top: 8, bottom: 8 },
                          glyphMargin: true,
                          lineDecorationsWidth: 16,
                          folding: false,
                          renderMarginRevertIcon: false,
                        }}
                        onMount={handleEditorDidMount}
                      />
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};

export default ChangesDiffModal;
