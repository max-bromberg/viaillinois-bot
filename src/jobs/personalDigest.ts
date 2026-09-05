import { NO_OUTBOX_ENTRY, userTarget, type Deliveries } from '../delivery/deliveries.ts';
import { campusDatePlus } from '../render/campusTime.ts';
import { renderPersonalDigest } from '../render/digest.ts';
import type { DirectMessageDelivery } from '../discord/directMessages.ts';
import type { FeedStore } from '../feed/store.ts';
import type { JobHour } from './scheduler.ts';
import type { ViaClient } from '../via/client.ts';

/**
 * The weekly digest a person receives by direct message.
 *
 * It runs every campus hour and writes to the people whose chosen day and hour
 * this is, which is what lets one job serve a hundred people who each picked a
 * different morning. The week it covers begins on the day it is sent rather
 * than on a Sunday, because somebody who asked for their digest on a Wednesday
 * is asking what is coming up, not what happened on Monday.
 *
 * The listing asks for no internal events. A digest is a list of what a
 * person can turn up to, and an event an organization marked internal is
 * announced to that organization's own members through the channels its server
 * bound rather than in a message about the whole week.
 *
 * Three rules from the design are here. Every message goes through Deliveries
 * first, keyed by the person and the day, so an hour run twice writes once.
 * Every message ends with the way to stop it, which the renderer does. And a
 * person who has closed their direct messages has answered: the bot switches
 * their direct messages off and leaves them alone until they turn them back
 * on, rather than writing every week and failing every week.
 */

/** How far ahead a digest looks, which is the coming week. */
export const DIGEST_DAYS = 6;

/** How many events one digest lists at most. */
export const DIGEST_LIMIT = 100;

/** What a delivery of a digest is for, which is one person and one week. */
export function personalDigestPurpose(day: string): string {
  return `digest:${day}`;
}

export interface PersonalDigestJobOptions {
  feed: FeedStore;
  deliveries: Deliveries;
  via: Pick<ViaClient, 'listEvents'>;
  deliver: DirectMessageDelivery;
}

/** What one run did, which is what the log reads. */
export interface PersonalDigestResult {
  sent: number;
  /** How many people were passed over, because they follow nothing. */
  skipped: number;
  /** How many people turned out not to accept direct messages. */
  blocked: number;
  /** How many digests are still owed, each of them logged. */
  failed: number;
}

export interface PersonalDigestJob {
  run(hour: JobHour): Promise<PersonalDigestResult>;
}

export function createPersonalDigestJob(options: PersonalDigestJobOptions): PersonalDigestJob {
  const { feed, deliveries, via, deliver } = options;

  return {
    async run(hour: JobHour): Promise<PersonalDigestResult> {
      const result: PersonalDigestResult = { sent: 0, skipped: 0, blocked: 0, failed: 0 };
      const due = await feed.digestDueAt(hour.dayOfWeek, hour.hour);

      for (const person of due) {
        try {
          const follows = await feed.follows(person.discordUserId);
          // Somebody who follows nothing has asked for nothing, and a digest of
          // an empty campus is a message nobody wanted.
          if (!follows.all && follows.rsoIds.length === 0) {
            result.skipped += 1;
            continue;
          }

          const intended = await deliveries.intend({
            outboxId: NO_OUTBOX_ENTRY,
            target: userTarget(person.discordUserId),
            purpose: personalDigestPurpose(hour.day),
            kind: 'direct_message',
          });
          // Somebody, possibly this job before it fell over, has already
          // written to this person about this week.
          if (!intended.isNew) {
            result.skipped += 1;
            continue;
          }

          const page = await via.listEvents({
            ...(follows.all ? {} : { rsoIds: follows.rsoIds }),
            from: hour.day,
            to: campusDatePlus(DIGEST_DAYS, hour.at),
            limit: DIGEST_LIMIT,
          });

          const outcome = await deliver(person.discordUserId, {
            content: renderPersonalDigest({ weekStart: hour.day, events: page.events }),
          });

          if (outcome === 'failed') {
            // The row stays pending, which is what says the message is owed.
            result.failed += 1;
            continue;
          }

          if (outcome === 'blocked') {
            await feed.savePreferences(person.discordUserId, { directMessageOptOut: true });
            result.blocked += 1;
          } else {
            result.sent += 1;
          }
          // A blocked message is recorded as well, because it is not going to
          // arrive on a second attempt either.
          await deliveries.recordPosted(intended.deliveryId, null);
        } catch (err) {
          result.failed += 1;
          console.error(
            `sending the weekly digest to ${person.discordUserId} failed:`,
            (err as Error).message,
          );
        }
      }

      if (result.sent > 0 || result.blocked > 0 || result.failed > 0) {
        console.log(`the weekly digest went to ${result.sent} people for the week of ${hour.day}`);
      }
      return result;
    },
  };
}
