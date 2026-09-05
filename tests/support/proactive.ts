import type {
  Deliveries, Delivery, DeliveryIntent, DeliveryKey, IntendedDelivery,
} from '../../src/delivery/deliveries.ts';
import type {
  AnnouncementPost, EventMirror, EventMirrors,
} from '../../src/mirror/eventMirrors.ts';
import type {
  DiscordActions, PollDraft, PollResults, PostOptions, Reply, ScheduledEventDraft,
} from '../../src/discord/adapter.ts';
import type { DirectMessageDelivery, DirectMessageOutcome } from '../../src/discord/directMessages.ts';
import type { JobRuns } from '../../src/jobs/runs.ts';
import type { DiscordPermission } from '../../src/features/registry.ts';

/**
 * The three things everything proactive is written against, in memory.
 *
 * Deliveries, Event_Mirrors and Discord itself are what an announcement, a
 * change notice and a scheduled event actually touch. Their own guarantees
 * are tested against a real database and against the recorded shapes of the
 * library elsewhere, so what the handlers need here is behaviour that can be
 * read back: which posts were made, in what order, and what the bot wrote
 * down about them.
 */

/** Deliveries as a map, with the same unique key the database enforces. */
export function memoryDeliveries(): Deliveries & { rows: () => Delivery[] } {
  const rows = new Map<string, Delivery>();
  let nextId = 1;
  const keyOf = (key: DeliveryKey) => `${key.outboxId}|${key.target}|${key.purpose}`;

  return {
    rows: () => [...rows.values()],

    async intend(intent: DeliveryIntent): Promise<IntendedDelivery> {
      const key = keyOf(intent);
      const held = rows.get(key);
      if (held) return { ...held, isNew: false };

      const delivery: Delivery = {
        deliveryId: nextId++,
        outboxId: intent.outboxId,
        target: intent.target,
        purpose: intent.purpose,
        kind: intent.kind ?? 'message',
        messageId: null,
        deliveredAt: null,
      };
      rows.set(key, delivery);
      return { ...delivery, isNew: true };
    },

    async recordPosted(deliveryId: number, messageId: string | null = null): Promise<void> {
      for (const [key, row] of rows) {
        if (row.deliveryId !== deliveryId) continue;
        rows.set(key, { ...row, messageId, deliveredAt: '2026-09-05 09:30:00' });
      }
    },

    async pending(): Promise<Delivery[]> {
      return [...rows.values()].filter(row => row.deliveredAt === null);
    },

    async find(key: DeliveryKey): Promise<Delivery | null> {
      return rows.get(keyOf(key)) ?? null;
    },
  };
}

/** Event_Mirrors as a map, keyed the way the unique key on the table keys it. */
export function memoryEventMirrors(): EventMirrors {
  const rows = new Map<string, EventMirror>();
  let nextId = 1;
  const keyOf = (guildId: string, eventId: number) => `${guildId}|${eventId}`;

  function upsert(guildId: string, eventId: number, values: Partial<EventMirror>): void {
    const key = keyOf(guildId, eventId);
    const held = rows.get(key) ?? {
      mirrorId: nextId++,
      guildId,
      eventId,
      scheduledEventId: null,
      announcementChannelId: null,
      announcementMessageId: null,
    };
    rows.set(key, { ...held, ...values });
  }

  return {
    async get(guildId: string, eventId: number) {
      return rows.get(keyOf(guildId, eventId)) ?? null;
    },

    async recordAnnouncement(guildId: string, eventId: number, post: AnnouncementPost) {
      upsert(guildId, eventId, {
        announcementChannelId: post.channelId,
        announcementMessageId: post.messageId,
      });
    },

    async recordScheduledEvent(guildId: string, eventId: number, scheduledEventId: string | null) {
      upsert(guildId, eventId, { scheduledEventId });
    },

    async findAnnouncement(guildId: string, eventIds: readonly number[]) {
      return [...eventIds]
        .sort((left, right) => left - right)
        .map(eventId => rows.get(keyOf(guildId, eventId)))
        .find(row => row?.announcementMessageId) ?? null;
    },

    async byScheduledEvent(guildId: string, scheduledEventId: string) {
      return [...rows.values()]
        .find(row => row.guildId === guildId && row.scheduledEventId === scheduledEventId) ?? null;
    },

    async listByGuild(guildId: string) {
      return [...rows.values()].filter(row => row.guildId === guildId);
    },

    async listByEvent(eventId: number) {
      return [...rows.values()].filter(row => row.eventId === eventId);
    },

    async remove(guildId: string, eventId: number) {
      rows.delete(keyOf(guildId, eventId));
    },

    async removeGuild(guildId: string) {
      const held = [...rows.values()].filter(row => row.guildId === guildId);
      for (const row of held) rows.delete(keyOf(row.guildId, row.eventId));
      return held.length;
    },
  };
}

