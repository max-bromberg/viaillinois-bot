import { describe, it, expect, vi } from 'vitest';
import {
  ApplicationCommandOptionType, ChannelType, ComponentType, InteractionContextType, InteractionType,
  MessageFlags, PermissionFlagsBits,
} from 'discord.js';
import {
  toInteraction, toComponents, toFiles, applyReply, applyUpdate, respond, respondByUpdate,
  answerAutocomplete, hasPermission,
} from '../../src/discord/adapter.ts';
import type { Reply } from '../../src/discord/adapter.ts';

/**
 * The adapter is the seam that keeps discord.js out of every command. These
 * tests build interaction shaped plain objects by hand, in the shape the
 * library hands over, and assert on both directions: what a command receives,
 * and what the library is asked to do with what a command answered.
 */

function chatCommand(overrides: Record<string, unknown> = {}) {
  return {
    id: '111111111111111111',
    type: InteractionType.ApplicationCommand,
    commandName: 'link',
    user: { id: '204255221017214977' },
    guildId: '900000000000000001',
    channelId: '900000000000000002',
    context: InteractionContextType.Guild,
    options: { data: [] as unknown[] },
    ...overrides,
  };
}

describe('reading an interaction', () => {
  it('reads a chat command into a plain object', () => {
    const interaction = toInteraction(chatCommand() as never);
    expect(interaction).toEqual({
      kind: 'chatCommand',
      id: '111111111111111111',
      commandName: 'link',
      options: {},
      customId: null,
      values: [],
      fields: {},
      focusedOption: null,
      userId: '204255221017214977',
      guildId: '900000000000000001',
      channelId: '900000000000000002',
      context: 'guild',
      memberPermissions: [],
      applicationPermissions: [],
    });
  });

  it('reads the options of a chat command by name', () => {
    const raw = chatCommand({
      commandName: 'events',
      options: {
        data: [
          { name: 'rso', type: ApplicationCommandOptionType.Integer, value: 4 },
          { name: 'query', type: ApplicationCommandOptionType.String, value: 'seminar' },
          { name: 'internal', type: ApplicationCommandOptionType.Boolean, value: false },
        ],
      },
    });
    expect(toInteraction(raw as never).options).toEqual({ rso: 4, query: 'seminar', internal: false });
  });

  it('names a subcommand group and a subcommand as part of the command name', () => {
    const raw = chatCommand({
      commandName: 'via',
      options: {
        data: [{
          name: 'setup',
          type: ApplicationCommandOptionType.Subcommand,
          options: [{ name: 'kind', type: ApplicationCommandOptionType.String, value: 'rso' }],
        }],
      },
    });
    const interaction = toInteraction(raw as never);
    expect(interaction.commandName).toBe('via setup');
    expect(interaction.options).toEqual({ kind: 'rso' });
  });

  it('reads a button by the identifier it was built with', () => {
    const raw = {
      id: '111111111111111111',
      type: InteractionType.MessageComponent,
      componentType: ComponentType.Button,
      customId: 'interest:41',
      user: { id: '204255221017214977' },
      guildId: '900000000000000001',
      channelId: '900000000000000002',
      context: InteractionContextType.Guild,
    };
    const interaction = toInteraction(raw as never);
    expect(interaction.kind).toBe('button');
    expect(interaction.customId).toBe('interest:41');
  });

  it('reads a select menu with the values that were chosen', () => {
    const raw = {
      id: '111111111111111111',
      type: InteractionType.MessageComponent,
      componentType: ComponentType.StringSelect,
      customId: 'channel:digest',
      values: ['900000000000000009'],
      user: { id: '204255221017214977' },
      guildId: '900000000000000001',
      channelId: '900000000000000002',
      context: InteractionContextType.Guild,
    };
    const interaction = toInteraction(raw as never);
    expect(interaction.kind).toBe('select');
    expect(interaction.values).toEqual(['900000000000000009']);
  });

  it('reads the fields a modal was submitted with', () => {
    const raw = {
      id: '111111111111111111',
      type: InteractionType.ModalSubmit,
      customId: 'postpone:41',
      fields: { fields: new Map([['reason', { customId: 'reason', value: 'The room was double booked.' }]]) },
      user: { id: '204255221017214977' },
      guildId: '900000000000000001',
      channelId: '900000000000000002',
      context: InteractionContextType.Guild,
    };
    const interaction = toInteraction(raw as never);
    expect(interaction.kind).toBe('modal');
    expect(interaction.fields).toEqual({ reason: 'The room was double booked.' });
  });

  it('reads the option a person is still typing on an autocomplete', () => {
    const raw = chatCommand({
      type: InteractionType.ApplicationCommandAutocomplete,
      commandName: 'events',
      options: {
        data: [{ name: 'rso', type: ApplicationCommandOptionType.String, value: 'ie', focused: true }],
      },
    });
    const interaction = toInteraction(raw as never);
    expect(interaction.kind).toBe('autocomplete');
    expect(interaction.focusedOption).toEqual({ name: 'rso', value: 'ie' });
  });

  it('names the context a person is in, in the bot direct messages and in a private channel', () => {
    const dm = toInteraction(chatCommand({
      guildId: null, context: InteractionContextType.BotDM,
    }) as never);
    expect(dm.context).toBe('botDm');
    expect(dm.guildId).toBe(null);

    const group = toInteraction(chatCommand({
      guildId: null, context: InteractionContextType.PrivateChannel,
    }) as never);
    expect(group.context).toBe('privateChannel');
  });

  it('falls back to the server identifier when the library reports no context', () => {
    expect(toInteraction(chatCommand({ context: null }) as never).context).toBe('guild');
    expect(toInteraction(chatCommand({ context: null, guildId: null }) as never).context).toBe('botDm');
  });
});

