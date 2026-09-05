import { describe, it, expect, vi } from 'vitest';
import {
  ApplicationCommandOptionType, ApplicationCommandType, ApplicationIntegrationType,
  InteractionContextType, Routes,
} from 'discord.js';
import { buildCommands, putCommands, VIA_GROUP } from '../../src/discord/registerCommands.ts';
import { features } from '../../src/features/registry.ts';
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
  it('registers the two identity commands the first increment has, at the top level', () => {
    const commands = buildCommands(features);
    expect(commands.map(c => c.name).sort()).toEqual(['link', 'unlink']);
    for (const command of commands) {
      expect(command.type).toBe(ApplicationCommandType.ChatInput);
      expect(command.description.length).toBeGreaterThan(0);
      expect(command.description.length).toBeLessThanOrEqual(100);
    }
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

  it('leaves the via group out entirely while nothing sits under it', () => {
    expect(buildCommands(features).map(c => c.name)).not.toContain(VIA_GROUP);
  });

  it('ignores a feature that is not a command and a command feature with no command declared', () => {
    const commands = buildCommands([
      feature({ id: 'events.announce', category: 'proactive', channelPurposes: ['announcements'], command: undefined }),
      feature({ id: 'roles.linked', category: 'roles', command: undefined }),
    ]);
    expect(commands).toEqual([]);
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
    expect(count).toBe(2);
  });
});
