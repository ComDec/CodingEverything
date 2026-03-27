import { describe, expect, it, vi } from 'vitest';
import {
  generateSessionDisplayName,
  normalizeSessionDisplayName,
  resolveSessionDisplayName,
} from '../../src/discord-control/session-display-name.js';

describe('normalizeSessionDisplayName', () => {
  it('normalizes mixed separators into kebab-case', () => {
    expect(normalizeSessionDisplayName('  Pretty   Fire_room  ')).toBe('pretty-fire-room');
  });

  it('returns null when normalization removes all content', () => {
    expect(normalizeSessionDisplayName('---___   ')).toBeNull();
  });

  it('truncates long names to a Discord-safe length', () => {
    expect(normalizeSessionDisplayName('A'.repeat(150))?.length).toBeLessThanOrEqual(100);
  });
});

describe('resolveSessionDisplayName', () => {
  it('uses the normalized explicit name when present', () => {
    expect(resolveSessionDisplayName({ rawName: 'Deploy War Room' })).toBe('deploy-war-room');
  });

  it('falls back to the generator when the name is missing or blank', () => {
    const random = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);

    expect(resolveSessionDisplayName({ rawName: '   ', random })).toBe('pretty-fire');
  });
});

describe('generateSessionDisplayName', () => {
  it('builds an adjective-noun slug', () => {
    const random = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0);

    expect(generateSessionDisplayName(random)).toBe('pretty-fire');
  });

  it('supports enough combinations to avoid repetitive generated names', () => {
    const generatedNames = new Set<string>();

    for (let adjectiveIndex = 0; adjectiveIndex < 8; adjectiveIndex += 1) {
      for (let nounIndex = 0; nounIndex < 8; nounIndex += 1) {
        const random = vi.fn()
          .mockReturnValueOnce((adjectiveIndex + 0.01) / 8)
          .mockReturnValueOnce((nounIndex + 0.01) / 8);

        generatedNames.add(generateSessionDisplayName(random));
      }
    }

    expect(generatedNames.size).toBe(64);
  });
});
