import { campusStamp } from '../render/campusTime.ts';
import { encodeProposal } from '../scheduler/proposal.ts';
import { isMissingAccess, isMissingMessage, type DiscordActions, type Reply } from '../discord/adapter.ts';
import type { PolledCandidate, SchedulerPoll, SchedulerPolls } from '../scheduler/polls.ts';
import type { JobHour } from './scheduler.ts';

/**
 * Closing the polls the scheduler opened.
 *
 * Discord counts the votes and closes the poll itself, and it sends no event
 * of its own to say so. The one signal near it is the message being edited
 * when the counts are finalized, and seeing that would mean asking the gateway
 * for every message in every server the bot is in, which is a great deal of
 * other people's conversation to receive in order to learn one thing about one
 * message. So the bot writes down the hour each poll runs to and comes back
 * then, which needs no intent at all and survives a restart in the middle of a
 * poll.
 *
 * The result is posted once. A poll whose channel has been deleted is written
 * off rather than read again for ever, and a poll whose counts Discord has not
 * finalized yet is left for the next pass.
 */

export interface PollClosingOptions {
  polls: SchedulerPolls;
  actions: Pick<DiscordActions, 'postMessage' | 'readPoll'>;
  now?: () => Date;
}

export interface PollClosingJob {
  /** Close every poll whose time is up, and say how many results were posted. */
  run(hour: JobHour): Promise<number>;
}

/** The evening a poll chose, or null when nobody answered it. */
export function winnerOf(
  poll: SchedulerPoll,
  answers: readonly { text: string; votes: number }[],
): { candidate: PolledCandidate; votes: number } | null {
  let best: { candidate: PolledCandidate; votes: number } | null = null;

  answers.forEach((answer, index) => {
    // Discord holds the answers in the order they were posted, and the text is
    // what the bot wrote, so either finds the evening the answer stood for.
    const candidate = poll.candidates.find(one => one.answer === answer.text)
      ?? poll.candidates[index];
    if (!candidate || answer.votes <= 0) return;
    if (!best || answer.votes > best.votes) best = { candidate, votes: answer.votes };
  });

  return best;
}

/** The button that accepts one evening, which is what the result carries. */
function acceptButton(poll: SchedulerPoll, candidate: PolledCandidate, label: string) {
  return {
    kind: 'button' as const,
    style: 'primary' as const,
    label,
    customId: encodeProposal({
      ask: poll.ask,
      startTime: candidate.startTime,
      locationId: candidate.locationId,
      intervalWeeks: candidate.intervalWeeks,
      until: candidate.until,
      score: candidate.score,
    }),
  };
}

/** What the channel reads when the poll has closed. */
export function renderPollResult(
  poll: SchedulerPoll,
  won: { candidate: PolledCandidate; votes: number } | null,
): Reply {
  if (!won) {
    const first = poll.candidates[0]!;
    return {
      content: [
        'The poll about when to meet has closed. Nobody answered it, so nothing has been chosen.',
        '',
        `VIA recommended ${first.answer} most highly. A board member can accept that below, or run the schedule command again for the whole answer.`,
      ].join('\n'),
      components: [{
        kind: 'row',
        components: [acceptButton(poll, first, 'Accept what VIA recommended')],
      }],
    };
  }

  return {
    content: [
      'The poll about when to meet has closed.',
      '',
      `**${won.candidate.answer}** won, with ${won.votes} ${won.votes === 1 ? 'vote' : 'votes'}.`,
      '',
      'A board member can create the repeat below. VIA checks the recommendation again first, so anything that has changed since the poll opened is shown before anything is created.',
    ].join('\n'),
    components: [{
      kind: 'row',
      components: [acceptButton(poll, won.candidate, 'Create this repeat')],
    }],
  };
}

export function createPollClosingJob(options: PollClosingOptions): PollClosingJob {
  const { polls, actions, now = () => new Date() } = options;

  return {
    async run(hour: JobHour): Promise<number> {
      const due = await polls.due(campusStamp(hour.at));
      let posted = 0;

      for (const poll of due) {
        let results;
        try {
          results = await actions.readPoll(poll.channelId, poll.messageId);
        } catch (err) {
          if (!isMissingAccess(err) && !isMissingMessage(err)) {
            // Discord is having a moment. The poll stays open, and the next
            // pass reads it again.
            console.error(`reading the poll in server ${poll.guildId} failed:`, (err as Error).message);
            continue;
          }
          // The channel or the message is gone, so there is nowhere to post
          // the result and nothing anybody has to put right.
          console.log(`the poll in server ${poll.guildId} is no longer there`);
          await polls.recordClosed(poll.pollId, campusStamp(now()));
          continue;
        }

        if (results === null) {
          await polls.recordClosed(poll.pollId, campusStamp(now()));
          continue;
        }
        // Discord finalizes the counts shortly after a poll ends, and a result
        // posted before then would be a running total presented as an answer.
        if (!results.finalized) continue;

        try {
          await actions.postMessage(poll.channelId, renderPollResult(poll, winnerOf(poll, results.answers)));
        } catch (err) {
          if (!isMissingAccess(err)) throw err;
          await polls.recordClosed(poll.pollId, campusStamp(now()));
          continue;
        }

        await polls.recordClosed(poll.pollId, campusStamp(now()));
        posted += 1;
      }

      return posted;
    },
  };
}
