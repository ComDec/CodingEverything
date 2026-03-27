import {
  normalizeSessionDisplayName as normalizeSharedSessionDisplayName,
} from '../shared/domain/session-display-name.js';

const ADJECTIVES = [
  'pretty',
  'brisk',
  'steady',
  'bright',
  'calm',
  'clever',
  'lively',
  'silver',
] as const;
const NOUNS = [
  'fire',
  'river',
  'cloud',
  'field',
  'forest',
  'meadow',
  'ember',
  'harbor',
] as const;

export function normalizeSessionDisplayName(rawName?: string | null): string | null {
  return normalizeSharedSessionDisplayName(rawName);
}

export function generateSessionDisplayName(random: () => number = Math.random): string {
  const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)] ?? ADJECTIVES[0];
  const noun = NOUNS[Math.floor(random() * NOUNS.length)] ?? NOUNS[0];

  return `${adjective}-${noun}`;
}

export function resolveSessionDisplayName(input: {
  rawName?: string | null;
  random?: () => number;
}): string {
  return normalizeSessionDisplayName(input.rawName) ?? generateSessionDisplayName(input.random);
}
