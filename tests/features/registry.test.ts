import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findViolations } from '../../scripts/check-language.js';
import {
  features, featureById, CHANNEL_PURPOSES, COMMAND_GROUP_DESCRIPTIONS,
} from '../../src/features/registry.ts';

describe('the feature registry', () => {
  it('registers the identity, reading, setup, feed, campus and proactive features the first four increments have', () => {
    expect(features.map(f => f.id).sort()).toEqual([
      'announce.changes',
      'announce.dayof',
      'announce.digest',
      'announce.exams',
      'announce.new',
      'campus.building',
      'campus.course',
      'campus.rooms',
      'events.detail',
      'events.list',
      'feed.calendar',
      'feed.courses',
      'feed.digest',
      'feed.follow',
      'feed.reminders',
      'identity.link',
      'identity.unlink',
      'living.thisweek',
      'midterms.lookup',
      'mirror.scheduled',
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

  it('names a channel purpose on every proactive feature that posts in a channel', () => {
    // The scheduled event mirror is the one proactive feature that posts
    // nowhere in the server's channels: it writes into the server's own
    // Events tab, which is not a channel a manager can bind.
    for (const feature of features.filter(f => f.category === 'proactive' && f.id !== 'mirror.scheduled')) {
      expect(feature.channelPurposes.length).toBeGreaterThan(0);
      for (const purpose of feature.channelPurposes) {
        expect(CHANNEL_PURPOSES).toContain(purpose);
      }
    }
  });

  it('posts announcements in the announcements channel and needs the two permissions that takes', () => {
    for (const id of ['announce.new', 'announce.changes']) {
      const feature = featureById(id);
      expect(feature.category).toBe('proactive');
      expect([...feature.channelPurposes]).toEqual(['announcements']);
      expect([...feature.requiredPermissions].sort()).toEqual(['SendMessages', 'ViewChannel']);
      expect([...feature.contexts]).toEqual(['guild']);
      expect(feature.command).toBeUndefined();
    }
  });

  it('mirrors scheduled events into the Events tab, which needs the Manage Events permission', () => {
    const feature = featureById('mirror.scheduled');
    expect(feature.category).toBe('proactive');
    expect([...feature.channelPurposes]).toEqual([]);
    expect([...feature.requiredPermissions]).toEqual(['ManageEvents']);
    expect([...feature.contexts]).toEqual(['guild']);
  });

  it('leaves every proactive feature off until a server switches it on', () => {
    // Section 2 of the design: nothing proactive happens in a server until
    // that server has set it up and asked for it.
    for (const feature of features.filter(f => f.category === 'proactive')) {
      expect(feature.defaultEnabled).toBe(false);
      expect(feature.tier).toBe('manager');
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

  it('puts the personal feed behind a link, and lets it be used everywhere', () => {
    for (const id of ['feed.follow', 'feed.digest', 'feed.reminders', 'feed.calendar']) {
      const feature = featureById(id);
      expect(feature.category).toBe('command');
      expect(feature.tier).toBe('linked');
      expect(feature.defaultEnabled).toBe(true);
      expect(feature.requiredPermissions).toEqual([]);
      expect([...feature.contexts].sort()).toEqual(['botDm', 'guild', 'privateChannel']);
      expect(feature.command).toBeDefined();
    }
  });

  it('reaches following, unfollowing and the list of what is followed by three names', () => {
    const command = featureById('feed.follow').command!;
    expect(command.name).toBe('follow');
    expect(command.alternateNames!.map(alternate => alternate.name)).toEqual(['unfollow', 'following']);
    expect(command.options!.map(option => option.name)).toEqual(['rso']);
    expect(command.options![0]!.autocomplete).toBe(true);
  });

  it('gathers the two settings commands under the feed group', () => {
    expect(featureById('feed.digest').command).toMatchObject({ group: 'feed', name: 'settings' });
    expect(featureById('feed.reminders').command).toMatchObject({ group: 'feed', name: 'reminders' });
  });

  it('describes every command group it names', () => {
    for (const feature of features) {
      const group = feature.command?.group;
      if (!group) continue;
      expect(COMMAND_GROUP_DESCRIPTIONS[group]!.length).toBeGreaterThan(0);
    }
  });

  it('posts the weekly digest, the day of reminders and the living message in the channels bound to them', () => {
    const purposes: Record<string, string> = {
      'announce.digest': 'digest',
      'announce.dayof': 'reminders',
      'living.thisweek': 'thisweek',
    };
    for (const [id, purpose] of Object.entries(purposes)) {
      const feature = featureById(id);
      expect(feature.category).toBe('proactive');
      expect([...feature.channelPurposes]).toEqual([purpose]);
      expect([...feature.contexts]).toEqual(['guild']);
      expect(feature.command).toBeUndefined();
      expect(feature.requiredPermissions).toContain('ViewChannel');
      expect(feature.requiredPermissions).toContain('SendMessages');
    }
  });

  it('needs the permission to pin for the message it keeps pinned', () => {
    expect(featureById('living.thisweek').requiredPermissions).toContain('ManageMessages');
  });

  it('lets anybody look up an exam, a free room, a course and a building, in every context', () => {
    for (const id of ['midterms.lookup', 'campus.rooms', 'campus.course', 'campus.building']) {
      const feature = featureById(id);
      expect(feature.category).toBe('command');
      expect(feature.tier).toBe('read');
      expect(feature.defaultEnabled).toBe(true);
      expect(feature.requiredPermissions).toEqual([]);
      expect([...feature.contexts].sort()).toEqual(['botDm', 'guild', 'privateChannel']);
      expect(feature.command).toBeDefined();
    }
  });

  it('completes the course on the exam lookup and the building on the free room search', () => {
    const midterms = featureById('midterms.lookup').command!;
    expect(midterms.name).toBe('midterms');
    expect(midterms.options![0]).toMatchObject({ name: 'course', required: true, autocomplete: true });

    const rooms = featureById('campus.rooms').command!;
    expect(rooms.name).toBe('rooms');
    expect(rooms.options![0]).toMatchObject({ name: 'building', required: true, autocomplete: true });
    // The window is a date and two hours, and a command run with none of them
    // is the next hour, which is what somebody looking for a room now means.
    expect(rooms.options!.map(option => option.name)).toEqual(['building', 'date', 'from', 'to']);
  });

  it('puts the courses somebody added behind a link, under a group of their own', () => {
    const feature = featureById('feed.courses');
    expect(feature.category).toBe('command');
    expect(feature.tier).toBe('linked');
    expect([...feature.contexts].sort()).toEqual(['botDm', 'guild', 'privateChannel']);
    expect(feature.command).toMatchObject({ group: 'courses', name: 'add' });
    expect(feature.command!.alternateNames!.map(alternate => alternate.name)).toEqual(['remove', 'list']);
    expect(feature.command!.options![0]).toMatchObject({ name: 'course', autocomplete: true });
  });

  it('posts the exams of the week in the channel bound to exam notices', () => {
    const feature = featureById('announce.exams');
    expect(feature.category).toBe('proactive');
    expect([...feature.channelPurposes]).toEqual(['exams']);
    expect([...feature.contexts]).toEqual(['guild']);
    expect(feature.command).toBeUndefined();
    expect([...feature.requiredPermissions].sort()).toEqual(['SendMessages', 'ViewChannel']);
  });

  it('lists the five channel purposes the design names', () => {
    expect([...CHANNEL_PURPOSES].sort()).toEqual(['announcements', 'digest', 'exams', 'reminders', 'thisweek']);
  });
});
