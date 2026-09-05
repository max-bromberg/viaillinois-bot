import { NO_OUTBOX_ENTRY, userTarget, type Deliveries } from '../delivery/deliveries.ts';
import { campusDatePlus, toInstant } from '../render/campusTime.ts';
import { renderExamReminder } from '../render/campus.ts';
import type { DirectMessageDelivery } from '../discord/directMessages.ts';
import type { FeedStore } from '../feed/store.ts';
import type { JobHour } from './scheduler.ts';
import type { ViaClient } from '../via/client.ts';

/**
 * The reminder before an exam of a course somebody added.
 *
 * This job runs on every pass rather than once an hour, for the same reason
 * the personal reminders do: a reminder is due at a moment the person's lead
 * time decides, and an hour of rounding would make an hour's notice mean
 * anything between one hour and two.
 *
 * Nothing is written down when a reminder is asked for, because nobody asks
 * for one: a person adds a course, and every confirmed exam of that course is
 * a reminder they are owed. What makes that safe to run every few minutes is
 * Deliveries, keyed by the person and the exam, so an exam reminds a person
 * once however many passes see it.
 *
 * Three exams are passed over rather than sent. One whose time nobody has
 * confirmed, because a date that may still move is not something to be woken
 * up for. One that has already begun, because a reminder after the fact is not
 * a reminder. And one for somebody who has turned their direct messages off,
 * because the bot is not to write to them at all.
 */

/** What a delivery of an exam reminder is for, which is one person and one exam. */
export function examReminderPurpose(midtermId: number): string {
  return `exam:${midtermId}`;
}

/**
 * How far ahead the job looks for exams. The longest lead time the settings
 * panel offers is a day, so two days covers every reminder that could be due
 * on this pass with a day to spare.
 */
export const EXAM_LOOKAHEAD_DAYS = 2;

export interface ExamReminderJobOptions {
  feed: FeedStore;
  deliveries: Deliveries;
  via: Pick<ViaClient, 'listMidterms' | 'getLink'>;
  deliver: DirectMessageDelivery;
}

/** What one pass did, which is what the log reads. */
export interface ExamReminderResult {
  sent: number;
  /** How many people had already been written to about this exam. */
  skipped: number;
  /** How many people turned out not to accept direct messages. */
  blocked: number;
  /** How many reminders failed to send, each of them logged. */
  failed: number;
}

export interface ExamReminderJob {
  run(hour: JobHour): Promise<ExamReminderResult>;
}

export function createExamReminderJob(options: ExamReminderJobOptions): ExamReminderJob {
  const { feed, deliveries, via, deliver } = options;

  return {
    async run(hour: JobHour): Promise<ExamReminderResult> {
      const result: ExamReminderResult = { sent: 0, skipped: 0, blocked: 0, failed: 0 };

      // One call covers every course, because the exams of the next two days
      // across the whole of ECE are a shorter list than the courses the people
      // in one server are taking.
      const midterms = await via.listMidterms({
        from: hour.day,
        to: campusDatePlus(EXAM_LOOKAHEAD_DAYS, hour.at),
      });

      for (const midterm of midterms) {
        const start = toInstant(midterm.startTime);
        if (midterm.status !== 'confirmed' || !start || start.getTime() <= hour.at.getTime()) continue;

        const followers = await feed.courseFollowers(midterm.courseCode);
        for (const discordUserId of followers) {
          try {
            const preferences = await feed.preferences(discordUserId);
            if (preferences.directMessageOptOut) continue;

            // Section 10 of the design: the bot writes only to linked people.
            // A course left behind by a link the bot never heard go away
            // would otherwise become a message nobody asked for.
            if (!(await via.getLink(discordUserId))) {
              result.skipped += 1;
              continue;
            }

            const dueAt = start.getTime() - preferences.reminderLeadMinutes * 60_000;
            if (hour.at.getTime() < dueAt) continue;

            const intended = await deliveries.intend({
              outboxId: NO_OUTBOX_ENTRY,
              target: userTarget(discordUserId),
              purpose: examReminderPurpose(midterm.midtermId),
              kind: 'direct_message',
            });
            // A row that carries the moment it was posted is a message that
            // has arrived. A row that carries none was written and never sent,
            // which is a message this person is still owed.
            if (!intended.isNew && intended.deliveredAt !== null) {
              result.skipped += 1;
              continue;
            }

            const outcome = await deliver(discordUserId, { content: renderExamReminder(midterm) });

            if (outcome === 'failed') {
              // The row stays pending, which is what says the message is owed.
              result.failed += 1;
              continue;
            }

            if (outcome === 'blocked') {
              await feed.savePreferences(discordUserId, { directMessageOptOut: true });
              result.blocked += 1;
            } else {
              result.sent += 1;
            }
            await deliveries.recordPosted(intended.deliveryId, null);
          } catch (err) {
            result.failed += 1;
            console.error(
              `sending the reminder for exam ${midterm.midtermId} to ${discordUserId} failed:`,
              (err as Error).message,
            );
          }
        }
      }

      if (result.sent > 0) console.log(`${result.sent} exam reminders went out`);
      return result;
    },
  };
}