describe('reading what a person may do in a server', () => {
  it('names the permissions the person holds, as the registry names them', () => {
    const raw = chatCommand({
      memberPermissions: { bitfield: PermissionFlagsBits.ManageGuild | PermissionFlagsBits.ManageEvents },
    });
    const permissions = toInteraction(raw as never).memberPermissions;
    expect([...permissions].sort()).toEqual(['ManageEvents', 'ManageGuild']);
  });

  it('reads a bitfield the library handed over as a plain string', () => {
    const raw = chatCommand({ memberPermissions: String(PermissionFlagsBits.ManageGuild) });
    expect(toInteraction(raw as never).memberPermissions).toEqual(['ManageGuild']);
  });

  it('names the permissions the bot itself holds, which is a separate question', () => {
    const raw = chatCommand({
      memberPermissions: { bitfield: PermissionFlagsBits.ManageGuild },
      appPermissions: { bitfield: PermissionFlagsBits.SendMessages },
    });
    const interaction = toInteraction(raw as never);
    expect(interaction.memberPermissions).toEqual(['ManageGuild']);
    expect(interaction.applicationPermissions).toEqual(['SendMessages']);
  });

  it('names no permission at all outside a server, where there are none to hold', () => {
    const raw = chatCommand({ guildId: null, context: InteractionContextType.BotDM, memberPermissions: null });
    expect(toInteraction(raw as never).memberPermissions).toEqual([]);
    expect(toInteraction(raw as never).applicationPermissions).toEqual([]);
  });

  it('answers whether a person holds one named permission', () => {
    const raw = chatCommand({ memberPermissions: { bitfield: PermissionFlagsBits.ManageGuild } });
    expect(hasPermission(toInteraction(raw as never), 'ManageGuild')).toBe(true);
    expect(hasPermission(toInteraction(raw as never), 'ManageEvents')).toBe(false);
  });

  it('treats the administrator permission as holding every permission, as Discord does', () => {
    const raw = chatCommand({ memberPermissions: { bitfield: PermissionFlagsBits.Administrator } });
    expect(hasPermission(toInteraction(raw as never), 'ManageGuild')).toBe(true);
  });
});

