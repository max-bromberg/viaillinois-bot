import { describe, it, expect, vi } from 'vitest';
import {
  ApplicationCommandOptionType, InteractionContextType, InteractionType, MessageFlags,
} from 'discord.js';
import {
  answersOnlyThePerson, createDispatcher, handlers, FEATURE_OFF_MESSAGE, UNKNOWN_COMMAND_MESSAGE,
} from '../../src/commands/index.ts';
import { buildCommands } from '../../src/discord/registerCommands.ts';
import { FAILURE_MESSAGE } from '../../src/discord/adapter.ts';
import { autocompleteSubject, type RateDecision, type RateTier } from '../../src/ratelimit/windows.ts';
import { interaction, testContext } from './support.ts';

/**
 * The dispatcher is tested through the adapter, on interaction shaped plain
 * objects, so that what a person actually sees is what is asserted on.
 */
function rawCommand(overrides: Record<string, unknown> = {}) {
  const raw: Record<string, unknown> = {
    id: '111111111111111111',
    type: InteractionType.ApplicationCommand,
    commandName: 'link',
    user: { id: '204255221017214977' },
    guildId: '900000000000000001',
    channelId: '900000000000000002',
    context: InteractionContextType.Guild,
    options: { data: [] },
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => { raw.deferred = true; }),
    reply: vi.fn(),
    editReply: vi.fn(),
    followUp: vi.fn(),
    ...overrides,
  };
  return raw;
}

const refuse = (retryAfterSeconds: number): RateDecision =>
  ({ allowed: false, used: 30, limit: 30, retryAfterSeconds });