/** One thing the bot did to Discord, as the recording wrapper writes it down. */
export interface RecordedAction {
  action: 'post' | 'edit' | 'pin' | 'unpin' | 'createScheduledEvent'
    | 'editScheduledEvent' | 'deleteScheduledEvent' | 'poll' | 'readPoll'
    | 'addRole' | 'removeRole';
  channelId?: string;
  guildId?: string;
  messageId?: string;
  scheduledEventId?: string;
  reply?: Reply;
  draft?: ScheduledEventDraft;
  replyToMessageId?: string;
  poll?: PollDraft;
  discordUserId?: string;
  roleId?: string;
}

export interface RecordingActions extends DiscordActions {
  readonly done: RecordedAction[];
  /** What the bot itself may do in each server, which is what a permission check reads. */
  setPermissions(guildId: string, permissions: DiscordPermission[]): void;
  /** Make the next call of a kind throw, for the failures the handlers have to survive. */
  failNextWith(error: Error): void;
  /** What reading a poll answers with, for the job that closes one. */
  setPollResults(results: PollResults | null): void;
  /** Say that somebody has left the server, so that a role call answers with nothing. */
  setAbsent(discordUserId: string): void;
}

/** Discord as a list of what the bot asked it to do. */
export function recordingActions(options: {
  permissions?: DiscordPermission[];
} = {}): RecordingActions {
  const done: RecordedAction[] = [];
  const permissions = new Map<string, DiscordPermission[]>();
  const fallback = options.permissions ?? ['ViewChannel', 'SendMessages', 'ManageEvents'];
  let nextMessage = 800000000000000000n;
  let nextScheduled = 600000000000000000n;
  let nextFailure: Error | null = null;
  let pollResults: PollResults | null = { finalized: true, answers: [] };
  const absent = new Set<string>();

  function throwIfInstructed(): void {
    if (!nextFailure) return;
    const failure = nextFailure;
    nextFailure = null;
    throw failure;
  }

  return {
    done,

    setPermissions(guildId: string, granted: DiscordPermission[]): void {
      permissions.set(guildId, granted);
    },

    failNextWith(error: Error): void {
      nextFailure = error;
    },

    setPollResults(results: PollResults | null): void {
      pollResults = results;
    },

    setAbsent(discordUserId: string): void {
      absent.add(discordUserId);
    },

    async postPoll(channelId: string, poll: PollDraft): Promise<string> {
      throwIfInstructed();
      nextMessage += 1n;
      done.push({ action: 'poll', channelId, poll });
      return String(nextMessage);
    },

    async readPoll(channelId: string, messageId: string): Promise<PollResults | null> {
      throwIfInstructed();
      done.push({ action: 'readPoll', channelId, messageId });
      return pollResults;
    },

    async addRole(guildId: string, discordUserId: string, roleId: string): Promise<boolean> {
      throwIfInstructed();
      // Somebody who has left the server holds no roles to give or to take,
      // which Discord answers as a member it does not have.
      if (absent.has(discordUserId)) return false;
      done.push({ action: 'addRole', guildId, discordUserId, roleId });
      return true;
    },

    async removeRole(guildId: string, discordUserId: string, roleId: string): Promise<boolean> {
      throwIfInstructed();
      if (absent.has(discordUserId)) return false;
      done.push({ action: 'removeRole', guildId, discordUserId, roleId });
      return true;
    },

    async postMessage(channelId: string, reply: Reply, postOptions: PostOptions = {}): Promise<string> {
      throwIfInstructed();
      nextMessage += 1n;
      done.push({
        action: 'post',
        channelId,
        reply,
        ...(postOptions.replyToMessageId ? { replyToMessageId: postOptions.replyToMessageId } : {}),
      });
      return String(nextMessage);
    },

    async editMessage(channelId: string, messageId: string, reply: Reply): Promise<void> {
      throwIfInstructed();
      done.push({ action: 'edit', channelId, messageId, reply });
    },

    async pinMessage(channelId: string, messageId: string): Promise<void> {
      throwIfInstructed();
      done.push({ action: 'pin', channelId, messageId });
    },

    async unpinMessage(channelId: string, messageId: string): Promise<void> {
      throwIfInstructed();
      done.push({ action: 'unpin', channelId, messageId });
    },

    async createScheduledEvent(guildId: string, draft: ScheduledEventDraft): Promise<string> {
      throwIfInstructed();
      nextScheduled += 1n;
      done.push({ action: 'createScheduledEvent', guildId, draft });
      return String(nextScheduled);
    },

    async editScheduledEvent(guildId: string, scheduledEventId: string, draft: ScheduledEventDraft): Promise<void> {
      throwIfInstructed();
      done.push({ action: 'editScheduledEvent', guildId, scheduledEventId, draft });
    },

    async deleteScheduledEvent(guildId: string, scheduledEventId: string): Promise<void> {
      throwIfInstructed();
      done.push({ action: 'deleteScheduledEvent', guildId, scheduledEventId });
    },

    async permissionsIn(guildId: string): Promise<DiscordPermission[]> {
      return permissions.get(guildId) ?? fallback;
    },
  };
}