describe('answering an interaction', () => {
  it('turns plain buttons into the rows the library sends', () => {
    const reply: Reply = {
      content: 'Open the address to finish linking.',
      components: [{
        kind: 'row',
        components: [
          { kind: 'button', style: 'link', label: 'Open viaillinois.com', url: 'https://viaillinois.com/link/discord/abc' },
          { kind: 'button', style: 'secondary', label: 'Cancel', customId: 'link:cancel' },
        ],
      }],
    };
    expect(toComponents(reply)).toEqual([{
      type: ComponentType.ActionRow,
      components: [
        { type: ComponentType.Button, style: 5, label: 'Open viaillinois.com', url: 'https://viaillinois.com/link/discord/abc' },
        { type: ComponentType.Button, style: 2, label: 'Cancel', custom_id: 'link:cancel' },
      ],
    }]);
  });

  it('replies once when nothing was acknowledged yet', async () => {
    const raw = { deferred: false, replied: false, reply: vi.fn(), editReply: vi.fn(), followUp: vi.fn() };
    await applyReply(raw as never, { content: 'You are linked.', ephemeral: true });
    expect(raw.reply).toHaveBeenCalledWith({
      content: 'You are linked.',
      flags: MessageFlags.Ephemeral,
      components: [],
    });
    expect(raw.editReply).not.toHaveBeenCalled();
  });

  it('edits the acknowledgement rather than replying twice', async () => {
    const raw = { deferred: true, replied: false, reply: vi.fn(), editReply: vi.fn(), followUp: vi.fn() };
    await applyReply(raw as never, { content: 'You are linked.', ephemeral: true });
    expect(raw.editReply).toHaveBeenCalledWith({ content: 'You are linked.', components: [] });
    expect(raw.reply).not.toHaveBeenCalled();
  });

  it('follows up when something was already said', async () => {
    const raw = { deferred: false, replied: true, reply: vi.fn(), editReply: vi.fn(), followUp: vi.fn() };
    await applyReply(raw as never, { content: 'One more thing.', ephemeral: true });
    expect(raw.followUp).toHaveBeenCalledWith({
      content: 'One more thing.',
      flags: MessageFlags.Ephemeral,
      components: [],
    });
  });

  it('acknowledges before doing the work and edits the acknowledgement afterwards', async () => {
    const order: string[] = [];
    const raw = {
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => { order.push('acknowledge'); raw.deferred = true; }),
      reply: vi.fn(),
      editReply: vi.fn(async () => { order.push('answer'); }),
      followUp: vi.fn(),
    };
    await respond(raw as never, { ephemeral: true }, async () => {
      order.push('work');
      return { content: 'You are linked.' };
    });
    expect(order).toEqual(['acknowledge', 'work', 'answer']);
    expect(raw.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  it('says the work failed rather than leaving a thinking state behind', async () => {
    const raw = {
      deferred: false,
      replied: false,
      deferReply: vi.fn(async () => { raw.deferred = true; }),
      reply: vi.fn(),
      editReply: vi.fn(),
      followUp: vi.fn(),
    };
    await respond(raw as never, { ephemeral: true }, async () => {
      throw new Error('the web platform fell over');
    });
    expect(raw.editReply).toHaveBeenCalledWith({
      content: 'Something went wrong on the VIA side. Please try again in a moment.',
      components: [],
    });
  });
});

describe('answering with the components setup needs', () => {
  it('turns a menu of fixed choices into the string select the library sends', () => {
    const reply: Reply = {
      content: 'What kind of server is this?',
      components: [{
        kind: 'row',
        components: [{
          kind: 'select',
          selectKind: 'string',
          customId: 'setup:kind',
          placeholder: 'Choose what kind of server this is',
          options: [
            { label: 'An organization server', value: 'rso', description: 'This server belongs to one organization.' },
            { label: 'A community server', value: 'community', selected: true },
          ],
        }],
      }],
    };
    expect(toComponents(reply)).toEqual([{
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.StringSelect,
        custom_id: 'setup:kind',
        placeholder: 'Choose what kind of server this is',
        min_values: 1,
        max_values: 1,
        options: [
          { label: 'An organization server', value: 'rso', description: 'This server belongs to one organization.' },
          { label: 'A community server', value: 'community', default: true },
        ],
      }],
    }]);
  });

  it('lets a menu take more than one answer when the panel asks for a set', () => {
    const [row] = toComponents({
      content: 'Which organizations does this server follow?',
      components: [{
        kind: 'row',
        components: [{
          kind: 'select',
          selectKind: 'string',
          customId: 'setup:followed',
          minValues: 0,
          maxValues: 25,
          options: [{ label: 'IEEE', value: '1' }],
        }],
      }],
    }) as [{ components: Record<string, unknown>[] }];
    expect(row.components[0]!.min_values).toBe(0);
    expect(row.components[0]!.max_values).toBe(25);
  });

  it('turns a channel menu into the channel select the library sends', () => {
    expect(toComponents({
      content: 'Which channel should announcements go to?',
      components: [{
        kind: 'row',
        components: [{
          kind: 'select',
          selectKind: 'channel',
          customId: 'setup:channel:announcements',
          placeholder: 'Choose a channel',
        }],
      }],
    })).toEqual([{
      type: ComponentType.ActionRow,
      components: [{
        type: ComponentType.ChannelSelect,
        custom_id: 'setup:channel:announcements',
        placeholder: 'Choose a channel',
        min_values: 1,
        max_values: 1,
        channel_types: [ChannelType.GuildText, ChannelType.GuildAnnouncement],
      }],
    }]);
  });

  it('reads back what a person chose in a menu', () => {
    const raw = {
      id: '111111111111111111',
      type: InteractionType.MessageComponent,
      componentType: ComponentType.StringSelect,
      customId: 'setup:kind',
      values: ['community'],
      user: { id: '204255221017214977' },
      guildId: '900000000000000001',
      channelId: '900000000000000002',
      context: InteractionContextType.Guild,
    };
    const interaction = toInteraction(raw as never);
    expect(interaction.kind).toBe('select');
    expect(interaction.customId).toBe('setup:kind');
    expect(interaction.values).toEqual(['community']);
  });
});

