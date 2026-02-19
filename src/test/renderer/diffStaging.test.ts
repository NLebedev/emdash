import { describe, expect, it } from 'vitest';
import { getStageAnchorLines, splitChangesByStage } from '../../renderer/lib/diffStaging';

describe('diffStaging', () => {
  describe('getStageAnchorLines', () => {
    it('returns first modified-side line for each diff hunk', () => {
      const anchors = getStageAnchorLines([
        { type: 'context' },
        { type: 'add' },
        { type: 'add' },
        { type: 'context' },
        { type: 'del' },
        { type: 'add' },
        { type: 'context' },
        { type: 'del' },
        { type: 'context' },
      ]);

      expect(anchors).toEqual([2, 5, 7]);
    });

    it('returns empty when there are no changed lines', () => {
      const anchors = getStageAnchorLines([{ type: 'context' }, { type: 'context' }]);
      expect(anchors).toEqual([]);
    });
  });

  describe('splitChangesByStage', () => {
    it('splits files into staged and unstaged sections, keeping partially staged in both', () => {
      const changes = [
        { path: 'a.ts', isStaged: true, hasUnstaged: false },
        { path: 'b.ts', isStaged: false, hasUnstaged: true },
        { path: 'c.ts', isStaged: true, hasUnstaged: true },
        { path: 'd.ts', isStaged: false, hasUnstaged: false },
      ];

      const grouped = splitChangesByStage(changes);

      expect(grouped.staged.map((c) => c.path)).toEqual(['a.ts', 'c.ts']);
      expect(grouped.unstaged.map((c) => c.path)).toEqual(['b.ts', 'c.ts']);
    });

    it('falls back to !isStaged when hasUnstaged is missing', () => {
      const grouped = splitChangesByStage([
        { path: 'only-staged.ts', isStaged: true },
        { path: 'only-unstaged.ts', isStaged: false },
      ]);

      expect(grouped.staged.map((c) => c.path)).toEqual(['only-staged.ts']);
      expect(grouped.unstaged.map((c) => c.path)).toEqual(['only-unstaged.ts']);
    });
  });
});
