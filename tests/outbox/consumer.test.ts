import { describe, it, expect } from 'vitest';
import { createOutboxConsumer, type OutboxHandlers } from '../../src/outbox/consumer.ts';
import { ANNOUNCEMENTS_CONSUMER } from '../../src/outbox/cursor.ts';
import { createFakeViaClient, type FakeViaClient } from '../../src/via/fake.ts';
import type { OutboxCursors } from '../../src/outbox/cursor.ts';

/**
 * The outbox consumer.
 *
 * One loop reads the outbox from the cursor it holds and hands each entry to
 * the handler for its kind, in order. Three claims matter, and each of them
 * is a way the bot can fall over: the cursor advances only after an entry has
 * been handled, so a crash in the middle of one is retried from the cursor
 * after a restart; an entry whose kind nothing handles does not stop the
 * queue behind it; and an entry that keeps failing is eventually left behind
 * loudly, because one bad entry must not stop the bot forever.
 *
 * Nothing here reaches Discord or the web platform. The entries come from the
 * fake client, seeded from the recorded shapes, and the cursor is a variable.
 */

/** The cursor as a variable, which is what the database holds in production. */
function memoryCursors(start = 0): OutboxCursors & { at: () => number } {
  const held = new Map<string, number>();
  if (start > 0) held.set(ANNOUNCEMENTS_CONSUMER, start);
  return {
    at: () => held.get(ANNOUNCEMENTS_CONSUMER) ?? 0,
    async read(consumer) { return held.get(consumer) ?? 0; },
    async state(consumer) {
      const lastOutboxId = held.get(consumer);
      return lastOutboxId === undefined
        ? null
        : { lastOutboxId, updatedAt: '2026-09-05 09:30:00' };
    },
    async advance(consumer, lastOutboxId) { held.set(consumer, lastOutboxId); },
  };
}

/** A consumer over the fake client, with everything it touched recorded. */
function consumerOver(handlers: OutboxHandlers, options: {
  cursors?: ReturnType<typeof memoryCursors>;
  via?: FakeViaClient;
  maxAttempts?: number;
} = {}) {
  const via = options.via ?? createFakeViaClient();
  const cursors = options.cursors ?? memoryCursors();
  const invalidated: number[] = [];
  const waits: number[] = [];

  const consumer = createOutboxConsumer({
    via,
    cursors,
    handlers,
    invalidateRso: (rsoId: number) => { invalidated.push(rsoId); },
    now: () => new Date('2026-09-05T14:30:00Z'),
    sleep: async (milliseconds: number) => { waits.push(milliseconds); },
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });

  return { consumer, via, cursors, invalidated, waits };
}

describe('reading the outbox in order', () => {
  it('hands every entry to the handler for its kind, oldest first', async () => {
    const seen: string[] = [];
    const built = consumerOver({
      'event.created': async entry => { seen.push(`created:${entry.outboxId}`); },
      'event.updated': async entry => { seen.push(`updated:${entry.outboxId}`); },
    });
    built.via.seedOutbox('event.created');
    built.via.seedOutbox('event.updated');

    const worked = await built.consumer.runOnce();
    expect(seen).toEqual(['created:1', 'updated:2']);
    expect(worked.handled).toBe(2);
    expect(built.cursors.at()).toBe(2);
  });

  it('reads from the cursor it holds rather than from the beginning', async () => {
    const seen: number[] = [];
    const built = consumerOver(
      { 'event.created': async entry => { seen.push(entry.outboxId); } },
      { cursors: memoryCursors(1) },
    );
    built.via.seedOutbox('event.created');
    built.via.seedOutbox('event.created');

    await built.consumer.runOnce();
    expect(seen).toEqual([2]);
  });

  it('has nothing to do when the outbox has nothing new, and leaves the cursor alone', async () => {
    const built = consumerOver({ 'event.created': async () => {} }, { cursors: memoryCursors(4) });
    const worked = await built.consumer.runOnce();
    expect(worked.handled).toBe(0);
    expect(built.cursors.at()).toBe(4);
  });

  it('drops what it holds for the organization an entry names, so a change shows within seconds', async () => {
    const built = consumerOver({ 'event.created': async () => {} });
    built.via.seedOutbox('event.created', { rsoId: 9 });
    await built.consumer.runOnce();
    expect(built.invalidated).toEqual([9]);
  });

  it('invalidates nothing for an entry that belongs to no organization', async () => {
    const built = consumerOver({ 'midterm.confirmed': async () => {} });
    built.via.seedOutbox('midterm.confirmed');
    await built.consumer.runOnce();
    expect(built.invalidated).toEqual([]);
    expect(built.cursors.at()).toBe(1);
  });

  it('moves past an entry whose kind nothing handles rather than stopping on it', async () => {
    const seen: number[] = [];
    const built = consumerOver({ 'event.updated': async entry => { seen.push(entry.outboxId); } });
    built.via.seedOutbox('membership.changed');
    built.via.seedOutbox('event.updated');

    const worked = await built.consumer.runOnce();
    expect(seen).toEqual([2]);
    expect(worked.unhandled).toBe(1);
    expect(built.cursors.at()).toBe(2);
  });
});

