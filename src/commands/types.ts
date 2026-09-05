import type { AutocompleteChoice, Interaction, Reply } from '../discord/adapter.ts';
import type { ViaClient } from '../via/client.ts';
import type { GuildStore } from '../guilds/store.ts';
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
  /** What each server chose: its kind, its binding, its channels and its toggles. */
  guilds: GuildStore;
  /** The public address of the website, which the link buttons open. */
  websiteUrl: string;
  rateWindows: RateWindows;
  /** Delete every row the bot holds for a Discord account. */
  deleteLocalData: (discordUserId: string) => Promise<void>;
  /**
   * Clear what the bot posted into a server, which the removal command calls
   * before it deletes the rows that say where those posts are.
   *
   * The design has removal delete every scheduled event the bot created and
   * unpin the message it pinned. The scheduled events are deleted by the
   * scheduled event mirror, which is what the entry point gives this. Nothing
   * is unpinned yet, because the one message the bot pins is the living this
   * week message, which arrives in the third increment.
   */
  removeGuildPresence?: (guildId: string) => Promise<RemovedGuildPresence>;
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

/** What clearing the bot's presence from a server removed. */
export interface RemovedGuildPresence {
  scheduledEvents: number;
  unpinnedMessages: number;
}

export interface CommandHandler {
  /** The registry feature this command belongs to. */
  featureId: string;
  /** The name as the adapter reports it, which is what the dispatcher keys on. */
  name: string;
  /** Whether only the person who asked sees the answer. */
  ephemeral: boolean;
  run(interaction: Interaction, context: CommandContext): Promise<Reply>;
  /**
   * The completions Discord shows while a person is still typing an option.
   * A command with no completing option leaves this out.
   */
  autocomplete?(interaction: Interaction, context: CommandContext): Promise<AutocompleteChoice[]>;
}

/**
 * A handler for the buttons and menus the bot's own answers carry.
 *
 * Every component identifier begins with the prefix of the handler that
 * answers it, so routing is one lookup on a string rather than a registry of
 * every button the bot has ever posted. A component that updates in place
 * edits the message it sits on, which is what the setup panels do, and one
 * that does not answers with a new ephemeral message, which is what the
 * buttons on a public announcement have to do.
 */
export interface ComponentHandler {
  /** The registry feature this component belongs to. */
  featureId: string;
  /** The start of every identifier this handler answers. */
  prefix: string;
  /** Whether the answer edits the message the component sits on. */
  updateInPlace?: boolean;
  /** Whether only the person who pressed it sees the answer, when it is a new message. */
  ephemeral?: boolean;
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
