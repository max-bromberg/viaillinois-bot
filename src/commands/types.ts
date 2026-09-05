import type {
  AutocompleteChoice, Interaction, PollDraft, Reply,
} from '../discord/adapter.ts';
import type { EventMirrors } from '../mirror/eventMirrors.ts';
import type { SchedulerPolls } from '../scheduler/polls.ts';
import type { ViaClient } from '../via/client.ts';
import type { GuildStore } from '../guilds/store.ts';
import type { RateWindows } from '../ratelimit/windows.ts';
import type { FeedStore } from '../feed/store.ts';

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
  /** What each person chose: what they follow, when the bot writes to them, and their reminders. */
  feed: FeedStore;
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
   * unpin the message it pinned. Both are done by the scheduled event mirror,
   * which is what the entry point gives this: the scheduled events are its
   * own, and the pinned message is the living this week message, which it
   * unpins through the same hook.
   */
  removeGuildPresence?: (guildId: string) => Promise<RemovedGuildPresence>;
  /** Send one direct message, which only ever goes to a linked person. */
  sendDirectMessage: (discordUserId: string, content: string) => Promise<void>;
  /**
   * Post one message into a channel and answer with the identifier it left
   * behind. Two things a person asks for post rather than answer: an
   * announcement posted again, and a poll opened in a channel the board
   * picked. Both are the same seam the proactive features use, narrowed to
   * the one call a command makes.
   */
  postMessage?: (channelId: string, reply: Reply) => Promise<string>;
  /** Post one of Discord's own polls, which is what the scheduler opens. */
  postPoll?: (channelId: string, poll: PollDraft) => Promise<string>;
  /**
   * Write down where the announcement of an event now is, so that a later
   * change edits the message people are actually reading. Only the part of
   * Event_Mirrors a command touches is here.
   */
  mirrors?: Pick<EventMirrors, 'recordAnnouncement'>;
  /** The polls the scheduler opened, which the poll and its result are written to. */
  polls?: SchedulerPolls;
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
  /**
   * Whether this command can answer with a form rather than a message.
   * Discord takes a form only as the first thing said about an interaction,
   * so a command that may open one is run before anything is acknowledged.
   */
  opensModal?: boolean;
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
  /**
   * Whether this handler can answer with a form. A handler that may is run
   * before the interaction is acknowledged, because Discord takes a form only
   * as the first thing said about one.
   */
  opensModal?: boolean;
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