describe('an entry that fails', () => {
  it('leaves the cursor before the entry, so the entry is read again on the next poll', async () => {
    let attempts = 0;
    const built = consumerOver({
      'event.created': async () => {
        attempts += 1;
        throw new Error('Discord did not answer');
      },
    });
    built.via.seedOutbox('event.created');

    await built.consumer.runOnce();
    expect(attempts).toBe(1);
    expect(built.cursors.at()).toBe(0);
  });

  it('holds back the entries behind it, because the outbox is handled in order', async () => {
    const seen: number[] = [];
    const built = consumerOver({
      'event.created': async () => { throw new Error('Discord did not answer'); },
      'event.updated': async entry => { seen.push(entry.outboxId); },
    });
    built.via.seedOutbox('event.created');
    built.via.seedOutbox('event.updated');

    await built.consumer.runOnce();
    expect(seen).toEqual([]);
    expect(built.cursors.at()).toBe(0);
  });

  it('succeeds on a later poll and carries on from there', async () => {
    let attempts = 0;
    const seen: number[] = [];
    const built = consumerOver({
      'event.created': async entry => {
        attempts += 1;
        if (attempts === 1) throw new Error('Discord did not answer');
        seen.push(entry.outboxId);
      },
      'event.updated': async entry => { seen.push(entry.outboxId); },
    });
    built.via.seedOutbox('event.created');
    built.via.seedOutbox('event.updated');

    await built.consumer.runOnce();
    await built.consumer.runOnce();
    expect(seen).toEqual([1, 2]);
    expect(built.cursors.at()).toBe(2);
  });

  /**
   * One entry that can never be handled, such as one naming a channel that no
   * longer exists, must not stop every entry behind it forever. After a bound
   * on attempts it is left behind with a log line loud enough to be found.
   */
  it('gives up on an entry after the bound on attempts and moves past it', async () => {
    const seen: number[] = [];
    const built = consumerOver(
      {
        'event.created': async () => { throw new Error('the channel is gone'); },
        'event.updated': async entry => { seen.push(entry.outboxId); },
      },
      { maxAttempts: 3 },
    );
    built.via.seedOutbox('event.created');
    built.via.seedOutbox('event.updated');

    await built.consumer.runOnce();
    await built.consumer.runOnce();
    const third = await built.consumer.runOnce();

    expect(third.skipped).toBe(1);
    expect(seen).toEqual([2]);
    expect(built.cursors.at()).toBe(2);
  });
});

