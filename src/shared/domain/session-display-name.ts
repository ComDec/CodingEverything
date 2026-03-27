export const MAX_SESSION_DISPLAY_NAME_LENGTH = 100;

export function normalizeSessionDisplayName(rawName?: string | null): string | null {
  if (!rawName) {
    return null;
  }

  const normalized = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SESSION_DISPLAY_NAME_LENGTH)
    .replace(/-+$/g, '');

  return normalized.length > 0 ? normalized : null;
}
