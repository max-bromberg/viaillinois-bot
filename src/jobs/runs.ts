import { eq } from 'drizzle-orm';
import { jobRuns } from '../db/schema.ts';
import type { BotDatabase } from '../ratelimit/windows.ts';

/**
 * When each scheduled job last ran.
 *
 * This is one row per job and two questions about it, and it is a module of
 * its own so that the scheduler can be tested without a database and the
 * record itself can be tested against one. The stamp is campus wall clock, as
 * every datetime the bot writes is, because the hours a job runs at are hours
 * on the campus clock.
 */

export interface JobRuns {
  /** The campus hour the job last ran for, or null when it has never run. */
  lastRunAt(jobName: string): Promise<string | null>;
  /** Write down that the job has run for that campus hour. */
  recordRun(jobName: string, at: string): Promise<void>;
}

export function createJobRuns(db: BotDatabase): JobRuns {
  return {
    async lastRunAt(jobName: string): Promise<string | null> {
      const [row] = await db.select().from(jobRuns).where(eq(jobRuns.jobName, jobName));
      return row?.lastRunAt ?? null;
    },

    async recordRun(jobName: string, at: string): Promise<void> {
      await db.insert(jobRuns)
        .values({ jobName, lastRunAt: at })
        .onDuplicateKeyUpdate({ set: { lastRunAt: at } });
    },
  };
}
