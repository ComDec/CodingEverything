import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { assertPathWithinRoots } from '../shared/security.js';
import type { WorkdirRecord } from '../shared/db/repositories.js';

const NOISY_DIRECTORY_NAMES = new Set(['.git', 'node_modules', 'dist', 'build', 'coverage']);
const PROJECT_MARKERS = ['.git', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'] as const;

export type WorkdirScanCandidate = Readonly<{
  path: string;
  displayName: string;
  score: number;
}>;

export type WorkdirCatalog = Readonly<{
  listSavedWorkdirs: () => WorkdirRecord[];
  scanWorkdirs: (input: { offset?: number; limit?: number }) => Promise<{
    items: WorkdirScanCandidate[];
    nextOffset: number | null;
  }>;
  saveWorkdir: (input: {
    path: string;
    displayName?: string;
    createdBy: string;
  }) => Promise<WorkdirRecord>;
}>;

export function createWorkdirCatalog(input: {
  repositories: {
    workdirs: {
      listRecent: () => WorkdirRecord[];
      getById: (id: string) => WorkdirRecord | null;
      upsert: (record: WorkdirRecord) => void;
      markUsed: (input: { id: string; lastUsedAt: string; updatedAt: string }) => void;
      getByPath: (path: string) => WorkdirRecord | null;
    };
  };
  allowedRoots: readonly string[];
  now: () => string;
  createId: (prefix: string) => string;
}): WorkdirCatalog {
  const allowedRoots = input.allowedRoots.map((root) => resolve(root));

  return {
    listSavedWorkdirs() {
      return input.repositories.workdirs.listRecent();
    },
    async scanWorkdirs(scanInput) {
      const offset = Math.max(0, scanInput.offset ?? 0);
      const limit = Math.max(1, scanInput.limit ?? 25);
      const savedPaths = new Set(
        input.repositories.workdirs.listRecent().map((record) => resolve(record.path))
      );
      const candidates = await Promise.all(
        (await collectCandidates(allowedRoots)).map(async (candidate) => ({
          candidate,
          normalizedPath: await realpath(candidate.path).catch(() => resolve(candidate.path))
        }))
      );
      const visibleCandidates = candidates
        .filter(({ normalizedPath }) => !savedPaths.has(normalizedPath))
        .map(({ candidate }) => candidate);
      const items = visibleCandidates.slice(offset, offset + limit);
      const nextOffset = offset + limit < visibleCandidates.length ? offset + limit : null;

      return { items, nextOffset };
    },
    async saveWorkdir(saveInput) {
      const requestedPath = resolve(saveInput.path);
      const details = await stat(requestedPath).catch(() => null);

      if (!details) {
        throw new Error(`workdir path does not exist: ${requestedPath}`);
      }

      if (!details.isDirectory()) {
        throw new Error(`workdir path is not a directory: ${requestedPath}`);
      }

      const path = await realpath(requestedPath);
      const realAllowedRoots = await Promise.all(
        allowedRoots.map(async (root) => await realpath(root).catch(() => root))
      );
      assertPathWithinRoots(path, realAllowedRoots);

      const timestamp = input.now();
      const existing = input.repositories.workdirs.getByPath(path);
      const displayNameOverride = saveInput.displayName?.trim();

      if (existing) {
        if (displayNameOverride) {
          input.repositories.workdirs.upsert({
            ...existing,
            displayName: displayNameOverride,
            updatedAt: timestamp,
            lastUsedAt: timestamp,
            useCount: existing.useCount + 1,
          });
        } else {
          input.repositories.workdirs.markUsed({
            id: existing.id,
            updatedAt: timestamp,
            lastUsedAt: timestamp,
          });
        }

        const savedExisting = input.repositories.workdirs.getById(existing.id);
        if (!savedExisting) {
          throw new Error(`failed to load saved workdir ${path}`);
        }

        return savedExisting;
      }

      input.repositories.workdirs.upsert({
        id: input.createId('workdir'),
        path,
        displayName: displayNameOverride || basename(path),
        source: 'scan',
        createdBy: saveInput.createdBy,
        createdAt: timestamp,
        updatedAt: timestamp,
        lastUsedAt: timestamp,
        useCount: 1,
      });

      const saved = input.repositories.workdirs.getByPath(path);
      if (!saved) {
        throw new Error(`failed to load saved workdir ${path}`);
      }

      return saved;
    },
  };
}

async function collectCandidates(allowedRoots: readonly string[]): Promise<WorkdirScanCandidate[]> {
  const candidates = new Map<string, WorkdirScanCandidate>();

  for (const root of [...allowedRoots].sort()) {
    await walkDirectory(root, candidates);
  }

  return [...candidates.values()].sort((left, right) => {
    if (left.score !== right.score) {
      return right.score - left.score;
    }

    return left.path.localeCompare(right.path);
  });
}

async function walkDirectory(
  directoryPath: string,
  candidates: Map<string, WorkdirScanCandidate>
): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch(() => null);
  if (!entries) {
    return;
  }

  const score = getCandidateScore(entries);
  if (score > 0) {
    candidates.set(directoryPath, {
      path: directoryPath,
      displayName: basename(directoryPath),
      score,
    });
  }

  const childDirectories = entries
    .filter((entry) => entry.isDirectory() && !NOISY_DIRECTORY_NAMES.has(entry.name))
    .map((entry) => resolve(directoryPath, entry.name))
    .sort((left, right) => left.localeCompare(right));

  for (const childDirectory of childDirectories) {
    await walkDirectory(childDirectory, candidates);
  }
}

function getCandidateScore(
  entries: readonly { name: string; isDirectory: () => boolean; isFile: () => boolean }[]
): number {
  let score = 0;

  for (const marker of PROJECT_MARKERS) {
    const entry = entries.find((value) => value.name === marker);
    if (!entry) {
      continue;
    }

    if (marker === '.git' && entry.isDirectory()) {
      score = Math.max(score, 2);
      continue;
    }

    if (marker !== '.git' && entry.isFile()) {
      score = Math.max(score, 1);
    }
  }

  return score;
}
