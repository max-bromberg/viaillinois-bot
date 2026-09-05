import { describe, it, expect, beforeEach } from 'vitest';
import { createMidtermHandlers } from '../../src/announce/midterms.ts';
import { EXAM_STOP_SENTENCE } from '../../src/render/campus.ts';
import { userTarget } from '../../src/delivery/deliveries.ts';
import { createFakeViaClient } from '../../src/via/fake.ts';
import { memoryFeedStore } from '../support/feed.ts';
import { memoryDeliveries, recordingDelivery } from '../support/proactive.ts';

/**
 * What the bot writes when the outbox says an exam was confirmed, changed or
 * cancelled.
 *
 * These are the only outbox entries that reach a person rather than a server,
 * because an exam belongs to a course rather than to an organization. Everyone
 * who added the course hears once, through Deliveries keyed by the outbox
 * entry and the person, so an entry handled twice after a crash writes once.
 * Every message says what happened in a sentence or two and ends with the way
 * to stop that kind of message.
 */
describe('the notices about an exam', () => {
  const ADA = '204255221017214977';
  const GRACE = '204255221017214978';

  function built() {
    const feed = memoryFeedStore();
    const deliveries = memoryDeliveries();
    const delivery = recordingDelivery();
    const via = createFakeViaClient();
    via.seedLink(ADA);
    via.seedLink(GRACE);
    return {
      feed, deliveries, delivery, via,
      handlers: createMidtermHandlers({ feed, deliveries, via, deliver: delivery.deliver }),
    };
  }

  let stack: ReturnType<typeof built>;
  beforeEach(() => { stack = built(); });

  it('writes to everybody who added the course when an exam is confirmed', async () => {
    await stack.feed.addCourse(ADA, 'ECE 385');
    await stack.feed.addCourse(GRACE, 'ECE 385');
    const entry = stack.via.seedOutbox('midterm.confirmed');

    await stack.handlers['midterm.confirmed']!(entry);

    expect(stack.delivery.sent.map(one => one.discordUserId).sort()).toEqual([ADA, GRACE].sort());
    expect(stack.delivery.sent[0]!.reply.content).toContain('ECE 385');
    expect(stack.delivery.sent[0]!.reply.content).toContain('confirmed');
    expect(stack.delivery.sent[0]!.reply.content!.endsWith(EXAM_STOP_SENTENCE)).toBe(true);
  });

  it('says what changed when an exam moves', async () => {
    await stack.feed.addCourse(ADA, 'ECE 385');
    const entry = stack.via.seedOutbox('midterm.updated');

    await stack.handlers['midterm.updated']!(entry);
    expect(stack.delivery.sent[0]!.reply.content).toContain('changed');
  });

  it('says that an exam has been cancelled', async () => {
    await stack.feed.addCourse(ADA, 'ECE 385');
    const entry = stack.via.seedOutbox('midterm.cancelled');

    await stack.handlers['midterm.cancelled']!(entry);
    expect(stack.delivery.sent[0]!.reply.content).toContain('cancelled');
  });

  it('says nothing to somebody who did not add the course', async () => {
    await stack.feed.addCourse(ADA, 'ECE 391');
    await stack.handlers['midterm.confirmed']!(stack.via.seedOutbox('midterm.confirmed'));
    expect(stack.delivery.sent).toEqual([]);
  });

  it('writes about one entry once, however many times it is handled', async () => {
    await stack.feed.addCourse(ADA, 'ECE 385');
    const entry = stack.via.seedOutbox('midterm.confirmed');

    await stack.handlers['midterm.confirmed']!(entry);
    await stack.handlers['midterm.confirmed']!(entry);

    expect(stack.delivery.sent).toHaveLength(1);
    expect(await stack.deliveries.find({
      outboxId: entry.outboxId,
      target: userTarget(ADA),
      purpose: entry.kind,
    })).toMatchObject({ kind: 'direct_message' });
  });

  it('leaves alone a person who turned their direct messages off', async () => {
    await stack.feed.addCourse(ADA, 'ECE 385');
    await stack.feed.savePreferences(ADA, { directMessageOptOut: true });

    await stack.handlers['midterm.confirmed']!(stack.via.seedOutbox('midterm.confirmed'));
    expect(stack.delivery.sent).toEqual([]);
  });

  it('turns the direct messages off for somebody who does not accept them', async () => {
    await stack.feed.addCourse(ADA, 'ECE 385');
    stack.delivery.block(ADA);

    await stack.handlers['midterm.confirmed']!(stack.via.seedOutbox('midterm.confirmed'));
    expect((await stack.feed.preferences(ADA)).directMessageOptOut).toBe(true);
  });

  /**
   * A failure asks the consumer for the entry again, which is what leaving the
   * delivery pending and throwing means. The consumer's own bound on attempts
   * is what stops one bad entry from blocking the queue forever.
   */
  it('asks for the entry again when Discord would not take a message', async () => {
    await stack.feed.addCourse(ADA, 'ECE 385');
    stack.delivery.failNext();

    const entry = stack.via.seedOutbox('midterm.confirmed');
    await expect(stack.handlers['midterm.confirmed']!(entry)).rejects.toThrow();
    expect(await stack.deliveries.pending()).toHaveLength(1);
  });

  it('moves past an entry that carries no exam', async () => {
    await stack.feed.addCourse(ADA, 'ECE 385');
    const entry = stack.via.seedOutbox('midterm.confirmed', { payload: {} });

    await stack.handlers['midterm.confirmed']!(entry);
    expect(stack.delivery.sent).toEqual([]);
  });

  /**
   * Section 10 of the design: the bot writes only to linked people. A course
   * left behind by a link that went away would otherwise become a message
   * nobody asked for.
   */
  it('writes to nobody the web platform no longer knows', async () => {
    await stack.feed.addCourse(ADA, 'ECE 385');
    stack.via.removeLink(ADA);

    const entry = stack.via.seedOutbox('midterm.confirmed');
    await stack.handlers['midterm.confirmed']!(entry);
    expect(stack.delivery.sent).toEqual([]);
  });
});
