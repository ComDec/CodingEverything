import { homedir } from 'node:os';
import { resolve } from 'node:path';

export function assertPathWithinRoots(path: string, allowedRoots: string[]): string {
  const resolvedPath = resolveUserPath(path);

  for (const root of allowedRoots) {
    const resolvedRoot = resolveUserPath(root);
    if (resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`)) {
      return resolvedPath;
    }
  }

  throw new Error('Path is outside the allowed roots.');
}

export function isPromptExpired(expiresAt: string, now: string | Date): boolean {
  const nowValue = typeof now === 'string' ? new Date(now) : now;
  return nowValue.getTime() >= new Date(expiresAt).getTime();
}

export function resolveAllowedRoot(path: string, allowedRoots: string[]): string {
  const resolvedPath = assertPathWithinRoots(path, allowedRoots);
  const matches = allowedRoots
    .map((root) => resolveUserPath(root))
    .filter((resolvedRoot) => {
      return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}/`);
    })
    .sort((left, right) => right.length - left.length);

  const matchedRoot = matches[0];
  if (!matchedRoot) {
    throw new Error('Path is outside the allowed roots.');
  }

  return matchedRoot;
}

function resolveUserPath(path: string): string {
  if (path === '~') {
    return homedir();
  }

  if (path.startsWith('~/')) {
    return resolve(homedir(), path.slice(2));
  }

  return resolve(path);
}

export function canManageSessions(input: {
  userId: string;
  roles: string[];
  allowedUserIds: readonly string[];
  allowedRoleIds: readonly string[];
}): boolean {
  if (input.allowedUserIds.includes(input.userId)) {
    return true;
  }

  return input.roles.some((role) => input.allowedRoleIds.includes(role));
}
