import { describe, expect, it } from 'vitest';
import {
  extractDroppedFilePaths,
  hasFilesInDataTransfer,
  resolveDroppedFilePath,
} from '../../renderer/lib/dndFilePaths';

type MockFile = File & { path?: string };

const makeFileList = (files: MockFile[]): FileList => {
  const list: any = {
    length: files.length,
    item: (index: number) => files[index] ?? null,
  };
  files.forEach((file, index) => {
    list[index] = file;
  });
  return list as FileList;
};

const makeDataTransfer = (args: {
  files?: MockFile[];
  types?: string[];
  textUriList?: string;
  textPlain?: string;
}): DataTransfer => {
  const files = makeFileList(args.files || []);
  const uriList = args.textUriList || '';
  const plain = args.textPlain || '';
  return {
    files,
    types: args.types || [],
    getData: (type: string) => {
      if (type === 'text/uri-list') return uriList;
      if (type === 'text/plain') return plain;
      return '';
    },
  } as unknown as DataTransfer;
};

describe('dndFilePaths', () => {
  it('detects file drag via dataTransfer types even before files are populated', () => {
    const dataTransfer = makeDataTransfer({ types: ['Files'] });

    expect(hasFilesInDataTransfer(dataTransfer)).toBe(true);
  });

  it('resolves direct file.path when present', () => {
    const file = { name: 'a.png', path: '/tmp/a.png' } as MockFile;
    expect(resolveDroppedFilePath(file)).toBe('/tmp/a.png');
  });

  it('falls back to resolver when file.path is unavailable', () => {
    const file = { name: 'b.png' } as MockFile;
    const resolved = resolveDroppedFilePath(file, () => '/tmp/b.png');
    expect(resolved).toBe('/tmp/b.png');
  });

  it('extracts paths with mixed direct and resolver-based files', () => {
    const direct = { name: 'direct.png', path: '/tmp/direct.png' } as MockFile;
    const viaResolver = { name: 'resolver.png' } as MockFile;
    const missing = { name: 'missing.png' } as MockFile;
    const dataTransfer = makeDataTransfer({ files: [direct, viaResolver, missing] });

    const paths = extractDroppedFilePaths(dataTransfer, (file) =>
      file === viaResolver ? '/tmp/resolver.png' : null
    );

    expect(paths).toEqual(['/tmp/direct.png', '/tmp/resolver.png']);
  });

  it('falls back to file:// uri-list when file objects expose no path', () => {
    const dataTransfer = makeDataTransfer({
      files: [{ name: 'image.png' } as MockFile],
      textUriList: 'file:///Users/test/Desktop/image.png',
    });

    const paths = extractDroppedFilePaths(dataTransfer);
    expect(paths).toEqual(['/Users/test/Desktop/image.png']);
  });

  it('extracts file:// uri-list when files list is empty', () => {
    const dataTransfer = makeDataTransfer({
      files: [],
      types: ['Files'],
      textUriList: 'file:///Users/test/Desktop/empty-files-list.png',
    });

    const paths = extractDroppedFilePaths(dataTransfer);
    expect(paths).toEqual(['/Users/test/Desktop/empty-files-list.png']);
  });
});