describe('the command dispatcher', () => {
  it('runs the command the person named and answers only them', async () => {
    const { context, via } = testContext();
    const dispatch = createDispatcher(context);
    const raw = rawCommand();
    await dispatch(raw);
    expect(raw.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
    expect(via.sessions).toHaveLength(1);
    const answer = (raw.editReply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { content: string };
    expect(answer.content).toContain('https://viaillinois.com/link/discord/');
  });

  it('routes each command to its own handler', async () => {
    const { context, deleted } = testContext();
    const dispatch = createDispatcher(context);
    await dispatch(rawCommand({ commandName: 'unlink' }));
    expect(deleted).toEqual(['204255221017214977']);
  });

  it('says one sentence for a command it does not answer', async () => {
    const { context } = testContext();
    const dispatch = createDispatcher(context);
    const raw = rawCommand({ commandName: 'nonsense' });
    await dispatch(raw);
    expect(raw.reply).toHaveBeenCalledWith({
      content: UNKNOWN_COMMAND_MESSAGE,
      flags: MessageFlags.Ephemeral,
      components: [],
    });
  });

  it('counts the command against the person and against the server', async () => {
    const { context, consumed } = testContext();
    const dispatch = createDispatcher(context);
    await dispatch(rawCommand());
    expect(consumed).toEqual([
      { subject: 'user:204255221017214977', tier: 'unlinked' },
      { subject: 'guild:900000000000000001', tier: 'guild' },
    ]);
  });

  it('counts a command only a linked person can run against the wider limit', async () => {
    const { context, consumed } = testContext();
    const dispatch = createDispatcher(context);
    await dispatch(rawCommand({ commandName: 'unlink' }));
    expect(consumed[0]).toEqual({ subject: 'user:204255221017214977', tier: 'linked' });
  });

  it('counts nothing against a server when there is no server', async () => {
    const { context, consumed } = testContext();
    const dispatch = createDispatcher(context);
    await dispatch(rawCommand({ guildId: null, context: InteractionContextType.BotDM }));
    expect(consumed).toEqual([{ subject: 'user:204255221017214977', tier: 'unlinked' }]);
  });

  it('refuses a person over their limit with one sentence naming the wait', async () => {
    const { context, via } = testContext({
      decide: (subject: string) => subject.startsWith('user:')
        ? refuse(720)
        : { allowed: true, used: 0, limit: 600, retryAfterSeconds: 0 },
    });
    const dispatch = createDispatcher(context);
    const raw = rawCommand();
    await dispatch(raw);
    expect(raw.reply).toHaveBeenCalledWith({
      content: 'You have run too many VIA commands in the last hour. Please try again in 12 minutes.',
      flags: MessageFlags.Ephemeral,
      components: [],
    });
    expect(via.sessions).toEqual([]);
  });

  it('refuses a server over its limit with one sentence naming the wait', async () => {
    const { context, via } = testContext({
      decide: (subject: string) => subject.startsWith('guild:')
        ? refuse(45)
        : { allowed: true, used: 0, limit: 30, retryAfterSeconds: 0 },
    });
    const dispatch = createDispatcher(context);
    const raw = rawCommand();
    await dispatch(raw);
    expect(raw.reply).toHaveBeenCalledWith({
      content: 'This server has run too many VIA commands in the last hour. Please try again in 45 seconds.',
      flags: MessageFlags.Ephemeral,
      components: [],
    });
    expect(via.sessions).toEqual([]);
  });

  it('answers a refusal without a thinking state, because nothing was done', async () => {
    const { context } = testContext({ decide: () => refuse(30) });
    const dispatch = createDispatcher(context);
    const raw = rawCommand();
    await dispatch(raw);
    expect(raw.deferReply).not.toHaveBeenCalled();
  });

  it('says the work failed rather than leaving a thinking state behind', async () => {
    const { context, via } = testContext();
    via.failNextWith(new TypeError('something the client does not type'));
    const dispatch = createDispatcher(context);
    const raw = rawCommand();
    await dispatch(raw);
    expect(raw.editReply).toHaveBeenCalledWith({ content: FAILURE_MESSAGE, components: [] });
  });

  it('leaves alone the kinds of interaction this increment has no handler for', async () => {
    const { context, consumed } = testContext();
    const dispatch = createDispatcher(context);
    const raw = rawCommand({ type: InteractionType.MessageComponent, componentType: 2, customId: 'interest:41' });
    await expect(dispatch(raw)).resolves.toBeUndefined();
    expect(raw.reply).not.toHaveBeenCalled();
    expect(consumed).toEqual([]);
  });

  /**
   * Following an organization tells the web platform which organizations the
   * person's calendar carries, which is the web platform's work rather than
   * theirs to wait for, so it happens after they have been answered.
   */
  it('runs the work a command scheduled once the person has been answered', async () => {
    const order: string[] = [];
    const { context, via } = testContext();
    via.seedLink('204255221017214977', { displayName: 'Rosa Garcia' });
    const scheduled: Array<Promise<void>> = [];
    const dispatch = createDispatcher({
      ...context,
      schedule: (task: () => Promise<void>) => { order.push('scheduled'); scheduled.push(task()); },
    });
    const raw = rawCommand({
      commandName: 'follow',
      options: { data: [{ name: 'rso', value: '1' }] },
      editReply: vi.fn(async () => { order.push('answered'); }),
    });
    await dispatch(raw);
    await Promise.all(scheduled);
    expect(order).toEqual(['scheduled', 'answered']);
  });
});

/**
 * The commands Discord is given and the commands the dispatcher answers are
 * two lists built from the same registry, and a command in one and not the
 * other is a command that answers with the sentence about a command the bot
 * does not have. The subcommand names are joined with a space, which is what
 * the adapter reports and therefore what the dispatcher keys on.
 */
describe('the commands Discord is given and the commands the bot answers', () => {
  it('has one handler for each, and no handler for anything else', () => {
    const named: string[] = [];
    for (const command of buildCommands()) {
      const subcommands = (command.options ?? [])
        .filter(option => option.type === ApplicationCommandOptionType.Subcommand);
      if (subcommands.length === 0) named.push(command.name);
      else for (const subcommand of subcommands) named.push(`${command.name} ${subcommand.name}`);
    }
    expect([...handlers].map(handler => handler.name).sort()).toEqual(named.sort());
  });
});

/**
 * The per server feature switches, which are what section 5 of the design
 * means by server owner control.
 *
 * A server manager can switch any feature off in the setup panels, and until
 * now that meant nothing at all for the commands: Discord has no per server
 * view of a global command, so the command was still there and still answered.
 * The switch is enforced here instead, and the refusal names the command that
 * puts it back, because the person who ran it is usually not the person who
 * switched it off.
 *
 * Setup and removal are the two features a manager cannot switch off, because
 * switching setup off would leave a server with no way to switch anything on.
 */
describe('a feature a server switched off', () => {
  const GUILD = '900000000000000001';

  async function switchedOff(featureId: string) {
    const started = testContext();
    await started.guilds.createInstallation(GUILD, '204255221017214977');
    await started.guilds.setFeatureEnabled(GUILD, featureId, false);
    return started;
  }

  it('refuses the command in that server, naming the way to put it back', async () => {
    const { context } = await switchedOff('identity.link');
    const raw = rawCommand();
    await createDispatcher(context)(raw);

    expect(raw.reply).toHaveBeenCalledWith({
      content: FEATURE_OFF_MESSAGE,
      flags: MessageFlags.Ephemeral,
      components: [],
    });
    expect(raw.deferReply).not.toHaveBeenCalled();
  });

  it('answers the command in a server that left it switched on', async () => {
    const { context, via } = await switchedOff('events.list');
    await createDispatcher(context)(rawCommand());
    expect(via.sessions).toHaveLength(1);
  });

  it('refuses a button whose feature that server switched off', async () => {
    const { context } = await switchedOff('identity.link');
    const raw = rawCommand({
      type: InteractionType.MessageComponent,
      componentType: 2,
      commandName: null,
      customId: 'identity:link',
    });
    await createDispatcher(context)(raw);
    expect(raw.reply).toHaveBeenCalledWith({
      content: FEATURE_OFF_MESSAGE,
      flags: MessageFlags.Ephemeral,
      components: [],
    });
  });

  it('never refuses setup, because that would leave nothing to switch it back on with', async () => {
    const { context } = await switchedOff('setup.configure');
    const raw = rawCommand({ commandName: 'via setup', options: { data: [] } });
    await createDispatcher(context)(raw);
    expect(raw.reply).not.toHaveBeenCalledWith(expect.objectContaining({ content: FEATURE_OFF_MESSAGE }));
  });

  it('never refuses removal, for the same reason', async () => {
    const { context } = await switchedOff('setup.remove');
    const raw = rawCommand({ commandName: 'via remove', options: { data: [] } });
    await createDispatcher(context)(raw);
    expect(raw.reply).not.toHaveBeenCalledWith(expect.objectContaining({ content: FEATURE_OFF_MESSAGE }));
  });

  /**
   * A switch is one server's answer about its own channels and members. In
   * the bot's direct messages there is no server to have answered.
   */
  it('asks no server about a command run in a direct message', async () => {
    const { context, via } = await switchedOff('identity.link');
    await createDispatcher(context)(rawCommand({
      guildId: null,
      context: InteractionContextType.BotDM,
    }));
    expect(via.sessions).toHaveLength(1);
  });
});

describe('the tier a command is counted against', () => {
  it('is the unlinked tier for a command anybody may run', async () => {
    const { context, consumed } = testContext();
    await createDispatcher(context)(rawCommand());
    expect((consumed[0]!.tier satisfies RateTier)).toBe('unlinked');
  });
});

/**
 * Autocomplete and the components the bot's own answers carry.
 *
 * An autocomplete arrives on every keystroke and is answered with a list of
 * completions rather than a message, and a component arrives when somebody
 * presses a button the bot posted. Both go through the same dispatcher, and
 * both are routed by the adapter rather than by anything that knows about
 * discord.js.
 */
function rawAutocomplete(overrides: Record<string, unknown> = {}) {
  return {
    id: '111111111111111111',
    type: InteractionType.ApplicationCommandAutocomplete,
    commandName: 'events',
    user: { id: '204255221017214977' },
    guildId: '900000000000000001',
    channelId: '900000000000000002',
    context: InteractionContextType.Guild,
    options: { data: [{ name: 'rso', type: 3, value: 'ie', focused: true }] },
    respond: vi.fn(async () => {}),
    ...overrides,
  };
}

function rawComponent(overrides: Record<string, unknown> = {}) {
  const raw: Record<string, unknown> = {
    id: '111111111111111111',
    type: InteractionType.MessageComponent,
    componentType: 2,
    customId: 'events:open:10',
    user: { id: '204255221017214977' },
    guildId: '900000000000000001',
    channelId: '900000000000000002',
    context: InteractionContextType.Guild,
    values: [],
    deferred: false,
    replied: false,
    deferReply: vi.fn(async () => { raw.deferred = true; }),
    deferUpdate: vi.fn(async () => { raw.deferred = true; }),
    update: vi.fn(),
    reply: vi.fn(),
    editReply: vi.fn(),
    followUp: vi.fn(),
    ...overrides,
  };
  return raw;
}

describe('completing an option as a person types', () => {
  it('answers with the completions the command produced', async () => {
    const { context } = testContext();
    const raw = rawAutocomplete();
    await createDispatcher(context)(raw);
    expect(raw.respond).toHaveBeenCalledWith([{ name: 'IEEE', value: '1' }]);
  });

  /**
   * An autocomplete fires on every keystroke, so counting it against the
   * command limit would refuse a person for typing a name. It is counted
   * against a window of its own instead, which is wide enough that nobody
   * reaches it by typing and narrow enough that a script cannot spend the
   * whole afternoon filling the caches behind it.
   */
  it('counts an autocomplete against a window of its own, not the command limit', async () => {
    const { context, consumed } = testContext();
    await createDispatcher(context)(rawAutocomplete());
    expect(consumed).toEqual([
      { subject: autocompleteSubject('204255221017214977'), tier: 'autocomplete' },
    ]);
  });

  it('answers with no completions rather than a sentence when that window refuses', async () => {
    const { context } = testContext({
      decide: (_subject: string, tier: RateTier) => (tier === 'autocomplete'
        ? refuse(20)
        : { allowed: true, used: 0, limit: 30, retryAfterSeconds: 0 }),
    });
    const raw = rawAutocomplete();
    await createDispatcher(context)(raw);
    expect(raw.respond).toHaveBeenCalledWith([]);
  });

  it('never counts an autocomplete against the server, which types nothing', async () => {
    const { context, consumed } = testContext();
    await createDispatcher(context)(rawAutocomplete());
    expect(consumed.map(one => one.tier)).toEqual(['autocomplete']);
  });

  it('answers with nothing for a command that completes nothing', async () => {
    const { context } = testContext();
    const raw = rawAutocomplete({ commandName: 'link' });
    await createDispatcher(context)(raw);
    expect(raw.respond).toHaveBeenCalledWith([]);
  });

  it('answers with nothing rather than throwing when completing fails', async () => {
    const { context, via } = testContext();
    via.failNextWith(new Error('the web platform fell over'));
    const raw = rawAutocomplete();
    await expect(createDispatcher(context)(raw)).resolves.toBeUndefined();
    expect(raw.respond).toHaveBeenCalledWith([]);
  });
});

/**
 * Section 6.8 of the design: the application is published with both
 * installation contexts, so a person who installed it to their own account can
 * use it in a server that has not. The bot was not invited into that server's
 * channels, so what it says there is said to the person who asked and to
 * nobody else, whatever the handler would otherwise have chosen.
 */
describe('answering in a server that has not installed the bot', () => {
  const handler = { ephemeral: false };

  const inServer = (installedInServer: boolean) => ({
    ...interaction({ context: 'guild' as const }),
    installedInServer,
  });

  it('answers only the person who asked', () => {
    expect(answersOnlyThePerson(handler, inServer(false))).toBe(true);
  });

  it('leaves a server that has installed the bot to the handler', () => {
    expect(answersOnlyThePerson(handler, inServer(true))).toBe(false);
  });

  it('answers only the person whenever the handler asked for that anyway', () => {
    expect(answersOnlyThePerson({ ephemeral: true }, inServer(true))).toBe(true);
  });

  it('takes a component handler that says nothing as one that answers only the person', () => {
    expect(answersOnlyThePerson({}, inServer(true))).toBe(true);
  });

  it('leaves the bot direct messages to the handler, where nobody else is reading anyway', () => {
    const dm = { ...interaction({ context: 'botDm' as const, guildId: null }), installedInServer: true };
    expect(answersOnlyThePerson(handler, dm)).toBe(false);
  });
});

/**
 * Which answers a channel reads.
 *
 * A student who asks what is coming up in a server that has invited the bot is
 * asking a question the channel around them has too, and an answer only they
 * can see is a question asked again by the next person. So the reading
 * commands answer the channel, and everything else stays between the bot and
 * the person: a reminder, a follow, a setting, a board action and a setup
 * panel are one person's business wherever they are run.
 */
describe('the commands a channel reads', () => {
  const READING = ['events', 'event', 'rso', 'midterms', 'rooms', 'course', 'building'];

  it('answers the reading commands to the channel, in a server that installed the bot', () => {
    for (const name of READING) {
      const handler = handlers.find(one => one.name === name)!;
      expect(handler.ephemeral, name).toBe(false);
    }
  });

  it('answers every other command only to the person who ran it', () => {
    for (const handler of handlers) {
      if (READING.includes(handler.name)) continue;
      expect(handler.ephemeral, handler.name).toBe(true);
    }
  });

  it('answers a reading command only to the person in a server that has not', async () => {
    const { context } = testContext();
    const raw = rawCommand({
      commandName: 'events',
      options: { data: [] },
      authorizingIntegrationOwners: { 1: '204255221017214977' },
    });
    await createDispatcher(context)(raw);
    expect(raw.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  it('answers a reading command to the channel in a server that has', async () => {
    const { context } = testContext();
    const raw = rawCommand({
      commandName: 'events',
      options: { data: [] },
      authorizingIntegrationOwners: { 0: '900000000000000001' },
    });
    await createDispatcher(context)(raw);
    expect(raw.deferReply).toHaveBeenCalledWith({});
  });
});

describe('pressing a button the bot posted', () => {
  it('routes the button to the handler whose prefix it carries', async () => {
    const { context } = testContext();
    const raw = rawComponent();
    await createDispatcher(context)(raw);
    const answer = (raw.editReply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { content: string };
    expect(answer.content).toContain('General meeting');
  });

  it('edits the message the button sits on when the handler says so', async () => {
    const { context } = testContext();
    const raw = rawComponent();
    await createDispatcher(context)(raw);
    expect(raw.deferUpdate).toHaveBeenCalled();
    expect(raw.deferReply).not.toHaveBeenCalled();
  });

  it('answers a button that does not edit in place with a new message only that person sees', async () => {
    const { context } = testContext();
    const raw = rawComponent({ customId: 'event:calendar:10' });
    await createDispatcher(context)(raw);
    expect(raw.deferReply).toHaveBeenCalledWith({ flags: MessageFlags.Ephemeral });
  });

  it('counts a button against the person and against the server, as a command is', async () => {
    const { context, consumed } = testContext();
    await createDispatcher(context)(rawComponent());
    expect(consumed).toEqual([
      { subject: 'user:204255221017214977', tier: 'unlinked' },
      { subject: 'guild:900000000000000001', tier: 'guild' },
    ]);
  });

  it('refuses a button from a person over their limit, with the sentence naming the wait', async () => {
    const { context } = testContext({ decide: () => refuse(30) });
    const raw = rawComponent();
    await createDispatcher(context)(raw);
    expect(raw.reply).toHaveBeenCalledWith({
      content: 'You have run too many VIA commands in the last hour. Please try again in 30 seconds.',
      flags: MessageFlags.Ephemeral,
      components: [],
    });
  });

  it('leaves a component nothing answers alone', async () => {
    const { context, consumed } = testContext();
    const raw = rawComponent({ customId: 'nothing:answers:this' });
    await expect(createDispatcher(context)(raw)).resolves.toBeUndefined();
    expect(raw.reply).not.toHaveBeenCalled();
    expect(consumed).toEqual([]);
  });

  /**
   * A modal is the one answer Discord takes only as the first thing said, so
   * a handler that opens one is run before the interaction is acknowledged.
   * The form comes back as an interaction of its own, which is routed by the
   * identifier the form was built with, exactly as a button is.
   */
  it('shows the form a handler answered with, rather than acknowledging first', async () => {
    const { context, via } = testContext();
    via.seedLink('204255221017214977', { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'editor' }] });
    const raw = rawComponent({ customId: 'admin:form:note:10', showModal: vi.fn(async () => {}) });

    await createDispatcher(context)(raw);

    expect(raw.showModal).toHaveBeenCalled();
    expect(raw.deferReply).not.toHaveBeenCalled();
    expect(raw.deferUpdate).not.toHaveBeenCalled();
  });

  it('routes a submitted form to the handler whose prefix its identifier begins with', async () => {
    const { context, via } = testContext();
    via.seedLink('204255221017214977', { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'editor' }] });
    const raw = rawComponent({
      type: InteractionType.ModalSubmit,
      customId: 'admin:form:note:10',
      fields: { fields: new Map([['note', { value: 'Use the north entrance.' }]]) },
    });

    await createDispatcher(context)(raw);

    const answer = (raw.editReply as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { content: string };
    expect(answer.content).toContain('north entrance');
  });

  it('routes a menu as readily as a button', async () => {
    const { context, guilds } = testContext();
    await guilds.createInstallation('900000000000000001', '204255221017214977');
    const raw = rawComponent({
      componentType: 3,
      customId: 'setup:kind',
      values: ['community'],
      memberPermissions: { bitfield: 32n },
    });
    await createDispatcher(context)(raw);
    expect((await guilds.getInstallation('900000000000000001'))!.kind).toBe('community');
  });
});
