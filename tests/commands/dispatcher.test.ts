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