/** The direct messages a run sent, which is how a notice is read back. */
export function recordingDirectMessages() {
  const sent: Array<{ discordUserId: string; content: string }> = [];
  return {
    sent,
    send: async (discordUserId: string, content: string): Promise<boolean> => {
      sent.push({ discordUserId, content });
      return true;
    },
  };
}

/** Job_Runs as a map, which is all the scheduler asks of it. */
export function memoryJobRuns(): JobRuns {
  const rows = new Map<string, string>();
  return {
    async lastRunAt(jobName: string): Promise<string | null> {
      return rows.get(jobName) ?? null;
    },
    async recordRun(jobName: string, at: string): Promise<void> {
      rows.set(jobName, at);
    },
  };
}

/** What one direct message a job sent looked like, as the recording sender writes it down. */
export interface RecordedDirectMessage {
  discordUserId: string;
  reply: Reply;
}

export interface RecordingDelivery {
  readonly sent: RecordedDirectMessage[];
  deliver: DirectMessageDelivery;
  /** Make every message to this person come back as one they do not accept. */
  block(discordUserId: string): void;
  /** Make the next message fail for a reason that is nobody's answer. */
  failNext(): void;
}

/**
 * The direct messages a job sent, and the two answers it has to handle: a
 * person who does not accept them, and a failure that leaves the message owed.
 */
export function recordingDelivery(): RecordingDelivery {
  const sent: RecordedDirectMessage[] = [];
  const blocked = new Set<string>();
  let failNext = false;

  return {
    sent,
    block(discordUserId: string): void { blocked.add(discordUserId); },
    failNext(): void { failNext = true; },
    deliver: async (discordUserId: string, reply: Reply): Promise<DirectMessageOutcome> => {
      if (failNext) {
        failNext = false;
        return 'failed';
      }
      if (blocked.has(discordUserId)) return 'blocked';
      sent.push({ discordUserId, reply });
      return 'sent';
    },
  };
}
