import { describe, it, expect, vi } from 'vitest';
import { InteractionContextType, InteractionType, MessageFlags } from 'discord.js';
import { createDispatcher, UNKNOWN_COMMAND_MESSAGE } from '../../src/commands/index.ts';
import { FAILURE_MESSAGE } from '../../src/discord/adapter.ts';
import type { RateDecision, RateTier } from '../../src/ratelimit/windows.ts';
import { testContext } from './support.ts';

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

  it('runs the work a command scheduled once the person has been answered', async () => {
    const order: string[] = [];
    const { context, via } = testContext();
    via.seedLink('204255221017214977', { displayName: 'Rosa Garcia' }, { afterLookups: 1 });
    const scheduled: Array<Promise<void>> = [];
    const dispatch = createDispatcher({
      ...context,
      schedule: (task: () => Promise<void>) => { order.push('scheduled'); scheduled.push(task()); },
    });
    const raw = rawCommand({
      editReply: vi.fn(async () => { order.push('answered'); }),
    });
    await dispatch(raw);
    await Promise.all(scheduled);
    expect(order).toEqual(['scheduled', 'answered']);
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
   * command limit would refuse a person for typing a name. The reads behind it
   * are the cached ones, which is what makes that affordable.
   */
  it('counts an autocomplete against nobody', async () => {
    const { context, consumed } = testContext();
    await createDispatcher(context)(rawAutocomplete());
    expect(consumed).toEqual([]);
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