describe('answering with a file', () => {
  it('turns a calendar file into the attachment the library sends', () => {
    const files = toFiles({
      content: 'Here is the calendar file for the event.',
      files: [{ name: 'via-event-10.ics', content: 'BEGIN:VCALENDAR', contentType: 'text/calendar' }],
    });
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe('via-event-10.ics');
    expect(files[0]!.contentType).toBe('text/calendar');
    expect(files[0]!.attachment.toString('utf8')).toBe('BEGIN:VCALENDAR');
  });

  it('sends the attachment along with the answer', async () => {
    const raw = { deferred: true, replied: false, reply: vi.fn(), editReply: vi.fn(), followUp: vi.fn() };
    await applyReply(raw as never, {
      content: 'Here is the calendar file for the event.',
      files: [{ name: 'via-event-10.ics', content: 'BEGIN:VCALENDAR', contentType: 'text/calendar' }],
    });
    const sent = raw.editReply.mock.calls[0]![0] as { files: unknown[] };
    expect(sent.files).toHaveLength(1);
  });

  it('sends no files field at all when the answer carries none', async () => {
    const raw = { deferred: true, replied: false, reply: vi.fn(), editReply: vi.fn(), followUp: vi.fn() };
    await applyReply(raw as never, { content: 'Nothing is attached.' });
    expect(raw.editReply).toHaveBeenCalledWith({ content: 'Nothing is attached.', components: [] });
  });
});

describe('answering a component in place', () => {
  it('edits the message the component sits on rather than sending another one', async () => {
    const order: string[] = [];
    const raw = {
      deferred: false,
      replied: false,
      deferUpdate: vi.fn(async () => { order.push('acknowledge'); raw.deferred = true; }),
      deferReply: vi.fn(),
      reply: vi.fn(),
      editReply: vi.fn(async () => { order.push('answer'); }),
      followUp: vi.fn(),
    };
    await respondByUpdate(raw as never, async () => {
      order.push('work');
      return { content: 'This server follows every organization in ECE.' };
    });
    expect(order).toEqual(['acknowledge', 'work', 'answer']);
    expect(raw.deferReply).not.toHaveBeenCalled();
  });

  it('says the work failed rather than leaving the panel as it was', async () => {
    const raw = {
      deferred: false,
      replied: false,
      deferUpdate: vi.fn(async () => { raw.deferred = true; }),
      reply: vi.fn(),
      editReply: vi.fn(),
      followUp: vi.fn(),
    };
    await respondByUpdate(raw as never, async () => { throw new Error('the web platform fell over'); });
    expect(raw.editReply).toHaveBeenCalledWith({
      content: 'Something went wrong on the VIA side. Please try again in a moment.',
      components: [],
    });
  });

  it('edits the message directly when the panel is answered without acknowledging first', async () => {
    const raw = { deferred: false, replied: false, update: vi.fn(), editReply: vi.fn() };
    await applyUpdate(raw as never, { content: 'Choose a channel.' });
    expect(raw.update).toHaveBeenCalledWith({ content: 'Choose a channel.', components: [] });
  });
});

describe('answering an autocomplete', () => {
  it('sends the choices as Discord names them', async () => {
    const raw = { respond: vi.fn() };
    await answerAutocomplete(raw as never, [
      { name: 'IEEE', value: '1' },
      { name: 'HKN', value: '9' },
    ]);
    expect(raw.respond).toHaveBeenCalledWith([
      { name: 'IEEE', value: '1' },
      { name: 'HKN', value: '9' },
    ]);
  });

  it('sends at most the twenty five choices Discord accepts', async () => {
    const raw = { respond: vi.fn() };
    await answerAutocomplete(raw as never, Array.from({ length: 40 }, (unused, index) => ({
      name: `Organization ${index}`,
      value: String(index),
    })));
    expect((raw.respond.mock.calls[0]![0] as unknown[]).length).toBe(25);
  });

  it('trims a name that is longer than Discord allows rather than being refused', async () => {
    const raw = { respond: vi.fn() };
    await answerAutocomplete(raw as never, [{ name: 'x'.repeat(200), value: '1' }]);
    const [choice] = raw.respond.mock.calls[0]![0] as { name: string }[];
    expect(choice!.name.length).toBe(100);
  });

  it('says nothing rather than throwing when Discord has already closed the interaction', async () => {
    const raw = { respond: vi.fn(async () => { throw new Error('Unknown interaction'); }) };
    await expect(answerAutocomplete(raw as never, [{ name: 'IEEE', value: '1' }])).resolves.toBeUndefined();
  });
});
