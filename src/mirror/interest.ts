import type { EventMirrors } from './eventMirrors.ts';
import type { InterestMarks } from '../feed/interestMarks.ts';
import type { ScheduledEventInterest } from '../discord/adapter.ts';
import type { ViaClient } from '../via/client.ts';

/**
 * Interest a member left on a scheduled event.
 *
 * Discord's own control on a scheduled event is the one every member already
 * knows, so it is what the bot listens to. The gateway names the scheduled
 * event, and Event_Mirrors turns that into the VIA event it mirrors, which is
 * what the interest is recorded against.
 *
 * How it is recorded follows section 10 of the design. A linked person is the
 * acting person, and the web platform records their interest by NetID. Anybody
 * else is named by their Discord identifier, and the web platform records a
 * salted hash of it, so the count that replaces RSVPs is honest and nobody can
 * reverse it. The salting is the web platform's, and the bot stores neither
 * the NetID nor the hash.
 *
 * What the bot does store is the mark itself, in Interest_Marks, keyed by the
 * event and the Discord account. Neither a NetID nor a salted hash can be
 * turned back into somebody to write to, and the feedback request the morning
 * after has to reach the people who marked interest, so the bot keeps the one
 * fact it already handled. The mark is written only once the web platform has
 * taken the signal, and it is deleted when the interest is withdrawn.
 */

export interface InterestRecorderOptions {
  via: Pick<ViaClient, 'getLink' | 'setInterest'>;
  mirrors: EventMirrors;
  /** Who marked interest, by Discord account, which is who the morning after asks. */
  marks?: InterestMarks;
}

/** Record one signal, or do nothing when it is about something the bot did not create. */
export type InterestRecorder = (signal: ScheduledEventInterest, interested: boolean) => Promise<void>;

export function createInterestRecorder(options: InterestRecorderOptions): InterestRecorder {
  const { via, mirrors, marks } = options;

  return async function record(signal: ScheduledEventInterest, interested: boolean): Promise<void> {
    if (!signal.guildId || !signal.scheduledEventId || !signal.discordUserId) return;

    try {
      const mirror = await mirrors.byScheduledEvent(signal.guildId, signal.scheduledEventId);
      // A server can have scheduled events of its own, and interest in one of
      // those is nothing to do with VIA.
      if (!mirror) return;

      const link = await via.getLink(signal.discordUserId);
      await via.setInterest(mirror.eventId, link
        ? { interested, actingDiscordUserId: signal.discordUserId }
        : { interested, discordUserId: signal.discordUserId });

      // A person who is not linked yet may link before the morning after, so
      // the mark is kept for them too. What decides whether they are written
      // to is whether they have a VIA account by then.
      if (interested) await marks?.mark(mirror.eventId, signal.discordUserId);
      else await marks?.unmark(mirror.eventId, signal.discordUserId);
    } catch (err) {
      // One person's interest is not worth a failure that reaches anybody.
      // The next time they press the control it is recorded.
      console.error('recording interest in a scheduled event failed:', (err as Error).message);
    }
  };
}
