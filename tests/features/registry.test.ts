import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findViolations } from '../../scripts/check-language.js';
import { features, featureById, CHANNEL_PURPOSES } from '../../src/features/registry.ts';

describe('the feature registry', () => {
  it('registers the two identity features and nothing else yet', () => {
    expect(features.map(f => f.id).sort()).toEqual(['identity.link', 'identity.unlink']);
  });

  it('gives every feature a unique identifier', () => {
    const ids = features.map(f => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names identifiers as a category and a feature separated by a dot', () => {
    for (const feature of features) {
      expect(feature.id).toMatch(/^[a-z]+\.[a-z]+$/);
    }
  });

  it('gives every feature a description that passes the language check', async () => {
    // A server manager reads these descriptions in the setup panel, so they are
    // user facing copy and the repository's language rule applies. The check
    // reads files, so the descriptions are written to one and checked as such.
    const dir = await mkdtemp(join(tmpdir(), 'via-bot-registry-'));
    try {
      const path = join(dir, 'descriptions.txt');
      await writeFile(path, features.map(f => f.description).join('\n') + '\n');
      expect(findViolations([path])).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('writes every description as at least one complete sentence', () => {
    for (const feature of features) {
      expect(feature.description.trim()).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('names a channel purpose on every proactive feature', () => {
    for (const feature of features.filter(f => f.category === 'proactive')) {
      expect(feature.channelPurposes.length).toBeGreaterThan(0);
      for (const purpose of feature.channelPurposes) {
        expect(CHANNEL_PURPOSES).toContain(purpose);
      }
    }
  });

  it('names no channel purpose on a feature that does not post', () => {
    for (const feature of features.filter(f => f.category === 'command')) {
      expect(feature.channelPurposes).toEqual([]);
    }
  });

  it('makes every feature usable in at least one context', () => {
    for (const feature of features) {
      expect(feature.contexts.length).toBeGreaterThan(0);
    }
  });

  it('keeps the identity features on by default and available everywhere', () => {
    for (const id of ['identity.link', 'identity.unlink']) {
      const feature = featureById(id);
      expect(feature.category).toBe('command');
      expect(feature.defaultEnabled).toBe(true);
      expect(feature.requiredPermissions).toEqual([]);
      expect([...feature.contexts].sort()).toEqual(['botDm', 'guild', 'privateChannel']);
    }
  });

  it('requires only a Discord account to link and a link to unlink', () => {
    expect(featureById('identity.link').tier).toBe('read');
    expect(featureById('identity.unlink').tier).toBe('linked');
  });

  it('throws a sentence naming an unknown identifier', () => {
    expect(() => featureById('events.list')).toThrow('There is no feature with the identifier events.list.');
  });

  it('lists the five channel purposes the design names', () => {
    expect([...CHANNEL_PURPOSES].sort()).toEqual(['announcements', 'digest', 'exams', 'reminders', 'thisweek']);
  });
});
