import type { Interaction, Reply } from '../discord/adapter.ts';
import type { ViaClient } from '../via/client.ts';
import type { RateWindows } from '../ratelimit/windows.ts';

/**
 * What a command is given and what it answers with.
 *
 * Everything a command can reach is here, and all of it is injected: the web
 * platform client, the rate windows, the two pieces of Discord a command
 * needs beyond its own answer, and time. A command therefore runs in a test
 * with no gateway, no web platform and no clock that anybody waits on.
 */
export interface CommandContext {
  via: ViaClient;
  rateWindows: RateWindows;
  /** Delete every row the bot holds for a Discord account. */
  deleteLocalData: (discordUserId: string) => Promise<void>;
  /** Send one direct message, which only ever goes to a linked person. */
  sendDirectMessage: (discordUserId: string, content: string) => Promise<void>;
  /**
   * Run work after the person has been answered. Waiting for a link takes up
   * to a minute, and Discord is owed an answer in three seconds, so the wait
   * happens here rather than inside the answer.
   */
  schedule: (task: () => Promise<void>) => void;
  now: () => Date;
  sleep: (milliseconds: number) => Promise<void>;
}

export interface CommandHandler {
  /** The registry feature this command belongs to. */
  featureId: string;
  /** The name as the adapter reports it, which is what the dispatcher keys on. */
  name: string;
  /** Whether only the person who asked sees the answer. */
  ephemeral: boolean;
  run(interaction: Interaction, context: CommandContext): Promise<Reply>;
}

/**
 * How long to wait, in the words a sentence can end with. A wait is always
 * named, because a refusal that does not say when to come back is a refusal
 * a person retries immediately.
 */
export function describeWait(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'in a moment';
  if (seconds < 60) return `in ${Math.ceil(seconds)} ${Math.ceil(seconds) === 1 ? 'second' : 'seconds'}`;
  const minutes = Math.ceil(seconds / 60);
  return `in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}
