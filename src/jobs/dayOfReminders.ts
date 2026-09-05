import { NO_OUTBOX_ENTRY, channelTarget, type Deliveries } from '../delivery/deliveries.ts';
import { createSpread, type SpreadOptions } from '../delivery/spread.ts';
import { channelFor, noChannelReason } from '../guilds/channels.ts';
import { followedEvents } from '../announce/followedEvents.ts';
import { campusToday, toInstant } from '../render/campusTime.ts';
import { renderDayOfReminder } from '../render/digest.ts';
import { isMissingAccess, type DiscordActions } from '../discord/adapter.ts';
import type { FeatureDisabler } from '../guilds/disable.ts';
import type { GuildStore } from '../guilds/store.ts';
import type { JobHour } from './scheduler.ts';
import type { ViaClient, ViaEvent } from '../via/client.ts';

/**
 * The reminder a server posts before each event of the day.
 *
 * It runs on every pass rather than once an hour, because the lead time a
 * server chooses is a number of minutes and an hour of rounding would make an
 * hour's notice mean anything between one hour and two. What makes that safe
 * is that an event is only ever reminded about once: the delivery row keyed by
 * the channel and the event is what says so, so a pass every few minutes
 * posts nothing it has posted before.
 *
 * Two events are passed over. One that has already begun, because a reminder
 * after the fact is not a reminder, and one that has been cancelled, because
 * the change announcement has already said so.
 */

/** The feature a server switches on to receive the day of reminders. */
export const DAYOF_FEATURE = 'announce.dayof';

/** What a delivery of a reminder is for, which is one server and one event. */
export function dayOfPurpose(eventId: number): string {
  return `dayof:${eventId}`;
}

export interface DayOfReminderJobOptions extends SpreadOptions {
  guilds: GuildStore;
  deliveries: Deliveries;
  actions: DiscordActions;
  via: Pick<ViaClient, 'listEvents'>;
  disable: FeatureDisabler;
  /** The public address of the website, which the button on the reminder opens. */
  websiteUrl: string;
}

/** What one pass did, which is what the log reads. */
export interface DayOfReminderResult {
  posted: number;
  /** How many servers failed, each of them logged. */
  failed: number;
}

export interface DayOfReminderJob {
  run(hour: JobHour): Promise<DayOfReminderResult>;
}

export function createDayOfReminderJob(options: DayOfReminderJobOptions): DayOfReminderJob {
  const { guilds, deliveries, actions, via, disable, websiteUrl } = options;
  /**
   * The pause between one server and the next, from section 9 of the design:
   * the proactive jobs spread their posts rather than firing every server's
   * in the same second.
   */
  const spread = createSpread(options);

  /** Whether the lead time has passed and the event has not started. */
  function isDue(event: ViaEvent, at: Date, leadMinutes: number): boolean {
    if (event.cancelledAt !== null || event.isPrivate) return false;
    const start = toInstant(event.startTime);
    if (!start) return false;
    const due = start.getTime() - leadMinutes * 60_000;
    return due <= at.getTime() && at.getTime() < start.getTime();
  }

  return {
    async run(hour: JobHour): Promise<DayOfReminderResult> {
      const result: DayOfReminderResult = { posted: 0, failed: 0 };
      const today = campusToday(hour.at);

      for (const [index, installation] of (await guilds.listInstallations()).entries()) {
        const guildId = installation.guildId;
        try {
          await spread(index);
          const channelId = await channelFor({ guilds, disable }, guildId, DAYOF_FEATURE, 'reminders');
          if (!channelId) continue;

          const events = await followedEvents({ guilds, via }, installation, {
            from: today,
            to: today,
          });

          for (const event of events) {
            if (!isDue(event, hour.at, installation.reminderLeadMinutes)) continue;

            const intended = await deliveries.intend({
              outboxId: NO_OUTBOX_ENTRY,
              target: channelTarget(channelId),
              purpose: dayOfPurpose(event.eventId),
              kind: 'message',
            });
            // A row that carries the moment it was posted is a reminder
            // that has been posted, and a row that carries none is one that
            // is still owed.
            if (!intended.isNew && intended.deliveredAt !== null) continue;

            let messageId: string;
            try {
              messageId = await actions.postMessage(channelId, renderDayOfReminder(event, { websiteUrl }));
            } catch (err) {
              if (!isMissingAccess(err)) throw err;
              // There is nowhere left to post, so the intention goes with the
              // feature rather than staying owed for ever.
              await deliveries.abandon(intended.deliveryId);
              await disable.disable(guildId, DAYOF_FEATURE, noChannelReason('reminders'));
              break;
            }

            await deliveries.recordPosted(intended.deliveryId, messageId);
            result.posted += 1;
          }
        } catch (err) {
          result.failed += 1;
          console.error(`posting the reminders in server ${guildId} failed:`, (err as Error).message);
        }
      }

      if (result.posted > 0) console.log(`${result.posted} day of reminders were posted`);
      return result;
    },
  };
}
