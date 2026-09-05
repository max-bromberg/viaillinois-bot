import { userTarget, type Deliveries } from '../delivery/deliveries.ts';
import { renderMidtermNotice } from '../render/campus.ts';
import { outboxMidterm, type Midterm, type OutboxEntry } from '../via/client.ts';
import type { DirectMessageDelivery } from '../discord/directMessages.ts';
import type { FeedStore } from '../feed/store.ts';
import type { OutboxHandlers } from '../outbox/consumer.ts';

/**
 * What the bot writes when the outbox says an exam was confirmed, changed or
 * cancelled.
 *
 * These are the only outbox entries that reach a person rather than a server.
 * An exam belongs to a course rather than to an organization, so there is no
 * server that follows it and no channel to post it in: the people to tell are
 * the people who added that course, and the way to tell them is the direct
 * message they asked for by adding it.
 *
 * Every message goes through Deliveries first, keyed by the outbox entry and
 * the person, so an entry handled twice after a crash writes once. A message
 * Discord would not take leaves the delivery pending and throws, which asks
 * the consumer for the entry again; the consumer's own bound on attempts is
 * what stops one bad entry from blocking the queue forever.
 *
 * A person who has closed their direct messages has answered: the bot switches
 * their direct messages off and leaves them alone until they turn them back
 * on, exactly as the digest and the reminders do.
 */

export interface MidtermHandlerOptions {
  feed: FeedStore;
  deliveries: Deliveries;
  deliver: DirectMessageDelivery;
}

export function createMidtermHandlers(options: MidtermHandlerOptions): OutboxHandlers {
  const { feed, deliveries, deliver } = options;

  /** Tell everybody who added the course, once each. */
  async function tellFollowers(entry: OutboxEntry, midterm: Midterm): Promise<void> {
    const followers = await feed.courseFollowers(midterm.courseCode);

    for (const discordUserId of followers) {
      const preferences = await feed.preferences(discordUserId);
      if (preferences.directMessageOptOut) continue;

      const intended = await deliveries.intend({
        outboxId: entry.outboxId,
        target: userTarget(discordUserId),
        purpose: entry.kind,
        kind: 'direct_message',
      });
      if (!intended.isNew) continue;

      const outcome = await deliver(discordUserId, {
        content: renderMidtermNotice(entry.kind, midterm),
      });

      if (outcome === 'failed') {
        // The delivery row stays pending, which is what says the message was
        // owed, and the entry is asked for again.
        throw new Error(`writing to ${discordUserId} about exam ${midterm.midtermId} failed`);
      }

      if (outcome === 'blocked') {
        await feed.savePreferences(discordUserId, { directMessageOptOut: true });
      }
      // A blocked message is recorded as well, because it is not going to
      // arrive on a second attempt either.
      await deliveries.recordPosted(intended.deliveryId, null);
    }
  }

  /** The exam an entry carries, or nothing when the entry is not about one. */
  function midtermOf(entry: OutboxEntry): Midterm | null {
    const midterm = outboxMidterm(entry);
    if (!midterm) console.log(`outbox entry ${entry.outboxId} of kind ${entry.kind} carries no exam`);
    return midterm;
  }

  async function handle(entry: OutboxEntry): Promise<void> {
    const midterm = midtermOf(entry);
    if (!midterm) return;
    await tellFollowers(entry, midterm);
  }

  return {
    'midterm.confirmed': handle,
    'midterm.updated': handle,
    'midterm.cancelled': handle,
  };
}
