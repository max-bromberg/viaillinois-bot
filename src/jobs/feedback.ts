import { NO_OUTBOX_ENTRY, userTarget, type Deliveries } from '../delivery/deliveries.ts';
import { campusDatePlus, campusToday, toInstant } from '../render/campusTime.ts';
import { renderFeedbackRequest } from '../render/feedback.ts';
import { ViaError, type ViaClient, type ViaEvent } from '../via/client.ts';
import type { DirectMessageDelivery } from '../discord/directMessages.ts';
import type { FeedStore } from '../feed/store.ts';
import type { GuildStore } from '../guilds/store.ts';
import type { InterestMarks } from '../feed/interestMarks.ts';
import type { JobHour } from './scheduler.ts';

/**
 * The feedback request, the morning after an event.
 *
 * Section 6.4 of the design: a linked person who marked interest in an event
 * or asked to be reminded of it receives one direct message the morning after
 * it, with five buttons and a way to stop being asked. Decision 3 in section
 * 14 settles who that is, and it is the two signals the bot already holds,
 * until check in exists and attendance replaces them.
 *
 * Who to ask is a question the bot answers from its own tables rather than
 * from the web platform. The web platform holds interest by NetID and by a
 * salted hash, neither of which can be turned into a Discord account to write
 * to, and section 7 forbids the bot from holding a NetID at all. So the bot
 * writes down the marks it forwards, in Interest_Marks, and reads them back
 * here beside the reminders that are still outstanding.
 *
 * Four things stop a message being sent, and each of them is a way of not
 * asking somebody something twice. The person's own feedback switch, which the
 * message itself can flip. The person's direct message switch, because the bot
 * is then not to write to them at all. The switch on a server bound to the
 * organization whose event it is, which is how a board says its events do not
 * collect feedback. And Deliveries, keyed by the person and the event, which
 * is what makes the message happen once whatever the job does afterwards.
 *
 * The marks on an event go once the event has been dealt with, whether
 * anybody was asked or not. They have served their one purpose by then, and
 * keeping them would mean re-reading every event of the term every morning.
 */

/** The feature a server switches off to stop its organization's events collecting feedback. */
export const FEEDBACK_FEATURE = 'feedback.request';

/**
 * The campus hour the message is sent at. Nine in the morning is late enough
 * that nobody is woken by it and early enough that the event is still the day
 * before rather than something that happened a while ago.
 */
export const FEEDBACK_HOUR = 9;

/** What a delivery of a feedback request is for, which is one person and one event. */
export function feedbackPurpose(eventId: number): string {
  return `feedback:${eventId}`;
}

export interface FeedbackJobOptions {
  feed: FeedStore;
  marks: InterestMarks;
  guilds: GuildStore;
  deliveries: Deliveries;
  via: Pick<ViaClient, 'getEvent' | 'getLink'>;
  deliver: DirectMessageDelivery;
  /** The campus hour to ask at, injected so that a test can move it. */
  hour?: number;
}

/** What one run did, which is what the log reads. */
export interface FeedbackResult {
  /** How many events were asked about. */
  events: number;
  sent: number;
  /** How many people were passed over, for a switch, a link or a message already sent. */
  skipped: number;
  /** How many people turned out not to accept direct messages. */
  blocked: number;
  /** How many messages failed to send, each of them logged. */
  failed: number;
}

export interface FeedbackJob {
  run(hour: JobHour): Promise<FeedbackResult>;
}

