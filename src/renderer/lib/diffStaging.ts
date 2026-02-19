export type StagingDiffLine = {
  type: 'context' | 'add' | 'del';
};

export type StageAwareFile = {
  isStaged: boolean;
  hasUnstaged?: boolean;
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
