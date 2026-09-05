import { describe, it, expect, vi } from 'vitest';
import {
  ApplicationCommandOptionType, ApplicationCommandType, ApplicationIntegrationType,
  InteractionContextType, Routes,
} from 'discord.js';
import { buildCommands, putCommands, VIA_GROUP } from '../../src/discord/registerCommands.ts';
import { features, COMMAND_GROUP_DESCRIPTIONS } from '../../src/features/registry.ts';
import type { Feature } from '../../src/features/registry.ts';

const EVERYWHERE = ['guild', 'botDm', 'privateChannel'] as const;

function feature(overrides: Partial<Feature>): Feature {
  return {
    id: 'events.list',
    description: 'List the events coming up.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'read',
    contexts: EVERYWHERE,
    command: { name: 'events', description: 'See what is coming up.' },
    ...overrides,
  };
}

describe('building the application commands from the registry', () => {
  it('puts every student command at the top level and everything else under the via group', () => {
    const commands = buildCommands(features);
    expect(commands.map(c => c.name).sort()).toEqual([
      'building', 'calendar', 'course', 'courses', 'event', 'events', 'feed', 'follow',
      'following', 'link', 'midterms', 'rooms', 'rso', 'unfollow', 'unlink', VIA_GROUP,
    ]);
    for (const command of commands) {
      expect(command.type).toBe(ApplicationCommandType.ChatInput);
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.description.length).toBeLessThanOrEqual(100);
    }
  });

  it('gives the courses group the add, remove and list subcommands', () => {
    // Discord does not answer the name of a group on its own, so reading the
    // courses back is a subcommand rather than the bare name.
    const group = buildCommands(features).find(c => c.name === 'courses')!;
    expect(group.options!.map(o => o.name)).toEqual(['add', 'remove', 'list']);
    for (const option of group.options!) {
      expect(option.type).toBe(ApplicationCommandOptionType.Subcommand);
      expect(option.options!.map(one => one.name)).toEqual(['course']);
    }
  });

  it('gives the via group the setup, config and remove subcommands', () => {
    const group = buildCommands(features).find(c => c.name === VIA_GROUP)!;
    expect(group.options!.map(o => o.name)).toEqual(['setup', 'config', 'remove']);
    for (const option of group.options!) {
      expect(option.type).toBe(ApplicationCommandOptionType.Subcommand);
    }
  });

  it('carries a subcommand\'s own options under it', () => {
    const group = buildCommands(features).find(c => c.name === VIA_GROUP)!;
    const setup = group.options!.find(o => o.name === 'setup')!;
    expect(setup.options!.map(o => o.name)).toEqual(['rso']);
    expect(setup.options![0]!.autocomplete).toBe(true);
  });

  it('builds the options of the events command as Discord describes them', () => {
    const events = buildCommands(features).find(c => c.name === 'events')!;
    expect(events.options!.map(o => o.name)).toEqual(['rso', 'window', 'internal']);

    const [rso, window, internal] = events.options!;
    expect(rso!.type).toBe(ApplicationCommandOptionType.String);
    expect(rso!.autocomplete).toBe(true);
    expect(rso!.required).toBe(false);

    expect(window!.choices!.map(c => c.value)).toEqual(['today', 'thisweek', 'nextweek', 'thismonth']);
    expect(window!.autocomplete).toBeUndefined();

    expect(internal!.type).toBe(ApplicationCommandOptionType.Boolean);
  });

  it('marks an option the command cannot run without as required', () => {
    const event = buildCommands(features).find(c => c.name === 'event')!;
    expect(event.options![0]!.name).toBe('event');
    expect(event.options![0]!.required).toBe(true);
  });

  it('opens a student command to both installation contexts and all three places', () => {
    const [link] = buildCommands(features).filter(c => c.name === 'link');
    expect(link!.integration_types).toEqual([
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall,
    ]);
    expect(link!.contexts).toEqual([
      InteractionContextType.Guild,
      InteractionContextType.BotDM,
      InteractionContextType.PrivateChannel,
    ]);
  });

  it('takes the places a command can be used from the contexts the feature declares', () => {
    const commands = buildCommands([feature({
      id: 'events.thisweek',
      contexts: ['guild'],
      command: { name: 'thisweek', description: 'See this week in this server.' },
    })]);
    expect(commands[0]!.contexts).toEqual([InteractionContextType.Guild]);
  });

  it('keeps a command that acts on a server out of the user installation context', () => {
    const commands = buildCommands([feature({
      id: 'admin.repost',
      tier: 'editor',
      contexts: ['guild'],
      command: { name: 'repost', description: 'Post the announcement for an event again.' },
    })]);
    expect(commands[0]!.integration_types).toEqual([ApplicationIntegrationType.GuildInstall]);
  });

  it('gathers everything for setup and for boards under one via group', () => {
    const commands = buildCommands([
      feature({ id: 'setup.run', tier: 'manager', contexts: ['guild'], command: { name: 'setup', description: 'Set the bot up in this server.' } }),
      feature({ id: 'admin.postpone', tier: 'editor', contexts: ['guild'], command: { name: 'postpone', description: 'Move an event to a new time.' } }),
      feature({ id: 'events.list', tier: 'read', contexts: EVERYWHERE, command: { name: 'events', description: 'See what is coming up.' } }),
    ]);
    expect(commands.map(c => c.name).sort()).toEqual(['events', VIA_GROUP]);

    const group = commands.find(c => c.name === VIA_GROUP)!;
    expect(group.options!.map(o => o.name).sort()).toEqual(['postpone', 'setup']);
    for (const option of group.options!) {
      expect(option.type).toBe(ApplicationCommandOptionType.Subcommand);
    }
    expect(group.integration_types).toEqual([ApplicationIntegrationType.GuildInstall]);
  });

  it('gathers the commands of a declared group under one command of that name', () => {
    const commands = buildCommands([
      feature({
        id: 'feed.digest',
        tier: 'linked',
        command: { group: 'feed', name: 'settings', description: 'Change what VIA sends you and when.' },
      }),
      feature({
        id: 'feed.reminders',
        tier: 'linked',
        command: { group: 'feed', name: 'reminders', description: 'See the events you asked to be reminded of.' },
      }),
      feature({ id: 'events.list', command: { name: 'events', description: 'See what is coming up.' } }),
    ]);

    expect(commands.map(c => c.name).sort()).toEqual(['events', 'feed']);
    const group = commands.find(c => c.name === 'feed')!;
    expect(group.description).toBe(COMMAND_GROUP_DESCRIPTIONS.feed);
    expect(group.options!.map(o => o.name)).toEqual(['settings', 'reminders']);
    for (const option of group.options!) {
      expect(option.type).toBe(ApplicationCommandOptionType.Subcommand);
    }
  });

  it('opens a declared group of student commands to both installation contexts', () => {
    const commands = buildCommands([feature({
      id: 'feed.digest',
      tier: 'linked',
      contexts: EVERYWHERE,
      command: { group: 'feed', name: 'settings', description: 'Change what VIA sends you and when.' },
    })]);
    expect(commands[0]!.integration_types).toEqual([
      ApplicationIntegrationType.GuildInstall,
      ApplicationIntegrationType.UserInstall,
    ]);
  });

  it('refuses a group it has no description for, rather than sending Discord an empty one', () => {
    expect(() => buildCommands([feature({
      id: 'feed.digest',
      tier: 'linked',
      command: { group: 'nonesuch', name: 'settings', description: 'Change what VIA sends you and when.' },
    })])).toThrow('There is no description for the command group nonesuch.');
  });

  it('leaves the via group out entirely while nothing sits under it', () => {
    const commands = buildCommands([feature({})]);
    expect(commands.map(c => c.name)).not.toContain(VIA_GROUP);
  });

  it('reaches one manager feature by both of its names', () => {
    const commands = buildCommands([feature({
      id: 'setup.configure',
      category: 'administration',
      tier: 'manager',
      contexts: ['guild'],
      command: {
        name: 'setup',
        description: 'Set the bot up in this server.',
        alternateNames: [{ name: 'config', description: 'Change how the bot is set up.' }],
      },
    })]);
    const group = commands.find(c => c.name === VIA_GROUP)!;
    expect(group.options!.map(o => o.name)).toEqual(['setup', 'config']);
    expect(group.options![1]!.description).toBe('Change how the bot is set up.');
  });

  it('reaches one student feature by both of its names, at the top level', () => {
    const commands = buildCommands([feature({
      command: {
        name: 'events',
        description: 'See what is coming up.',
        alternateNames: [{ name: 'upcoming', description: 'See what is coming up.' }],
      },
    })]);
    expect(commands.map(c => c.name)).toEqual(['events', 'upcoming']);
  });

  it('refuses an alternate name that is already another command', () => {
    expect(() => buildCommands([
      feature({ id: 'events.list', command: { name: 'events', description: 'See what is coming up.' } }),
      feature({
        id: 'rsos.detail',
        command: {
          name: 'rso',
          description: 'Show one organization.',
          alternateNames: [{ name: 'events', description: 'See what is coming up.' }],
        },
      }),
    ])).toThrow('There is more than one command named events.');
  });

  it('ignores a feature that declares no command, whatever its category', () => {
    const commands = buildCommands([
      feature({ id: 'events.announce', category: 'proactive', channelPurposes: ['announcements'], command: undefined }),
      feature({ id: 'roles.linked', category: 'roles', command: undefined }),
    ]);
    expect(commands).toEqual([]);
  });

  it('registers an administration feature that does declare a command', () => {
    const commands = buildCommands([feature({
      id: 'setup.remove',
      category: 'administration',
      tier: 'manager',
      contexts: ['guild'],
      command: { name: 'remove', description: 'Remove the bot from this server.' },
    })]);
    expect(commands.map(c => c.name)).toEqual([VIA_GROUP]);
    expect(commands[0]!.options!.map(o => o.name)).toEqual(['remove']);
  });

  it('refuses a command whose required option comes after an optional one', () => {
    expect(() => buildCommands([feature({
      command: {
        name: 'events',
        description: 'See what is coming up.',
        options: [
          { name: 'window', description: 'How far ahead to look.', kind: 'string' },
          { name: 'rso', description: 'One organization.', kind: 'string', required: true },
        ],
      },
    })])).toThrow('The command events has a required option after an optional one, which Discord refuses.');
  });

  it('refuses two commands with the same name, because Discord would take only one', () => {
    expect(() => buildCommands([
      feature({ id: 'events.list', command: { name: 'events', description: 'See what is coming up.' } }),
      feature({ id: 'events.mine', command: { name: 'events', description: 'See what you follow.' } }),
    ])).toThrow('There is more than one command named events.');
  });
});

describe('putting the commands to Discord', () => {
  it('replaces the global command list in one call', async () => {
    const rest = { put: vi.fn(async () => []), setToken: vi.fn(() => rest) };
    const commands = buildCommands(features);
    await putCommands({ rest: rest as never, applicationId: '123456789012345678', commands });
    expect(rest.put).toHaveBeenCalledWith(
      Routes.applicationCommands('123456789012345678'),
      { body: commands },
    );
  });

  it('answers with how many commands it put, so startup can say so', async () => {
    const rest = { put: vi.fn(async () => []), setToken: vi.fn(() => rest) };
    const count = await putCommands({
      rest: rest as never,
      applicationId: '123456789012345678',
      commands: buildCommands(features),
    });
    expect(count).toBe(16);
  });
});
