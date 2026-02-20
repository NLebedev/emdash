type FileWithPath = File & { path?: string };

const dedupePaths = (paths: string[]) => {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const path of paths) {
    if (!path || seen.has(path)) continue;
    seen.add(path);
    unique.push(path);
  }
  return unique;
};

const toLocalPathFromFileUrl = (value: string): string | null => {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return null;
    let pathname = decodeURIComponent(url.pathname || '');
    // Windows file URLs are typically /C:/...
    if (/^\/[a-zA-Z]:\//.test(pathname)) {
      pathname = pathname.slice(1);
    }
    return pathname || null;
  } catch {
    return null;
  }
};

const extractPathsFromTransferText = (
  dataTransfer: Pick<DataTransfer, 'getData'> | null | undefined
): string[] => {
  if (!dataTransfer?.getData) return [];

  const rawUriList = dataTransfer.getData('text/uri-list') || '';
  const rawText = dataTransfer.getData('text/plain') || '';
  const lines = `${rawUriList}\n${rawText}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => Boolean(line) && !line.startsWith('#'));

  const paths: string[] = [];
  for (const line of lines) {
    if (line.startsWith('file://')) {
      const parsed = toLocalPathFromFileUrl(line);
      if (parsed) paths.push(parsed);
      continue;
    }

    if (line.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(line)) {
      paths.push(line);
    }
  }

  return paths;
};

export const hasFilesInDataTransfer = (
  dataTransfer: Pick<DataTransfer, 'types' | 'files'> | null | undefined
): boolean => {
  if (!dataTransfer) return false;

  try {
    if (dataTransfer.files && dataTransfer.files.length > 0) return true;
  } catch {
    // Ignore.
  }

  try {
    const types = Array.from(dataTransfer.types || []);
    return types.includes('Files');
  } catch {
    return false;
  }
};

export const resolveDroppedFilePath = (
  file: FileWithPath,
  resolver?: (file: File) => string | null | undefined
): string | null => {
  const directPath = typeof file.path === 'string' ? file.path : '';
  if (directPath) return directPath;

  if (!resolver) return null;

  try {
    const resolvedPath = resolver(file);
    if (typeof resolvedPath === 'string' && resolvedPath) {
      return resolvedPath;
    }
  } catch {
    // Ignore resolver errors.
  }

  return null;
};

export const extractDroppedFilePaths = (
  dataTransfer: Pick<DataTransfer, 'files' | 'getData'> | null | undefined,
  resolver?: (file: File) => string | null | undefined
): string[] => {
  if (!dataTransfer) return [];

  const fromFiles: string[] = [];
  if (dataTransfer.files && dataTransfer.files.length > 0) {
    for (let index = 0; index < dataTransfer.files.length; index += 1) {
      const file = dataTransfer.files[index] as FileWithPath;
      const path = resolveDroppedFilePath(file, resolver);
      if (path) {
        fromFiles.push(path);
      }
    }
  }

  const fromText = extractPathsFromTransferText(dataTransfer);
  return dedupePaths([...fromFiles, ...fromText]);
};
