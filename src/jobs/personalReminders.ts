import { NO_OUTBOX_ENTRY, userTarget, type Deliveries } from '../delivery/deliveries.ts';
import { campusStamp, toInstant } from '../render/campusTime.ts';
import { renderPersonalReminder } from '../render/digest.ts';
import type { DirectMessageDelivery } from '../discord/directMessages.ts';
import type { FeedStore } from '../feed/store.ts';
import type { JobHour } from './scheduler.ts';
import type { ViaClient } from '../via/client.ts';

/**
 * The reminders a person asked for from an event card.
 *
 * This job runs on every pass rather than once an hour, because a reminder is
 * due at a moment somebody chose and an hour of rounding would make an hour's
 * notice mean anything between one hour and two. Everything it owes is written
 * down in Reminders, so a bot that was down for an hour sends what came due
 * while it was away as soon as it returns, and never twice: a reminder is
 * forgotten the moment it has been dealt with.
 *
 * Three reminders are dropped rather than sent. One for an event VIA no longer
 * has, because there is nothing to be reminded of. One for an event that has
 * already begun, because a reminder after the fact is not a reminder. And one
 * for somebody who has turned their direct messages off, because the bot is
 * not to write to them at all; pressing Remind me again after turning them
 * back on is what asks for it once more.
 */

/** What a delivery of a reminder is for, which is one person and one event. */
export function reminderPurpose(eventId: number): string {
  return `reminder:${eventId}`;
}

export interface PersonalReminderJobOptions {
  feed: FeedStore;
  deliveries: Deliveries;
  via: Pick<ViaClient, 'getEvent'>;
  deliver: DirectMessageDelivery;
}

/** What one pass did, which is what the log reads. */
export interface PersonalReminderResult {
  sent: number;
  /** How many reminders were forgotten without a message being sent. */
  dropped: number;
  /** How many people turned out not to accept direct messages. */
  blocked: number;
  /** How many reminders failed to send, each of them logged. */
  failed: number;
}

export interface PersonalReminderJob {
  run(hour: JobHour): Promise<PersonalReminderResult>;
}

export function createPersonalReminderJob(options: PersonalReminderJobOptions): PersonalReminderJob {
  const { feed, deliveries, via, deliver } = options;

  return {
    async run(hour: JobHour): Promise<PersonalReminderResult> {
      const result: PersonalReminderResult = { sent: 0, dropped: 0, blocked: 0, failed: 0 };
      const due = await feed.dueReminders(campusStamp(hour.at));

      for (const reminder of due) {
        try {
          // The event is read as the person who asked for the reminder, so a
          // member of an organization is still reminded of a meeting it marked
          // internal, which is the web platform's decision rather than one
          // made here.
          const event = await via.getEvent(reminder.eventId, reminder.discordUserId);
          const start = event ? toInstant(event.startTime) : null;

          if (!event || !start || start.getTime() <= hour.at.getTime() || event.cancelledAt !== null) {
            await feed.removeReminder(reminder.reminderId);
            result.dropped += 1;
            continue;
          }

          const preferences = await feed.preferences(reminder.discordUserId);
          if (preferences.directMessageOptOut) {
            await feed.removeReminder(reminder.reminderId);
            result.dropped += 1;
            continue;
          }

          const intended = await deliveries.intend({
            outboxId: NO_OUTBOX_ENTRY,
            target: userTarget(reminder.discordUserId),
            purpose: reminderPurpose(reminder.eventId),
            kind: 'direct_message',
          });
          if (!intended.isNew) {
            await feed.removeReminder(reminder.reminderId);
            result.dropped += 1;
            continue;
          }

          const outcome = await deliver(reminder.discordUserId, {
            content: renderPersonalReminder(event, preferences.reminderLeadMinutes),
          });

          if (outcome === 'failed') {
            // The delivery row stays pending, which is what says the message
            // was owed, and the reminder goes so that the next pass does not
            // spend the whole afternoon on a message Discord will not take.
            await feed.removeReminder(reminder.reminderId);
            result.failed += 1;
            continue;
          }

          if (outcome === 'blocked') {
            await feed.savePreferences(reminder.discordUserId, { directMessageOptOut: true });
            result.blocked += 1;
          } else {
            result.sent += 1;
          }
          await deliveries.recordPosted(intended.deliveryId, null);
          await feed.removeReminder(reminder.reminderId);
        } catch (err) {
          result.failed += 1;
          console.error(
            `sending the reminder for event ${reminder.eventId} to ${reminder.discordUserId} failed:`,
            (err as Error).message,
          );
        }
      }

      if (result.sent > 0) console.log(`${result.sent} reminders went out`);
      return result;
    },
  };
}