describe('a bot that fell over in the middle of an entry', () => {
  /**
   * The bot crashed while handling the second entry. Everything it had
   * already done for that entry is written down in Deliveries, and the cursor
   * still stands before the entry, so the bot that comes back reads the same
   * entry again and finishes it. Whether the posts it had already made are
   * made twice is the Deliveries question, tested in the database suite.
   */
  it('resumes from the cursor after a restart and finishes the entry it was in', async () => {
    const cursors = memoryCursors();
    const via = createFakeViaClient();
    via.seedOutbox('event.created');
    via.seedOutbox('event.updated');
    via.seedOutbox('event.cancelled');

    const before: number[] = [];
    const crashing = consumerOver(
      {
        'event.created': async entry => { before.push(entry.outboxId); },
        'event.updated': async () => { throw new Error('the process went away'); },
        'event.cancelled': async entry => { before.push(entry.outboxId); },
      },
      { cursors, via },
    );
    await crashing.consumer.runOnce();
    expect(before).toEqual([1]);
    expect(cursors.at()).toBe(1);

    const after: number[] = [];
    const restarted = consumerOver(
      {
        'event.created': async entry => { after.push(entry.outboxId); },
        'event.updated': async entry => { after.push(entry.outboxId); },
        'event.cancelled': async entry => { after.push(entry.outboxId); },
      },
      { cursors, via },
    );
    await restarted.consumer.runOnce();
    expect(after).toEqual([2, 3]);
    expect(cursors.at()).toBe(3);
  });

  it('counts attempts per entry, so a restart starts the bound again rather than giving up at once', async () => {
    const cursors = memoryCursors();
    const via = createFakeViaClient();
    via.seedOutbox('event.created');

    const first = consumerOver(
      { 'event.created': async () => { throw new Error('the process went away'); } },
      { cursors, via, maxAttempts: 3 },
    );
    await first.consumer.runOnce();
    await first.consumer.runOnce();

    const restarted = consumerOver(
      { 'event.created': async () => { throw new Error('the process went away'); } },
      { cursors, via, maxAttempts: 3 },
    );
    const worked = await restarted.consumer.runOnce();
    expect(worked.skipped).toBe(0);
    expect(cursors.at()).toBe(0);
  });
});

describe('the loop the bot runs', () => {
  it('polls, waits, and polls again until it is stopped', async () => {
    const seen: number[] = [];
    const via = createFakeViaClient();
    via.seedOutbox('event.created');
    const waits: number[] = [];

    const consumer = createOutboxConsumer({
      via,
      cursors: memoryCursors(),
      handlers: { 'event.created': async entry => { seen.push(entry.outboxId); } },
      now: () => new Date('2026-09-05T14:30:00Z'),
      pollIntervalMs: 5_000,
      sleep: async (milliseconds: number) => {
        waits.push(milliseconds);
        // Stopping from inside the wait is how a test ends a loop that would
        // otherwise poll forever. Nothing awaits it here, because the loop
        // itself is what stopping waits for.
        if (waits.length >= 3) void consumer.stop();
      },
    });

    await consumer.start();

    expect(waits).toEqual([5_000, 5_000, 5_000]);
    // The first poll handled the one entry, and the polls after it found none.
    expect(seen).toEqual([1]);
  });

  it('says where it has read to and when it last looked, for the health endpoint', async () => {
    const built = consumerOver({ 'event.created': async () => {} });
    expect(built.consumer.state()).toEqual({ cursor: null, lastPollAt: null });

    built.via.seedOutbox('event.created');
    await built.consumer.runOnce();

    expect(built.consumer.state()).toEqual({ cursor: 1, lastPollAt: '2026-09-05 09:30:00' });
  });

  it('keeps polling when a poll itself fails, because the web platform comes back', async () => {
    const built = consumerOver({ 'event.created': async () => {} });
    built.via.failNextWith(new Error('VIA did not answer'));
    await expect(built.consumer.runOnce()).resolves.toMatchObject({ handled: 0 });

    built.via.seedOutbox('event.created');
    const worked = await built.consumer.runOnce();
    expect(worked.handled).toBe(1);
  });
});
