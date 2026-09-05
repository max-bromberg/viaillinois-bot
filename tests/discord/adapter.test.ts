import { describe, it, expect, vi } from 'vitest';
import {
  ApplicationCommandOptionType, ComponentType, InteractionContextType, InteractionType, MessageFlags,
} from 'discord.js';
import { toInteraction, toComponents, applyReply, respond } from '../../src/discord/adapter.ts';
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
