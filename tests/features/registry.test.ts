import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findViolations } from '../../scripts/check-language.js';
import { features, featureById, CHANNEL_PURPOSES } from '../../src/features/registry.ts';

describe('the feature registry', () => {
  it('registers the identity, reading and setup features the first two increments have', () => {
    expect(features.map(f => f.id).sort()).toEqual([
      'events.detail',
      'events.list',
      'identity.link',
      'identity.unlink',
      'rsos.detail',
      'setup.configure',
      'setup.remove',
    ]);
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
    expect(() => featureById('events.nonesuch')).toThrow('There is no feature with the identifier events.nonesuch.');
  });

  it('lets anybody read events and organizations, in every context', () => {
    for (const id of ['events.list', 'events.detail', 'rsos.detail']) {
      const feature = featureById(id);
      expect(feature.category).toBe('command');
      expect(feature.tier).toBe('read');
      expect(feature.defaultEnabled).toBe(true);
      expect([...feature.contexts].sort()).toEqual(['botDm', 'guild', 'privateChannel']);
    }
  });

  it('keeps setup and removal to a server manager, in a server', () => {
    for (const id of ['setup.configure', 'setup.remove']) {
      const feature = featureById(id);
      expect(feature.category).toBe('administration');
      expect(feature.tier).toBe('manager');
      expect(feature.defaultEnabled).toBe(true);
      expect([...feature.contexts]).toEqual(['guild']);
      // Manage Server is what the person needs, which the manager tier says.
      // The bot needs no permission of its own to answer a setup panel.
      expect(feature.requiredPermissions).toEqual([]);
    }
  });

  it('reaches configuration by both the setup name and the config name', () => {
    const command = featureById('setup.configure').command!;
    expect(command.name).toBe('setup');
    expect(command.alternateNames!.map(alternate => alternate.name)).toEqual(['config']);
  });

  it('names every command and option in the lower case Discord requires', () => {
    for (const feature of features) {
      if (!feature.command) continue;
      const names = [feature.command.name, ...(feature.command.alternateNames ?? []).map(a => a.name)];
      for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
      for (const option of feature.command.options ?? []) {
        expect(option.name).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
        expect(option.description.length).toBeGreaterThan(0);
        expect(option.description.length).toBeLessThanOrEqual(100);
      }
    }
  });

  it('never asks Discord both to complete an option and to offer it fixed choices', () => {
    for (const feature of features) {
      for (const option of feature.command?.options ?? []) {
        expect(Boolean(option.autocomplete) && Boolean(option.choices)).toBe(false);
      }
    }
  });

  it('offers the four windows the design names on the events command', () => {
    const window = featureById('events.list').command!.options!.find(o => o.name === 'window')!;
    expect(window.choices!.map(choice => choice.value))
      .toEqual(['today', 'thisweek', 'nextweek', 'thismonth']);
  });

  it('gives every command description and option description to the language check', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'via-bot-commands-'));
    try {
      const path = join(dir, 'commands.txt');
      const lines: string[] = [];
      for (const feature of features) {
        if (!feature.command) continue;
        lines.push(feature.command.description);
        for (const alternate of feature.command.alternateNames ?? []) lines.push(alternate.description);
        for (const option of feature.command.options ?? []) {
          lines.push(option.description);
          for (const choice of option.choices ?? []) lines.push(choice.name);
        }
      }
      await writeFile(path, lines.join('\n') + '\n');
      expect(findViolations([path])).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('lists the five channel purposes the design names', () => {
    expect([...CHANNEL_PURPOSES].sort()).toEqual(['announcements', 'digest', 'exams', 'reminders', 'thisweek']);
  });
});
