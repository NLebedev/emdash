import { describe, expect, it } from 'vitest';
import {
  applyBlockStageLocally,
  getAnchorLinesFromDiffChanges,
  buildStageDecorations,
  getChangeCountsForSection,
  getStageAnchorLines,
  splitChangesByStage,
  STAGE_CHANGE_GLYPH_CLASS,
  UNSTAGE_CHANGE_GLYPH_CLASS,
} from '../../renderer/lib/diffStaging';

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

  describe('getAnchorLinesFromDiffChanges', () => {
    it('returns anchors for each changed block as reported by Monaco line changes', () => {
      const anchors = getAnchorLinesFromDiffChanges([
        { modifiedStartLineNumber: 3, modifiedEndLineNumber: 6 },
        { modifiedStartLineNumber: 11, modifiedEndLineNumber: 14 },
      ]);

      expect(anchors).toEqual([3, 11]);
    });

    it('falls back to line 1 when Monaco reports empty modified range', () => {
      const anchors = getAnchorLinesFromDiffChanges([
        { modifiedStartLineNumber: 0, modifiedEndLineNumber: 0 },
      ]);
      expect(anchors).toEqual([1]);
    });
  });

  describe('buildStageDecorations', () => {
    it('creates glyph-margin decorations for block staging', () => {
      const decorations = buildStageDecorations([3, 11], 'stage');

      expect(decorations).toEqual([
        {
          range: {
            startLineNumber: 3,
            startColumn: 1,
            endLineNumber: 3,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            glyphMarginClassName: STAGE_CHANGE_GLYPH_CLASS,
            glyphMarginHoverMessage: { value: 'Stage this change block' },
          },
        },
        {
          range: {
            startLineNumber: 11,
            startColumn: 1,
            endLineNumber: 11,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            glyphMarginClassName: STAGE_CHANGE_GLYPH_CLASS,
            glyphMarginHoverMessage: { value: 'Stage this change block' },
          },
        },
      ]);
    });

    it('creates glyph-margin decorations for block unstaging', () => {
      const decorations = buildStageDecorations([5], 'unstage');

      expect(decorations).toEqual([
        {
          range: {
            startLineNumber: 5,
            startColumn: 1,
            endLineNumber: 5,
            endColumn: 1,
          },
          options: {
            isWholeLine: true,
            glyphMarginClassName: UNSTAGE_CHANGE_GLYPH_CLASS,
            glyphMarginHoverMessage: { value: 'Unstage this change block' },
          },
        },
      ]);
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

  describe('getChangeCountsForSection', () => {
    it('returns section-specific counts when staged/unstaged stats are available', () => {
      const change = {
        additions: 10,
        deletions: 6,
        isStaged: true,
        hasUnstaged: true,
        stagedAdditions: 3,
        stagedDeletions: 2,
        unstagedAdditions: 7,
        unstagedDeletions: 4,
      };

      expect(getChangeCountsForSection(change, 'staged')).toEqual({ additions: 3, deletions: 2 });
      expect(getChangeCountsForSection(change, 'unstaged')).toEqual({ additions: 7, deletions: 4 });
    });

    it('falls back to total counts when section-specific stats are unavailable', () => {
      const change = {
        additions: 4,
        deletions: 1,
        isStaged: false,
        hasUnstaged: true,
      };

      expect(getChangeCountsForSection(change, 'staged')).toEqual({ additions: 4, deletions: 1 });
      expect(getChangeCountsForSection(change, 'unstaged')).toEqual({ additions: 4, deletions: 1 });
    });
  });

  describe('applyBlockStageLocally', () => {
    it('stages an unstaged add block in place (add becomes context)', () => {
      const result = applyBlockStageLocally(
        [
          { type: 'context', left: 'a', right: 'a' },
          { type: 'add', right: 'b' },
          { type: 'context', left: 'c', right: 'c' },
        ],
        2,
        'unstaged'
      );

      expect(result.applied).toBe(true);
      expect(result.hasRemainingChanges).toBe(false);
      expect(result.lines).toEqual([
        { type: 'context', left: 'a', right: 'a' },
        { type: 'context', left: 'b', right: 'b' },
        { type: 'context', left: 'c', right: 'c' },
      ]);
    });

    it('stages an unstaged delete block in place (delete disappears)', () => {
      const result = applyBlockStageLocally(
        [
          { type: 'context', left: 'a', right: 'a' },
          { type: 'del', left: 'b' },
          { type: 'context', left: 'c', right: 'c' },
          { type: 'add', right: 'd' },
        ],
        2,
        'unstaged'
      );

      expect(result.applied).toBe(true);
      expect(result.hasRemainingChanges).toBe(true);
      expect(result.lines).toEqual([
        { type: 'context', left: 'a', right: 'a' },
        { type: 'context', left: 'c', right: 'c' },
        { type: 'add', right: 'd' },
      ]);
    });

    it('unstages a staged mixed block in place', () => {
      const result = applyBlockStageLocally(
        [
          { type: 'context', left: 'a', right: 'a' },
          { type: 'del', left: 'b' },
          { type: 'add', right: 'c' },
          { type: 'context', left: 'd', right: 'd' },
        ],
        2,
        'staged'
      );

      expect(result.applied).toBe(true);
      expect(result.hasRemainingChanges).toBe(false);
      expect(result.lines).toEqual([
        { type: 'context', left: 'a', right: 'a' },
        { type: 'context', left: 'b', right: 'b' },
        { type: 'context', left: 'd', right: 'd' },
      ]);
    });

    it('returns unapplied when line does not intersect any changed hunk', () => {
      const lines = [
        { type: 'context' as const, left: 'a', right: 'a' },
        { type: 'add' as const, right: 'b' },
      ];
      const result = applyBlockStageLocally(lines, 999, 'unstaged');
      expect(result.applied).toBe(false);
      expect(result.lines).toBe(lines);
      expect(result.hasRemainingChanges).toBe(true);
    });
  });
});
