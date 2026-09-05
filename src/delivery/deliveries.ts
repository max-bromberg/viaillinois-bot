import { and, eq, isNull, lt } from 'drizzle-orm';
import { deliveries } from '../db/schema.ts';
import { campusStamp } from '../render/campusTime.ts';
import type { BotDatabase } from '../ratelimit/windows.ts';

/**
 * Deliveries.
 *
 * Everything the bot posts on its own goes through this module, and the rule
 * it exists for is one sentence from section 7 of the design: one row per
 * intended post is written before the post is made, keyed by the outbox
 * entry, the target and the purpose, so that a crash between the write and
 * the post is retried and a crash after the post is not.
 *
 * The key is the database's, not this module's. A unique key over the three
 * columns is what makes a second post impossible even if two consumers ran at
 * once, and intend() reads the refusal of that key rather than checking first
 * and inserting after, which would be a race with a window in it. A caller
 * that is told the intention is not new has nothing to do: somebody, possibly
 * itself before it fell over, has already posted this.
 *
 * A delivery that is intended and never posted stays pending, and pending()
 * is what a bot that has just come back reads to find the posts it owes.
 */

/** What a delivery is: a message, an edit of one, a direct message, or a scheduled event. */
export type DeliveryKind = 'message' | 'edit' | 'direct_message' | 'scheduled_event';

/**
 * The outbox identifier of a delivery that belongs to no outbox entry, such
 * as the notice a manager is sent when a feature had to be switched off.
 * Nothing in the outbox has this identifier, so the unique key still makes
 * the notice happen once.
 */
export const NO_OUTBOX_ENTRY = 0;

/** A channel, as the target column spells it. */
export function channelTarget(channelId: string): string {
  return `channel:${channelId}`;
}

/** A person, as the target column spells them. */
export function userTarget(discordUserId: string): string {
  return `user:${discordUserId}`;
}

/**
 * A server, as the target column spells it. A notice about a server goes to
 * that server's manager by direct message, and the server is what makes it
 * happen once, because the manager may run several servers.
 */
export function guildTarget(guildId: string): string {
  return `guild:${guildId}`;
}

/** What a delivery is keyed by, which is what makes it happen at most once. */
export interface DeliveryKey {
  outboxId: number;
  target: string;
  purpose: string;
}

export interface DeliveryIntent extends DeliveryKey {
  kind?: DeliveryKind;
}

/** A delivery as it stands: what it is for, and what it has left behind so far. */
export interface Delivery extends DeliveryKey {
  deliveryId: number;
  kind: DeliveryKind;
  /** The message the post left behind, which is what a later edit needs. */
  messageId: string | null;
  /** When the post was made, or null while it is still owed. */
  deliveredAt: string | null;
}

export interface IntendedDelivery extends Delivery {
  /** Whether this intention is the first, which is whether there is a post to make. */
  isNew: boolean;
}

export interface DeliveriesOptions {
  /** Injected so that tests write a fixed campus wall clock. */
  now?: () => Date;
}

export interface Deliveries {
  /**
   * Write down that a post is intended, and say whether it is the first time.
   * A caller told it is not the first has nothing to do.
   */
  intend(intent: DeliveryIntent): Promise<IntendedDelivery>;
  /** Record that the post was made, with the message it left behind if it left one. */
  recordPosted(deliveryId: number, messageId?: string | null): Promise<void>;
  /**
   * Forget a delivery that will never be made, because what it was going to
   * post into has gone. It is deleted rather than recorded as posted, because
   * nothing was posted and a row that said otherwise would be a lie about
   * what the bot did.
   */
  abandon(deliveryId: number): Promise<void>;
  /** Every delivery that was intended and never posted, oldest first. */
  pending(): Promise<Delivery[]>;
  /** One delivery by its key, or null when nothing intended it. */
  find(key: DeliveryKey): Promise<Delivery | null>;
  /**
   * Remove every delivery intended before a campus wall clock moment, and say
   * how many went. Section 10 of the design keeps these rows for ninety days,
   * which is the housekeeping job's question rather than this module's.
   */
  pruneBefore(intendedBefore: string): Promise<number>;
}

/** MySQL's code for a row that a unique key refused. */
const DUPLICATE_ENTRY = 'ER_DUP_ENTRY';

function isDuplicate(err: unknown): boolean {
  const code = (err as { code?: string; cause?: { code?: string } });
  return code?.code === DUPLICATE_ENTRY || code?.cause?.code === DUPLICATE_ENTRY;
}

function present(row: typeof deliveries.$inferSelect): Delivery {
  return {
    deliveryId: row.deliveryId,
    outboxId: row.outboxId,
    target: row.target,
    purpose: row.purpose,
    kind: row.kind,
    messageId: row.messageId ?? null,
    deliveredAt: row.deliveredAt ?? null,
  };
}

export function createDeliveries(db: BotDatabase, options: DeliveriesOptions = {}): Deliveries {
  const { now = () => new Date() } = options;

  async function find(key: DeliveryKey): Promise<Delivery | null> {
    const [row] = await db.select().from(deliveries).where(and(
      eq(deliveries.outboxId, key.outboxId),
      eq(deliveries.target, key.target),
      eq(deliveries.purpose, key.purpose),
    ));
    return row ? present(row) : null;
  }

  return {
    find,

    /**
     * The insert is tried first and the refusal is read, rather than a read
     * followed by an insert. Two consumers reaching the same entry at the
     * same time would both pass a read and both post; only one of them can
     * pass the unique key.
     */
    async intend(intent: DeliveryIntent): Promise<IntendedDelivery> {
      const row = {
        outboxId: intent.outboxId,
        target: intent.target,
        purpose: intent.purpose,
        kind: intent.kind ?? 'message',
        intendedAt: campusStamp(now()),
      };

      try {
        const result = await db.insert(deliveries).values(row);
        const insertId = Number((result as unknown as Array<{ insertId?: number }>)[0]?.insertId ?? 0);
        return {
          deliveryId: insertId,
          outboxId: row.outboxId,
          target: row.target,
          purpose: row.purpose,
          kind: row.kind,
          messageId: null,
          deliveredAt: null,
          isNew: true,
        };
      } catch (err) {
        if (!isDuplicate(err)) throw err;
        const held = await find(intent);
        if (!held) throw err;
        return { ...held, isNew: false };
      }
    },

    async recordPosted(deliveryId: number, messageId: string | null = null): Promise<void> {
      await db.update(deliveries)
        .set({ messageId, deliveredAt: campusStamp(now()) })
        .where(eq(deliveries.deliveryId, deliveryId));
    },

    async abandon(deliveryId: number): Promise<void> {
      await db.delete(deliveries).where(eq(deliveries.deliveryId, deliveryId));
    },

    async pruneBefore(intendedBefore: string): Promise<number> {
      const result = await db.delete(deliveries).where(lt(deliveries.intendedAt, intendedBefore));
      return (result as unknown as [{ affectedRows: number }])[0].affectedRows;
    },

    async pending(): Promise<Delivery[]> {
      const rows = await db.select().from(deliveries)
        .where(isNull(deliveries.deliveredAt))
        .orderBy(deliveries.deliveryId);
      return rows.map(present);
    },
  };
}