export function createFeedbackJob(options: FeedbackJobOptions): FeedbackJob {
  const { feed, marks, guilds, deliveries, via, deliver, hour: askHour = FEEDBACK_HOUR } = options;

  /**
   * The event, read as somebody who is allowed to see it.
   *
   * Most events are public, so the first read is made as nobody and answers
   * for almost every event there is. An event an organization marked internal
   * is answered only for a member of that organization, and the people about
   * to be asked are exactly the people who marked interest in it, so one of
   * them can see it. A read that refuses is a person the web platform no
   * longer knows, which the next candidate covers.
   */
  async function readEvent(eventId: number, people: readonly string[]): Promise<ViaEvent | null> {
    const readers: (string | undefined)[] = [undefined, ...people];
    for (const reader of readers) {
      try {
        const event = await via.getEvent(eventId, reader);
        if (event) return event;
      } catch (err) {
        if (!(err instanceof ViaError)) throw err;
      }
    }
    return null;
  }

  /**
   * Whether a server that speaks for this organization has switched feedback
   * off. Only a server bound to the one organization speaks for it: a
   * community server that follows it has its own channels to decide about and
   * no say over what the organization collects.
   */
  async function switchedOff(rsoId: number): Promise<boolean> {
    const servers = await guilds.listGuildsFollowing(rsoId);
    const bound = servers.filter(server => server.binding === 'rso' && server.rsoId === rsoId);
    for (const server of bound) {
      if (!(await guilds.isFeatureEnabled(server.guildId, FEEDBACK_FEATURE))) return true;
    }
    return false;
  }

  /** Ask one person about one event, and say what became of the message. */
  async function ask(event: ViaEvent, discordUserId: string, result: FeedbackResult): Promise<void> {
    const preferences = await feed.preferences(discordUserId);
    if (preferences.feedbackOptOut || preferences.directMessageOptOut) {
      result.skipped += 1;
      return;
    }

    // Feedback is recorded against a VIA account, so somebody the web platform
    // no longer knows is passed over in silence rather than written to about
    // an answer it would refuse.
    const link = await via.getLink(discordUserId);
    if (!link) {
      result.skipped += 1;
      return;
    }

    const intended = await deliveries.intend({
      outboxId: NO_OUTBOX_ENTRY,
      target: userTarget(discordUserId),
      purpose: feedbackPurpose(event.eventId),
      kind: 'direct_message',
    });
    if (!intended.isNew) {
      result.skipped += 1;
      return;
    }

    const outcome = await deliver(discordUserId, renderFeedbackRequest(event));

    if (outcome === 'failed') {
      // The delivery row stays pending, which is what says the message was
      // owed. Nothing retries it, because a feedback request that turns up
      // days later is worse than one that never turns up at all.
      result.failed += 1;
      return;
    }

    if (outcome === 'blocked') {
      await feed.savePreferences(discordUserId, { directMessageOptOut: true });
      result.blocked += 1;
    } else {
      result.sent += 1;
    }
    await deliveries.recordPosted(intended.deliveryId, null);
  }

  return {
    async run(hour: JobHour): Promise<FeedbackResult> {
      const result: FeedbackResult = { events: 0, sent: 0, skipped: 0, blocked: 0, failed: 0 };
      if (hour.hour !== askHour) return result;

      const yesterday = campusDatePlus(-1, hour.at);

      /** Everybody the bot holds a signal from, by the event it is about. */
      const candidates = new Map<number, Set<string>>();
      const add = (eventId: number, discordUserId: string) => {
        if (!candidates.has(eventId)) candidates.set(eventId, new Set());
        candidates.get(eventId)!.add(discordUserId);
      };

      for (const eventId of await marks.listEvents()) {
        for (const person of await marks.listPeople(eventId)) add(eventId, person);
      }
      for (const reminder of await feed.outstandingReminders()) {
        add(reminder.eventId, reminder.discordUserId);
      }

      for (const [eventId, people] of [...candidates.entries()].sort(([left], [right]) => left - right)) {
        try {
          const asked = [...people].sort();
          const event = await readEvent(eventId, asked);

          // An event VIA no longer has is nothing to ask about, and the marks
          // on it have nothing left to belong to.
          if (!event) {
            await marks.clearEvent(eventId);
            continue;
          }

          const ended = toInstant(event.endTime);
          const day = ended ? campusToday(ended) : null;
          // An event still to come is left where it is, marks and all.
          if (day === null || day > yesterday) continue;

          if (day < yesterday || event.cancelledAt !== null || await switchedOff(event.rsoId)) {
            // Too late to ask, nothing happened, or the organization does not
            // collect feedback. Either way the marks have served their purpose.
            await marks.clearEvent(eventId);
            continue;
          }

          result.events += 1;
          for (const person of asked) await ask(event, person, result);
          await marks.clearEvent(eventId);
        } catch (err) {
          result.failed += 1;
          console.error(
            `asking for feedback on event ${eventId} failed:`,
            (err as Error).message,
          );
        }
      }

      if (result.sent > 0) {
        console.log(`${result.sent} feedback requests went out about ${result.events} events`);
      }
      return result;
    },
  };
}
