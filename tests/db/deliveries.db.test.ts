import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDb, resetTestDb, useTestDbEnvironment } from '../support/testDb.ts';

let db: typeof import('../../src/db/client.ts').db;
let pool: typeof import('../../src/db/client.ts').pool;
let deliveries: typeof import('../../src/db/schema.ts').deliveries;
let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;
let createDeliveries: typeof import('../../src/delivery/deliveries.ts').createDeliveries;
let channelTarget: typeof import('../../src/delivery/deliveries.ts').channelTarget;

/**
 * The outbox consumer writes one Deliveries row per intended post before
 * posting it, keyed by outbox entry, target and purpose, so that a crash
 * between the write and the post is retried and a crash after the post is
 * not. That guarantee is the database's unique key, so it is tested there.
 */
describe('Deliveries', () => {
  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ db, pool } = await import('../../src/db/client.ts'));
    ({ deliveries } = await import('../../src/db/schema.ts'));
    ({ applyMigrations } = await import('../../src/db/migrate.ts'));
    ({ createDeliveries, channelTarget } = await import('../../src/delivery/deliveries.ts'));
  }, 180_000);

  beforeEach(async () => {
    await resetTestDb();
    await applyMigrations();
  });

  afterAll(async () => { await pool.end(); });

  const intended = {
    outboxId: 42,
    target: 'channel:123456789012345678',
    purpose: 'announcements',
    kind: 'message' as const,
  };

  it('records an intended post once', async () => {
    await db.insert(deliveries).values(intended);
    const rows = await db.select().from(deliveries);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outboxId).toBe(42);
    expect(rows[0]!.target).toBe('channel:123456789012345678');
    expect(rows[0]!.deliveredAt).toBe(null);
  });

  it('refuses a second row for the same outbox entry, target and purpose', async () => {
    await db.insert(deliveries).values(intended);
    // Drizzle wraps the driver error and keeps the MySQL error code on cause.
    const failure = await db.insert(deliveries).values(intended).then(() => null, (err: Error) => err);
    expect(failure).not.toBe(null);
    expect(((failure as any).cause ?? failure).code).toBe('ER_DUP_ENTRY');
    const rows = await db.select().from(deliveries);
    expect(rows).toHaveLength(1);
  });

  it('allows the same outbox entry to reach a second target or serve a second purpose', async () => {
    await db.insert(deliveries).values(intended);
    await db.insert(deliveries).values({ ...intended, target: 'channel:987654321098765432' });
    await db.insert(deliveries).values({ ...intended, purpose: 'digest' });
    const rows = await db.select().from(deliveries);
    expect(rows).toHaveLength(3);
  });

  it('reads datetime columns back as the strings they were written as', async () => {
    // The pool is configured with dateStrings, as the web platform's is, so
    // campus wall clock is never reinterpreted in the process's zone.
    await db.insert(deliveries).values({ ...intended, deliveredAt: '2026-09-04 18:30:00' });
    const rows = await db.select().from(deliveries);
    expect(rows[0]!.deliveredAt).toBe('2026-09-04 18:30:00');
  });

  /**
   * Deliveries, as the outbox consumer uses them.
   *
   * The guarantee is stated in section 7 of the design: one row per intended
   * post is written before the post is made, so that a crash between the write
   * and the post is retried and a crash after the post is not. These tests are
   * that sentence, twice, with a crash in each of the two places.
   */
  describe('intending and recording a delivery', () => {
    const channel = '700000000000000001';
    const intent = () => ({
      outboxId: 42,
      target: channelTarget(channel),
      purpose: 'event.created',
      kind: 'message' as const,
    });

    const store = () => createDeliveries(db, { now: () => new Date('2026-09-05T14:30:00Z') });

    it('answers that an intention nothing had intended before is new', async () => {
      const intended = await store().intend(intent());
      expect(intended.isNew).toBe(true);
      expect(intended.deliveryId).toBeGreaterThan(0);
      expect(intended.messageId).toBe(null);
    });

    it('answers that a second intention for the same entry, target and purpose is not new', async () => {
      const first = await store().intend(intent());
      const second = await store().intend(intent());
      expect(second.isNew).toBe(false);
      expect(second.deliveryId).toBe(first.deliveryId);
      expect(await db.select().from(deliveries)).toHaveLength(1);
    });

    it('treats a second channel and a second purpose as intentions of their own', async () => {
      await store().intend(intent());
      const elsewhere = await store().intend({ ...intent(), target: channelTarget('700000000000000002') });
      const otherPurpose = await store().intend({ ...intent(), purpose: 'event.updated' });
      expect(elsewhere.isNew).toBe(true);
      expect(otherPurpose.isNew).toBe(true);
      expect(await db.select().from(deliveries)).toHaveLength(3);
    });

    it('records the message a post left behind, in campus wall clock', async () => {
      const intended = await store().intend(intent());
      await store().recordPosted(intended.deliveryId, '800000000000000001');

      const [row] = await db.select().from(deliveries);
      expect(row!.messageId).toBe('800000000000000001');
      expect(row!.deliveredAt).toBe('2026-09-05 09:30:00');
    });

    /**
     * The bot fell over between writing the intention and making the post. The
     * post never happened, so the row is still pending and the work is done
     * when the bot comes back.
     */
    it('leaves a delivery that was intended and never posted pending', async () => {
      const intended = await store().intend(intent());
      const waiting = await store().pending();
      expect(waiting.map(row => row.deliveryId)).toEqual([intended.deliveryId]);
      expect(waiting[0]!.target).toBe(channelTarget(channel));
      expect(waiting[0]!.purpose).toBe('event.created');
      expect(waiting[0]!.outboxId).toBe(42);
    });

    /**
     * The bot fell over after making the post. The post happened, so nothing is
     * pending, and the entry handled again intends the same delivery and is
     * told it is not new, which is what stops the second post.
     */
    it('leaves nothing pending once the post has been recorded, and refuses to intend it again', async () => {
      const intended = await store().intend(intent());
      await store().recordPosted(intended.deliveryId, '800000000000000001');

      expect(await store().pending()).toEqual([]);
      const again = await store().intend(intent());
      expect(again.isNew).toBe(false);
      expect(again.messageId).toBe('800000000000000001');
    });

    it('records a delivery that leaves no message behind, such as a scheduled event', async () => {
      const intended = await store().intend({ ...intent(), kind: 'scheduled_event', purpose: 'mirror' });
      await store().recordPosted(intended.deliveryId, null);
      expect(await store().pending()).toEqual([]);
    });

    it('reads back what a delivery left behind, so a later entry can edit it', async () => {
      const intended = await store().intend(intent());
      await store().recordPosted(intended.deliveryId, '800000000000000001');
      const held = await store().find({ outboxId: 42, target: channelTarget(channel), purpose: 'event.created' });
      expect(held!.messageId).toBe('800000000000000001');
      expect(await store().find({ outboxId: 43, target: channelTarget(channel), purpose: 'event.created' }))
        .toBe(null);
    });

    /**
     * Section 10 of the design keeps Deliveries for ninety days. The rows are
     * the record of what the bot posted, and a row older than that answers no
     * question anybody asks, because nothing is retried after ninety days.
     */
    it('prunes the deliveries intended before a campus wall clock moment, and no others', async () => {
      await db.insert(deliveries).values([
        { outboxId: 1, target: 'user:1', purpose: 'old', kind: 'direct_message', intendedAt: '2026-06-01 09:00:00' },
        { outboxId: 2, target: 'user:1', purpose: 'new', kind: 'direct_message', intendedAt: '2026-09-01 09:00:00' },
      ]);

      expect(await store().pruneBefore('2026-06-07 00:00:00')).toBe(1);
      const rows = await db.select().from(deliveries);
      expect(rows.map(row => row.purpose)).toEqual(['new']);
      expect(await store().pruneBefore('2026-06-07 00:00:00')).toBe(0);
    });

    it('names a channel and a person the way the target column spells them', () => {
      expect(channelTarget('700000000000000001')).toBe('channel:700000000000000001');
    });
  });
});
