import { describe, it, expect, vi } from 'vitest';
import {
  ApplicationCommandOptionType, ChannelType, ComponentType, GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel, InteractionContextType, InteractionType,
  MessageFlags, PermissionFlagsBits,
} from 'discord.js';
import {
  toInteraction, toComponents, toFiles, applyReply, applyUpdate, respond, respondByUpdate,
  answerAutocomplete, hasPermission, createDiscordActions, isMissingAccess,
  toScheduledEventInterest,
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

/**
 * The actions the bot takes on its own, rather than in answer to somebody.
 *
 * Everything proactive the bot does reaches Discord through this wrapper:
 * posting an announcement, editing it when the event changes, pinning a
 * message, and creating, editing and deleting the server's own scheduled
 * events. It is thin on purpose. What it is for is that every module above it
 * can be tested by handing it an object that records what it was asked to do,
 * which is exactly what these tests do to the wrapper itself.
 */
describe('the actions the bot takes on its own', () => {
  const CHANNEL = '700000000000000001';
  const GUILD = '900000000000000001';

  function fakeClient() {
    const sent: Array<Record<string, unknown>> = [];
    const edited: Array<Record<string, unknown>> = [];
    const pinned: string[] = [];
    const unpinned: string[] = [];
    const scheduled: Array<Record<string, unknown>> = [];
    const message = {
      id: '800000000000000001',
      edit: async (payload: Record<string, unknown>) => { edited.push(payload); },
      pin: async () => { pinned.push('800000000000000001'); },
      unpin: async () => { unpinned.push('800000000000000001'); },
    };
    const client = {
      channels: {
        fetch: async (channelId: string) => {
          if (channelId !== CHANNEL) throw new Error('Unknown Channel');
          return {
            isTextBased: () => true,
            send: async (payload: Record<string, unknown>) => { sent.push(payload); return message; },
            messages: { fetch: async () => message },
          };
        },
      },
      guilds: {
        fetch: async (guildId: string) => {
          if (guildId !== GUILD) throw new Error('Unknown Guild');
          return {
            members: { me: { permissions: { bitfield: PermissionFlagsBits.ManageEvents } } },
            scheduledEvents: {
              create: async (payload: Record<string, unknown>) => {
                scheduled.push({ action: 'create', ...payload });
                return { id: '600000000000000001' };
              },
              edit: async (id: string, payload: Record<string, unknown>) => {
                scheduled.push({ action: 'edit', id, ...payload });
              },
              delete: async (id: string) => { scheduled.push({ action: 'delete', id }); },
            },
          };
        },
      },
    };
    return { client, sent, edited, pinned, unpinned, scheduled };
  }

  it('posts a message with the content and the components of the answer', async () => {
    const fake = fakeClient();
    const actions = createDiscordActions(fake.client as never);
    const messageId = await actions.postMessage(CHANNEL, {
      content: 'IEEE has a new event.',
      components: [{
        kind: 'row',
        components: [{ kind: 'button', style: 'primary', label: 'Interested', customId: 'event:interested:10' }],
      }],
    });

    expect(messageId).toBe('800000000000000001');
    expect(fake.sent[0]!.content).toBe('IEEE has a new event.');
    expect(JSON.stringify(fake.sent[0]!.components)).toContain('event:interested:10');
  });

  it('posts a notice as a reply to the announcement it is about', async () => {
    const fake = fakeClient();
    const actions = createDiscordActions(fake.client as never);
    await actions.postMessage(CHANNEL, { content: 'This event has moved.' }, {
      replyToMessageId: '800000000000000001',
    });
    expect(fake.sent[0]!.reply).toEqual({
      messageReference: '800000000000000001',
      failIfNotExists: false,
    });
  });

  it('edits a message in place, which is how an announcement stays current', async () => {
    const fake = fakeClient();
    const actions = createDiscordActions(fake.client as never);
    await actions.editMessage(CHANNEL, '800000000000000001', { content: 'The room has changed.' });
    expect(fake.edited[0]!.content).toBe('The room has changed.');
  });

  it('pins and unpins a message', async () => {
    const fake = fakeClient();
    const actions = createDiscordActions(fake.client as never);
    await actions.pinMessage(CHANNEL, '800000000000000001');
    await actions.unpinMessage(CHANNEL, '800000000000000001');
    expect(fake.pinned).toEqual(['800000000000000001']);
    expect(fake.unpinned).toEqual(['800000000000000001']);
  });

  /**
   * A VIA event is somewhere Discord does not know about, so it is mirrored as
   * a scheduled event of the external kind, whose place is a line of text.
   * Discord requires an end time for that kind, which VIA always has.
   */
  it('creates a scheduled event of the external kind, with the place and the times', async () => {
    const fake = fakeClient();
    const actions = createDiscordActions(fake.client as never);
    const id = await actions.createScheduledEvent(GUILD, {
      name: 'General meeting',
      description: 'Bring a laptop.',
      startTime: '2026-09-10T18:00:00-05:00',
      endTime: '2026-09-10T19:00:00-05:00',
      location: 'Electrical & Computer Eng Bldg 1002',
    });

    expect(id).toBe('600000000000000001');
    const created = fake.scheduled[0]!;
    expect(created.action).toBe('create');
    expect(created.name).toBe('General meeting');
    expect(created.entityType).toBe(GuildScheduledEventEntityType.External);
    expect(created.privacyLevel).toBe(GuildScheduledEventPrivacyLevel.GuildOnly);
    expect(created.entityMetadata).toEqual({ location: 'Electrical & Computer Eng Bldg 1002' });
    expect(created.scheduledStartTime).toBe('2026-09-10T18:00:00-05:00');
    expect(created.scheduledEndTime).toBe('2026-09-10T19:00:00-05:00');
  });

  it('edits and deletes a scheduled event by the identifier it was given', async () => {
    const fake = fakeClient();
    const actions = createDiscordActions(fake.client as never);
    await actions.editScheduledEvent(GUILD, '600000000000000001', {
      name: 'General meeting',
      startTime: '2026-09-10T19:00:00-05:00',
      endTime: '2026-09-10T20:00:00-05:00',
      location: 'Everitt Laboratory 151',
    });
    await actions.deleteScheduledEvent(GUILD, '600000000000000001');

    expect(fake.scheduled[0]).toMatchObject({ action: 'edit', id: '600000000000000001' });
    expect(fake.scheduled[1]).toEqual({ action: 'delete', id: '600000000000000001' });
  });

  it('says which permissions the bot itself holds in a server, by name', async () => {
    const fake = fakeClient();
    const actions = createDiscordActions(fake.client as never);
    expect(await actions.permissionsIn(GUILD)).toEqual(['ManageEvents']);
  });

  it('tells a channel that is gone apart from any other failure', async () => {
    expect(isMissingAccess({ code: 10003 })).toBe(true);
    expect(isMissingAccess({ code: 50001 })).toBe(true);
    expect(isMissingAccess({ code: 50013 })).toBe(true);
    expect(isMissingAccess(new Error('Discord did not answer'))).toBe(false);
  });
});

/**
 * Interest left on a scheduled event.
 *
 * Discord tells the bot who marked themselves interested in one of the
 * server's scheduled events, and the bot records that on VIA against the event
 * the scheduled event mirrors. The gateway hands over the scheduled event and
 * the person, and this turns the pair into the three identifiers that answer
 * which event, in which server, and who.
 */
describe('an interest signal from the Events tab', () => {
  it('reads the server, the scheduled event and the person', () => {
    const signal = toScheduledEventInterest(
      { id: '600000000000000001', guildId: '900000000000000001' },
      { id: '204255221017214977' },
    );
    expect(signal).toEqual({
      guildId: '900000000000000001',
      scheduledEventId: '600000000000000001',
      discordUserId: '204255221017214977',
    });
  });

  it('reads the server from the guild the library attached when it named no identifier', () => {
    const signal = toScheduledEventInterest(
      { id: '600000000000000001', guild: { id: '900000000000000001' } },
      { id: '204255221017214977' },
    );
    expect(signal.guildId).toBe('900000000000000001');
  });

  it('answers with no server rather than a made up one when the library named none', () => {
    const signal = toScheduledEventInterest({ id: '600000000000000001' }, { id: '204255221017214977' });
    expect(signal.guildId).toBe(null);
  });
});
