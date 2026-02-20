import React, { useMemo, useState } from 'react';
import type { FileChange } from '../../hooks/useFileChanges';
import ChangesDiffModal from '../ChangesDiffModal';

const FIXTURE_FILE_PATH = 'src/e2e-fixture/diff-smoke.ts';
const FIXTURE_TASK_PATH = '/tmp/emdash-e2e-diff-smoke';

const UNSTAGED_DIFF_LINES = [
  { type: 'context' as const, left: 'const base = 1;', right: 'const base = 1;' },
  { type: 'del' as const, left: 'const oldValue = 2;' },
  { type: 'add' as const, right: 'const newValue = 2;' },
  { type: 'context' as const, left: 'const keep = true;', right: 'const keep = true;' },
  { type: 'add' as const, right: 'const addedLine = "visible";' },
  { type: 'context' as const, left: 'export { base };', right: 'export { base };' },
];

const STAGED_DIFF_LINES = [
  { type: 'context' as const, left: 'const base = 1;', right: 'const base = 1;' },
  { type: 'del' as const, left: 'const stagedOld = 5;' },
  { type: 'add' as const, right: 'const stagedNew = 5;' },
  { type: 'context' as const, left: 'export { base };', right: 'export { base };' },
];

const MODIFIED_CONTENT = [
  'const base = 1;',
  'const newValue = 2;',
  'const keep = true;',
  'const addedLine = "visible";',
  'export { base };',
].join('\n');

const FIXTURE_FILES: FileChange[] = [
  {
    path: FIXTURE_FILE_PATH,
    status: 'modified',
    additions: 3,
    deletions: 2,
    isStaged: true,
    hasUnstaged: true,
    stagedAdditions: 1,
    stagedDeletions: 1,
    unstagedAdditions: 2,
    unstagedDeletions: 1,
  },
];

const DiffSmokeHarness: React.FC = () => {
  const [open, setOpen] = useState(true);

  const mockElectronApi = useMemo(() => {
    const api: React.ComponentProps<typeof ChangesDiffModal>['electronAPI'] = {
      fsReadImage: async () => ({ success: false, error: 'not-used-in-diff-smoke' }),
      getFileDiff: async ({ scope }) => {
        if (scope === 'staged') {
          return { success: true, diff: { lines: STAGED_DIFF_LINES } };
        }
        if (scope === 'unstaged') {
          return { success: true, diff: { lines: UNSTAGED_DIFF_LINES } };
        }
        return { success: true, diff: { lines: [...STAGED_DIFF_LINES, ...UNSTAGED_DIFF_LINES] } };
      },
      fsRead: async () => ({ success: true, content: MODIFIED_CONTENT }),
      stageDiffRange: async () => ({ success: true, staged: true, stagedHunks: 1 }),
      unstageDiffRange: async () => ({ success: true, unstaged: true, unstagedHunks: 1 }),
      fsWriteFile: async () => ({ success: true }),
      stageFile: async () => ({ success: true }),
      unstageFile: async () => ({ success: true }),
    };
    return api;
  }, []);

  return (
    <div data-testid="e2e-diff-smoke-ready" className="h-screen w-screen bg-background">
      <ChangesDiffModal
        open={open}
        onClose={() => setOpen(false)}
        taskId="e2e-task"
        taskPath={FIXTURE_TASK_PATH}
        files={FIXTURE_FILES}
        initialFile={FIXTURE_FILE_PATH}
        initialSection="unstaged"
        electronAPI={mockElectronApi}
      />
      {!open && <div data-testid="e2e-diff-smoke-closed">closed</div>}
    </div>
  );
};

export default DiffSmokeHarness;
