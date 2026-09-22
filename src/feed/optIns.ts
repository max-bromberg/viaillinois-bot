import { campusStamp, toInstant } from '../render/campusTime.ts';
import type { FeedStore } from './store.ts';
import type { OutboxHandlers } from '../outbox/consumer.ts';
import type { OutboxEntry, ViaClient } from '../via/client.ts';

/**
 * The two choices a person can now make on the website as well as here.
 *
 * Following an organization and asking for a reminder belong to the bot,
 * because the bot is what sends the message, and the website cannot reach the
 * tables they live in. So a choice made there arrives through the outbox and
 * is applied here, and what the bot holds afterwards is reported back, so that
 * the website shows the same answer whichever side the choice was made on.
 *
 * A reminder is the one that takes work. The website knows that somebody wants
 * reminding and cannot know when: the lead is the person's own preference,
 * held here, and the start is the event's, held by the web platform. So the
 * bot reads both and works the moment out itself.
 */

export interface OptInReporterOptions {
  feed: FeedStore;
  via: ViaClient;
}

export function createOptInReporter({ feed, via }: OptInReporterOptions) {
  /**
   * Say everything this person has asked to be told about.
   *
   * The whole set rather than the change, for the same reason the binding
   * report is the state rather than the change: a report that left something
   * out could never say it had stopped being followed.
   *
   * Following every organization is a preference rather than a list, so it is
   * reported as the empty list it is: the website offers one organization at a
   * time and has nothing to draw for "all of them", and saying otherwise would
   * show somebody following twenty organizations they never chose one by one.
   */
  async function report(discordUserId: string): Promise<void> {
    try {
      const [follows, reminders] = await Promise.all([
        feed.follows(discordUserId),
        feed.listReminders(discordUserId),
      ]);
      await via.reportOptIns({
        discordUserId,
        following: [...follows.rsoIds].sort((a, b) => a - b),
        reminders: reminders.map(row => row.eventId).sort((a, b) => a - b),
      });
    } catch (err) {
      /*
       * The web platform being away is not a reason for the command that
       * triggered this to fail in front of the person running it. What they
       * chose is already recorded here, which is what makes it happen, and the
       * mirror catches up the next time anything reports.
       */
      console.log(`reporting what ${discordUserId} follows failed: ${(err as Error).message}`);
    }
  }

  return { report };
}

export interface OptInHandlerOptions {
  feed: FeedStore;
  via: ViaClient;
}

export function createOptInHandlers(
  { feed, via }: OptInHandlerOptions,
): OutboxHandlers {
  const reporter = createOptInReporter({ feed, via });

  /**
   * When a reminder about this event is due, or nothing where the bot cannot
   * work it out. An event it cannot read has no start time, and a reminder
   * with no time would either never arrive or arrive at once, so the
   * instruction is left rather than guessed at.
   */
  async function reminderDueAt(discordUserId: string, eventId: number) {
    const event = await via.getEvent(eventId);
    // The same two helpers the reminder button uses, so a reminder asked for
    // on the website and one asked for on an event card are due at the same
    // moment. toInstant reads a campus wall clock reading as the instant it
    // names, and campusStamp writes an instant back as one.
    const start = event ? toInstant(event.startTime) : null;
    if (!start) return null;

    const { reminderLeadMinutes } = await feed.preferences(discordUserId);
    return campusStamp(new Date(start.getTime() - reminderLeadMinutes * 60_000));
  }

  return {
    async 'optin.changed'(entry: OutboxEntry): Promise<void> {
      const payload = (entry.payload ?? {}) as Record<string, unknown>;
      const discordUserId = String(payload.discord_user_id ?? '').trim();
      const subject = String(payload.subject ?? '');
      const subjectId = Number(payload.subject_id);
      const wanted = payload.wanted === true;

      if (!discordUserId || !Number.isInteger(subjectId)) {
        console.log(`outbox entry ${entry.outboxId} carries no person or no subject`);
        return;
      }

      if (subject === 'rso') {
        if (wanted) await feed.follow(discordUserId, subjectId);
        else await feed.unfollow(discordUserId, subjectId);
      } else if (subject === 'event') {
        if (wanted) {
          const remindAt = await reminderDueAt(discordUserId, subjectId);
          if (!remindAt) {
            console.log(`no reminder was set for event ${subjectId}, which could not be read`);
            return;
          }
          await feed.addReminder(discordUserId, subjectId, remindAt);
        } else {
          await feed.removeReminderFor(discordUserId, subjectId);
        }
      } else {
        // A subject this build does not know is one a later build writes, and
        // moving past it is what the consumer does with every entry it cannot
        // handle rather than stopping the whole queue on it.
        console.log(`outbox entry ${entry.outboxId} names the subject ${subject}, which is not one of these`);
        return;
      }

      // Say what is held now, so the website's mirror agrees with the record
      // even where both sides were changed at nearly the same moment.
      await reporter.report(discordUserId);
    },
  };
}
