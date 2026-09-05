import { describe, it, expect } from 'vitest';
import { createPollClosingJob } from '../../src/jobs/schedulerPolls.ts';
import { TAKE_PREFIX } from '../../src/scheduler/proposal.ts';
import { memorySchedulerPolls } from '../support/polls.ts';
import type { PollResults, Reply } from '../../src/discord/adapter.ts';
import type { NewSchedulerPoll, SchedulerPolls } from '../../src/scheduler/polls.ts';

/**
 * Closing a poll the scheduler opened.
 *
 * Discord sends no event of its own when a poll ends, and the only signal near
 * one is the message being edited when the counts are finalized, which the bot
 * would have to ask for every message in every server to see. So the bot
 * writes down the hour a poll runs to and goes and reads the result then. That
 * needs no intent at all, and it survives a restart in the middle of a poll,
 * which a gateway event would not.
 */

const GUILD = '900000000000000001';
const CHANNEL = '700000000000000001';
const MESSAGE = '800000000000000001';
const ROSA = '204255221017214977';

const CANDIDATES = [
  {
    startTime: '2026-09-16T18:00',
    locationId: 5,
    building: 'Electrical & Computer Eng Bldg',
    roomNumber: '1002',
    score: 91,
    intervalWeeks: 1,
    until: '2026-12-09',
    answer: 'Wednesdays at 6:00 PM, Electrical & Computer Eng',
  },
  {
    startTime: '2026-09-17T19:00',
    locationId: 6,
    building: 'Campus Instructional Facility',
    roomNumber: '3025',
    score: 84,
    intervalWeeks: 1,
    until: '2026-12-10',
    answer: 'Thursdays at 7:00 PM, Campus Instructional Facil',
  },
];

const POLL: NewSchedulerPoll = {
  guildId: GUILD,
  channelId: CHANNEL,
  messageId: MESSAGE,
  rsoId: 1,
  openedBy: ROSA,
  ask: { rsoId: 1, span: 'term', minutes: 60, earliestHour: 18, latestHour: 22 },
  candidates: CANDIDATES,
  closesAt: '2026-09-07 12:00:00',
};

interface Recorded {
  posted: Array<{ channelId: string; reply: Reply }>;
  read: Array<{ channelId: string; messageId: string }>;
}

function job(options: {
  polls: SchedulerPolls;
  results?: PollResults | null;
  failReading?: Error;
}) {
  const recorded: Recorded = { posted: [], read: [] };
  const closing = createPollClosingJob({
    polls: options.polls,
    actions: {
      async postMessage(channelId: string, reply: Reply) {
        recorded.posted.push({ channelId, reply });
        return '800000000000000002';
      },
      async readPoll(channelId: string, messageId: string) {
        recorded.read.push({ channelId, messageId });
        if (options.failReading) throw options.failReading;
        return options.results === undefined
          ? {
            finalized: true,
            answers: [
              { text: CANDIDATES[0]!.answer, votes: 7 },
              { text: CANDIDATES[1]!.answer, votes: 3 },
            ],
          }
          : options.results;
      },
    },
    now: () => new Date('2026-09-07T18:00:00Z'),
  });
  return { closing, recorded };
}

const hour = {
  at: new Date('2026-09-07T18:00:00Z'),
  startedAt: '2026-09-07 13:00:00',
  day: '2026-09-07',
  hour: 13,
  dayOfWeek: 1,
};

describe('posting the result of a poll whose time is up', () => {
  it('posts the winning evening in the channel the poll is in, with a button that accepts it', async () => {
    const polls = memorySchedulerPolls();
    await polls.open(POLL);
    const { closing, recorded } = job({ polls });

    await closing.run(hour);

    expect(recorded.read).toEqual([{ channelId: CHANNEL, messageId: MESSAGE }]);
    expect(recorded.posted).toHaveLength(1);
    expect(recorded.posted[0]!.channelId).toBe(CHANNEL);
    expect(recorded.posted[0]!.reply.content).toContain('Wednesdays at 6:00 PM');
    expect(recorded.posted[0]!.reply.content).toContain('7');
    expect(JSON.stringify(recorded.posted[0]!.reply.components)).toContain(TAKE_PREFIX);
  });

  it('marks the poll closed, so that the result is posted once and not on every pass', async () => {
    const polls = memorySchedulerPolls();
    await polls.open(POLL);
    const { closing, recorded } = job({ polls });

    await closing.run(hour);
    await closing.run(hour);

    expect(recorded.posted).toHaveLength(1);
    expect((await polls.get(1))!.closedAt).not.toBe(null);
  });

  it('leaves a poll whose time has not come alone', async () => {
    const polls = memorySchedulerPolls();
    await polls.open({ ...POLL, closesAt: '2026-09-30 12:00:00' });
    const { closing, recorded } = job({ polls });

    await closing.run(hour);
    expect(recorded.read).toEqual([]);
    expect(recorded.posted).toEqual([]);
  });

  it('says so when nobody answered the poll at all', async () => {
    const polls = memorySchedulerPolls();
    await polls.open(POLL);
    const { closing, recorded } = job({
      polls,
      results: {
        finalized: true,
        answers: CANDIDATES.map(candidate => ({ text: candidate.answer, votes: 0 })),
      },
    });

    await closing.run(hour);
    expect(recorded.posted[0]!.reply.content).toContain('Nobody answered');
    // The board can still accept what VIA recommended, so the buttons stay.
    expect(JSON.stringify(recorded.posted[0]!.reply.components)).toContain(TAKE_PREFIX);
  });

  /**
   * A channel can be deleted while a poll is running in it. There is nothing
   * to post the result into and nothing for anybody to put right, so the poll
   * is written off rather than read again on every pass for ever.
   */
  it('writes off a poll whose channel has been deleted', async () => {
    const polls = memorySchedulerPolls();
    await polls.open(POLL);
    const { closing, recorded } = job({
      polls,
      failReading: Object.assign(new Error('Unknown Channel'), { code: 10003 }),
    });

    await closing.run(hour);

    expect(recorded.posted).toEqual([]);
    expect((await polls.get(1))!.closedAt).not.toBe(null);
  });

  it('leaves a poll alone when reading it failed for any other reason', async () => {
    const polls = memorySchedulerPolls();
    await polls.open(POLL);
    const { closing } = job({ polls, failReading: new Error('Discord did not answer') });

    await closing.run(hour);
    expect((await polls.get(1))!.closedAt).toBe(null);
  });

  it('waits for the counts to be finalized rather than posting a running total', async () => {
    const polls = memorySchedulerPolls();
    await polls.open(POLL);
    const { closing, recorded } = job({
      polls,
      results: {
        finalized: false,
        answers: [{ text: CANDIDATES[0]!.answer, votes: 1 }],
      },
    });

    await closing.run(hour);
    expect(recorded.posted).toEqual([]);
    expect((await polls.get(1))!.closedAt).toBe(null);
  });

  it('writes off a poll whose message carries no poll at all any more', async () => {
    const polls = memorySchedulerPolls();
    await polls.open(POLL);
    const { closing, recorded } = job({ polls, results: null });

    await closing.run(hour);
    expect(recorded.posted).toEqual([]);
    expect((await polls.get(1))!.closedAt).not.toBe(null);
  });
});
