import { NO_OUTBOX_ENTRY, channelTarget, type Deliveries } from '../delivery/deliveries.ts';
import { channelFor, noChannelReason } from '../guilds/channels.ts';
import { campusDatePlus } from '../render/campusTime.ts';
import { renderExamsThisWeek } from '../render/campus.ts';
import { isMissingAccess, type DiscordActions } from '../discord/adapter.ts';
import type { FeatureDisabler } from '../guilds/disable.ts';
import type { GuildStore } from '../guilds/store.ts';
import type { JobHour } from './scheduler.ts';
import type { Midterm, ViaClient } from '../via/client.ts';

/**
 * The exams of the coming week, posted in a server.
 *
 * It is the weekly digest for exams rather than for events, so it follows the
 * digest in every respect a server manager can see: it goes out on the day and
 * at the hour the server chose for its digest, it is one message grouped by
 * day rather than one message per exam, and it goes through Deliveries keyed
 * by the week, so an hour run twice posts once and a bot that was down over
 * the hour posts when it returns.
 *
 * Only confirmed exams are listed. An exam whose time nobody has confirmed is
 * a date that may still move, and a channel that a whole server reads is the
 * wrong place to publish one.
 *
 * The timing is deliberately the digest's rather than a second choice of its
 * own. A server that wants both gets them together on one evening, and a
 * manager has one answer to give rather than two.
 */

/** The feature a server switches on to receive the exams of the week. */
export const EXAMS_FEATURE = 'announce.exams';

/** How far ahead the message looks, which is the coming week. */
export const EXAM_WEEK_DAYS = 6;

/** What a delivery of an exams message is for, which is one server and one week. */
export function guildExamsPurpose(weekStart: string): string {
  return `exams:${weekStart}`;
}

export interface GuildExamsJobOptions {
  guilds: GuildStore;
  deliveries: Deliveries;
  actions: DiscordActions;
  via: Pick<ViaClient, 'listMidterms'>;
  disable: FeatureDisabler;
}

/** What one run did, which is what the log reads. */
export interface GuildExamsResult {
  posted: number;
  /** How many servers were passed over, because the message was already posted. */
  skipped: number;
  /** How many servers failed, each of them logged. */
  failed: number;
}

export interface GuildExamsJob {
  run(hour: JobHour): Promise<GuildExamsResult>;
}

export function createGuildExamsJob(options: GuildExamsJobOptions): GuildExamsJob {
  const { guilds, deliveries, actions, via, disable } = options;

  return {
    async run(hour: JobHour): Promise<GuildExamsResult> {
      const result: GuildExamsResult = { posted: 0, skipped: 0, failed: 0 };
      const due = await guilds.listInstallationsForDigest(hour.dayOfWeek, hour.hour);

      // The exams of a week are the same list in every server, so they are
      // read once for the run rather than once for each server, and only when
      // some server is actually due.
      let week: Midterm[] | null = null;
      const examsOfTheWeek = async (): Promise<Midterm[]> => {
        if (week === null) {
          const midterms = await via.listMidterms({
            from: hour.day,
            to: campusDatePlus(EXAM_WEEK_DAYS, hour.at),
          });
          week = midterms.filter(midterm => midterm.status === 'confirmed');
        }
        return week;
      };

      for (const installation of due) {
        const guildId = installation.guildId;
        try {
          const channelId = await channelFor({ guilds, disable }, guildId, EXAMS_FEATURE, 'exams');
          if (!channelId) continue;

          const intended = await deliveries.intend({
            outboxId: NO_OUTBOX_ENTRY,
            target: channelTarget(channelId),
            purpose: guildExamsPurpose(hour.day),
            kind: 'message',
          });
          if (!intended.isNew) {
            result.skipped += 1;
            continue;
          }

          const midterms = await examsOfTheWeek();

          let messageId: string;
          try {
            messageId = await actions.postMessage(
              channelId,
              renderExamsThisWeek({ weekStart: hour.day, midterms }),
            );
          } catch (err) {
            if (!isMissingAccess(err)) throw err;
            // The channel the server bound has been deleted or closed to the
            // bot, which is the same fault as unbinding it.
            await disable.disable(guildId, EXAMS_FEATURE, noChannelReason('exams'));
            continue;
          }

          await deliveries.recordPosted(intended.deliveryId, messageId);
          result.posted += 1;
        } catch (err) {
          result.failed += 1;
          console.error(`posting the exams of the week in server ${guildId} failed:`, (err as Error).message);
        }
      }

      if (result.posted > 0) {
        console.log(`the exams of the week were posted in ${result.posted} servers`);
      }
      return result;
    },
  };
}
