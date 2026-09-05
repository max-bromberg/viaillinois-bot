import type { NewSchedulerPoll, SchedulerPoll, SchedulerPolls } from '../../src/scheduler/polls.ts';

/**
 * The scheduler polls, in memory.
 *
 * What the store guarantees is tested against a real database in
 * tests/db/schedulerPolls.db.test.ts. What the command and the closing job
 * need from it is behaviour: a poll that is written down, read back when its
 * time is up, and read back once rather than twice.
 */
export function memorySchedulerPolls(): SchedulerPolls {
  const rows: SchedulerPoll[] = [];
  let nextId = 0;

  return {
    async open(poll: NewSchedulerPoll) {
      nextId += 1;
      const row: SchedulerPoll = { pollId: nextId, closedAt: null, ...poll };
      rows.push(row);
      return { ...row };
    },

    async get(pollId: number) {
      const row = rows.find(one => one.pollId === pollId);
      return row ? { ...row } : null;
    },

    async due(at: string) {
      return rows
        .filter(row => row.closedAt === null && row.closesAt <= at)
        .map(row => ({ ...row }));
    },

    async recordClosed(pollId: number, at: string) {
      const row = rows.find(one => one.pollId === pollId);
      if (row) row.closedAt = at;
    },

    async removeGuild(guildId: string) {
      const kept = rows.filter(row => row.guildId !== guildId);
      const removed = rows.length - kept.length;
      rows.length = 0;
      rows.push(...kept);
      return removed;
    },
  };
}
