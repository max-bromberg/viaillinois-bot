import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { eventMirrors } from '../db/schema.ts';
import { campusStamp } from '../render/campusTime.ts';
import type { BotDatabase } from '../ratelimit/windows.ts';

/**
 * What a VIA event became in a server.
 *
 * One row per server and event holds two things: the Discord scheduled event
 * that mirrors the event into the server's Events tab, and the announcement
 * message that a change edits in place and that a notice replies to. They sit
 * in one row rather than two tables because they are two answers to the same
 * question, which is where this event is in this server, and because removing
 * a server has to forget both together.
 *
 * Either side can be absent. A server can mirror without announcing and
 * announce without mirroring, and both are ordinary states rather than half
 * finished ones.
 */

export interface EventMirror {
  mirrorId: number;
  guildId: string;
  eventId: number;
  /** The Discord scheduled event, when the server mirrors this event. */
  scheduledEventId: string | null;
  announcementChannelId: string | null;
  announcementMessageId: string | null;
}

/** Where an announcement went, which is what an edit needs to find it again. */
export interface AnnouncementPost {
  channelId: string;
  messageId: string;
}

export interface EventMirrorOptions {
  /** Injected so that tests write a fixed campus wall clock. */
  now?: () => Date;
}

export interface EventMirrors {
  get(guildId: string, eventId: number): Promise<EventMirror | null>;
  /** Record the announcement a server posted for an event, replacing any earlier one. */
  recordAnnouncement(guildId: string, eventId: number, post: AnnouncementPost): Promise<void>;
  /** Record the scheduled event a server created, or clear it when Discord no longer has one. */
  recordScheduledEvent(guildId: string, eventId: number, scheduledEventId: string | null): Promise<void>;
  /**
   * The one announcement any of these events left behind in this server. A
   * series is announced once, against the first of its events, so a change to
   * the series finds its announcement from the events the entry names.
   */
  findAnnouncement(guildId: string, eventIds: readonly number[]): Promise<EventMirror | null>;
  /** The event a Discord scheduled event mirrors, which is what an interest signal names. */
  byScheduledEvent(guildId: string, scheduledEventId: string): Promise<EventMirror | null>;
  listByGuild(guildId: string): Promise<EventMirror[]>;
  listByEvent(eventId: number): Promise<EventMirror[]>;
  remove(guildId: string, eventId: number): Promise<void>;
  /** Forget everything one server holds, and say how many rows that was. */
  removeGuild(guildId: string): Promise<number>;
}

function present(row: typeof eventMirrors.$inferSelect): EventMirror {
  return {
    mirrorId: row.mirrorId,
    guildId: row.guildId,
    eventId: row.eventId,
    scheduledEventId: row.scheduledEventId ?? null,
    announcementChannelId: row.announcementChannelId ?? null,
    announcementMessageId: row.announcementMessageId ?? null,
  };
}

export function createEventMirrors(db: BotDatabase, options: EventMirrorOptions = {}): EventMirrors {
  const { now = () => new Date() } = options;

  async function get(guildId: string, eventId: number): Promise<EventMirror | null> {
    const [row] = await db.select().from(eventMirrors)
      .where(and(eq(eventMirrors.guildId, guildId), eq(eventMirrors.eventId, eventId)));
    return row ? present(row) : null;
  }

  /**
   * One row per server and event, written whichever side of it is being
   * recorded. The insert that updates on the unique key is what makes the
   * second side arrive without reading the row first.
   */
  async function write(
    guildId: string,
    eventId: number,
    values: Partial<typeof eventMirrors.$inferInsert>,
  ): Promise<void> {
    const updatedAt = campusStamp(now());
    await db.insert(eventMirrors)
      .values({ guildId, eventId, updatedAt, ...values })
      .onDuplicateKeyUpdate({ set: { updatedAt, ...values } });
  }

  return {
    get,

    async recordAnnouncement(guildId, eventId, post) {
      await write(guildId, eventId, {
        announcementChannelId: post.channelId,
        announcementMessageId: post.messageId,
      });
    },

    async recordScheduledEvent(guildId, eventId, scheduledEventId) {
      await write(guildId, eventId, { scheduledEventId });
    },

    async findAnnouncement(guildId, eventIds) {
      if (eventIds.length === 0) return null;
      const rows = await db.select().from(eventMirrors).where(and(
        eq(eventMirrors.guildId, guildId),
        inArray(eventMirrors.eventId, [...eventIds]),
        isNotNull(eventMirrors.announcementMessageId),
      ));
      // The earliest event of a series is the one it was announced against,
      // and the events of a series arrive in order, so the lowest identifier
      // is the announcement to edit when somehow there is more than one.
      const found = rows.map(present).sort((left, right) => left.eventId - right.eventId)[0];
      return found ?? null;
    },

    async byScheduledEvent(guildId, scheduledEventId) {
      const [row] = await db.select().from(eventMirrors).where(and(
        eq(eventMirrors.guildId, guildId),
        eq(eventMirrors.scheduledEventId, scheduledEventId),
      ));
      return row ? present(row) : null;
    },

    async listByGuild(guildId) {
      const rows = await db.select().from(eventMirrors)
        .where(eq(eventMirrors.guildId, guildId));
      return rows.map(present);
    },

    async listByEvent(eventId) {
      const rows = await db.select().from(eventMirrors)
        .where(eq(eventMirrors.eventId, eventId));
      return rows.map(present);
    },

    async remove(guildId, eventId) {
      await db.delete(eventMirrors)
        .where(and(eq(eventMirrors.guildId, guildId), eq(eventMirrors.eventId, eventId)));
    },

    async removeGuild(guildId) {
      const rows = await db.select().from(eventMirrors)
        .where(eq(eventMirrors.guildId, guildId));
      await db.delete(eventMirrors).where(eq(eventMirrors.guildId, guildId));
      return rows.length;
    },
  };
}
