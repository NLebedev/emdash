export type StagingDiffLine = {
  type: 'context' | 'add' | 'del';
  left?: string;
  right?: string;
};

export const STAGE_CHANGE_GLYPH_CLASS = 'stage-change-glyph';
export const UNSTAGE_CHANGE_GLYPH_CLASS = 'unstage-change-glyph';

export type StageAwareFile = {
  additions?: number;
  deletions?: number;
  isStaged: boolean;
  hasUnstaged?: boolean;
  stagedAdditions?: number;
  stagedDeletions?: number;
  unstagedAdditions?: number;
  unstagedDeletions?: number;
};

export type StageAction = 'stage' | 'unstage';

export type DiffLineChange = {
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
};

export type StageDecoration = {
  range: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
  options: {
    isWholeLine: boolean;
    glyphMarginClassName: string;
    glyphMarginHoverMessage: { value: string };
  };
};

export function getStageAnchorLines(diffLines: StagingDiffLine[]): number[] {
  const anchors: number[] = [];
  let modifiedLineNumber = 1;
  let insideHunk = false;

  for (const line of diffLines) {
    if (line.type === 'context') {
      modifiedLineNumber += 1;
      insideHunk = false;
      continue;
    }

    if (!insideHunk) {
      anchors.push(modifiedLineNumber);
      insideHunk = true;
    }

    if (line.type === 'add') {
      modifiedLineNumber += 1;
    }
  }

  return Array.from(new Set(anchors));
}

export function getAnchorLinesFromDiffChanges(lineChanges: DiffLineChange[]): number[] {
  const anchors = lineChanges
    .map((change) => {
      if (change.modifiedStartLineNumber > 0) return change.modifiedStartLineNumber;
      if (change.modifiedEndLineNumber > 0) return change.modifiedEndLineNumber;
      return 1;
    })
    .filter((line) => line > 0);
  return Array.from(new Set(anchors));
}

export function buildStageDecorations(
  anchorLines: number[],
  action: StageAction = 'stage'
): StageDecoration[] {
  const glyphClass =
    action === 'unstage' ? UNSTAGE_CHANGE_GLYPH_CLASS : STAGE_CHANGE_GLYPH_CLASS;
  const hoverMessage =
    action === 'unstage' ? 'Unstage this change block' : 'Stage this change block';

  return anchorLines.map((lineNumber) => ({
    range: {
      startLineNumber: lineNumber,
      startColumn: 1,
      endLineNumber: lineNumber,
      endColumn: 1,
    },
    options: {
      isWholeLine: true,
      glyphMarginClassName: glyphClass,
      glyphMarginHoverMessage: { value: hoverMessage },
    },
  }));
}

export function splitChangesByStage<T extends StageAwareFile>(changes: T[]): {
  staged: T[];
  unstaged: T[];
} {
  const staged = changes.filter((change) => change.isStaged);
  const unstaged = changes.filter((change) =>
    typeof change.hasUnstaged === 'boolean' ? change.hasUnstaged : !change.isStaged
  );
  return { staged, unstaged };
}

export function getChangeCountsForSection(
  change: StageAwareFile,
  section: 'staged' | 'unstaged'
): { additions: number; deletions: number } {
  if (section === 'staged') {
    return {
      additions:
        typeof change.stagedAdditions === 'number' ? change.stagedAdditions : change.additions ?? 0,
      deletions:
        typeof change.stagedDeletions === 'number' ? change.stagedDeletions : change.deletions ?? 0,
    };
  }

  return {
    additions:
      typeof change.unstagedAdditions === 'number'
        ? change.unstagedAdditions
        : change.additions ?? 0,
    deletions:
      typeof change.unstagedDeletions === 'number'
        ? change.unstagedDeletions
        : change.deletions ?? 0,
  };
}

type DiffHunk = {
  startIndex: number;
  endIndex: number;
  anchorLine: number;
  startLine: number;
  endLine: number;
};

function getDiffHunks(lines: StagingDiffLine[]): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let modifiedLine = 1;
  let current: DiffHunk | null = null;

  const flush = () => {
    if (current) {
      hunks.push(current);
      current = null;
    }
  };

  lines.forEach((line, index) => {
    if (line.type === 'context') {
      modifiedLine += 1;
      flush();
      return;
    }

    if (!current) {
      current = {
        startIndex: index,
        endIndex: index,
        anchorLine: modifiedLine,
        startLine: modifiedLine,
        endLine: modifiedLine,
      };
    } else {
      current.endIndex = index;
    }

    if (line.type === 'add') {
      modifiedLine += 1;
      if (current) {
        current.endLine = Math.max(current.endLine, modifiedLine - 1);
      }
    } else if (current) {
      current.endLine = Math.max(current.endLine, modifiedLine);
    }
  });

  flush();
  return hunks;
}

function resolveHunkAtLine(lines: StagingDiffLine[], lineNumber: number): DiffHunk | null {
  const hunks = getDiffHunks(lines);
  if (hunks.length === 0) return null;

  const exactAnchor = hunks.find((hunk) => hunk.anchorLine === lineNumber);
  if (exactAnchor) return exactAnchor;

  return hunks.find((hunk) => lineNumber >= hunk.startLine && lineNumber <= hunk.endLine) || null;
}

export function applyBlockStageLocally(
  lines: StagingDiffLine[],
  lineNumber: number,
  section: 'staged' | 'unstaged'
): { lines: StagingDiffLine[]; applied: boolean; hasRemainingChanges: boolean } {
  const hunk = resolveHunkAtLine(lines, lineNumber);
  if (!hunk) {
    return {
      lines,
      applied: false,
      hasRemainingChanges: lines.some((line) => line.type !== 'context'),
    };
  }

  const nextHunkLines: StagingDiffLine[] = [];
  for (let index = hunk.startIndex; index <= hunk.endIndex; index += 1) {
    const line = lines[index];
    if (section === 'unstaged') {
      // Stage from working tree -> index:
      // added lines become context, deleted lines disappear.
      if (line.type === 'add') {
        const content = line.right ?? line.left ?? '';
        nextHunkLines.push({ type: 'context', left: content, right: content });
      }
      continue;
    }

    // Unstage from index -> working tree:
    // deleted lines become context, added lines disappear.
    if (line.type === 'del') {
      const content = line.left ?? line.right ?? '';
      nextHunkLines.push({ type: 'context', left: content, right: content });
    }
  }

  const nextLines = [
    ...lines.slice(0, hunk.startIndex),
    ...nextHunkLines,
    ...lines.slice(hunk.endIndex + 1),
  ];

  return {
    lines: nextLines,
    applied: true,
    hasRemainingChanges: nextLines.some((line) => line.type !== 'context'),
  };
}
