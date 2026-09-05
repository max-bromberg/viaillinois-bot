import { vi } from 'vitest';
import type { Interaction } from '../../src/discord/adapter.ts';
import type { CommandContext } from '../../src/commands/index.ts';
import { createFakeViaClient, type FakeViaClient } from '../../src/via/fake.ts';
import type { RateDecision, RateTier } from '../../src/ratelimit/windows.ts';

/** A plain interaction in the shape the adapter hands to a command. */
export function interaction(overrides: Partial<Interaction> = {}): Interaction {
  return {
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
    ...overrides,
  };
}

export interface TestContext {
  context: CommandContext;
  via: FakeViaClient;
  directMessages: Array<{ discordUserId: string; content: string }>;
  scheduled: Array<() => Promise<void>>;
  deleted: string[];
  consumed: Array<{ subject: string; tier: RateTier }>;
  /** The fake clock, which the fake sleep moves forward. */
  clockAt: () => Date;
}

/**
 * A command context with nothing real behind it: the fake web platform
 * client, a recorded direct message sender, a rate limiter that allows
 * everything unless a test says otherwise, and a clock the fake sleep moves
 * rather than a timer anybody waits on.
 */
export function testContext(options: {
  decide?: (subject: string, tier: RateTier) => RateDecision;
} = {}): TestContext {
  const via = createFakeViaClient();
  const directMessages: Array<{ discordUserId: string; content: string }> = [];
  const scheduled: Array<() => Promise<void>> = [];
  const deleted: string[] = [];
  const consumed: Array<{ subject: string; tier: RateTier }> = [];
  let clock = new Date('2026-09-05T14:30:00Z');

  const context: CommandContext = {
    via,
    rateWindows: {
      consume: async (subject: string, tier: RateTier) => {
        consumed.push({ subject, tier });
        return options.decide
          ? options.decide(subject, tier)
          : { allowed: true, used: 0, limit: 30, retryAfterSeconds: 0 };
      },
      sweep: async () => 0,
    },
    deleteLocalData: vi.fn(async (discordUserId: string) => { deleted.push(discordUserId); }),
    sendDirectMessage: async (discordUserId: string, content: string) => {
      directMessages.push({ discordUserId, content });
    },
    schedule: (task: () => Promise<void>) => { scheduled.push(task); },
    now: () => clock,
    sleep: async (milliseconds: number) => { clock = new Date(clock.getTime() + milliseconds); },
  };

  return { context, via, directMessages, scheduled, deleted, consumed, clockAt: () => clock };
}
