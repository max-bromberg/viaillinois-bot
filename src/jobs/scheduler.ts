import { campusStamp, toInstant } from '../render/campusTime.ts';
import {
  HOUR_MS, campusDayOfWeek, campusHour, campusHourStamp, campusHourStart,
} from './clock.ts';
import type { JobRuns } from './runs.ts';

/**
 * The scheduler.
 *
 * The digests, the reminders and the living this week message all happen at a
 * time somebody chose on the campus clock, and section 7 of the design asks
 * one thing of the machinery that runs them: a bot that was down over a digest
 * hour sends the digest when it returns, rather than skipping the week or
 * sending it twice. Skipping is what a job with no memory does. Sending twice
 * is what a job that remembers only inside one process does after a restart.
 * So the memory is a row in Job_Runs, and the scheduler runs a job once for
 * each campus hour that has passed since the hour it last ran for.
 *
 * Two cadences are enough for everything in this release. An hourly job is one
 * whose work belongs to a particular hour, such as the digest a server asked
 * for at six on a Sunday, and it is run once per campus hour, catching up in
 * order. A tick job is one whose work is due at a moment rather than in an
 * hour, such as the reminder somebody asked for an hour before an event, and it
 * is run on every pass and never caught up, because everything it owes is
 * already written down in Reminders and in the events themselves.
 *
 * An hour that failed is not written down as an hour that ran, so the next pass
 * runs it again. That is safe because every post a job makes goes through
 * Deliveries first, so a retry of an hour that half succeeded finishes it
 * rather than repeating it.
 */

/** How long the scheduler waits between passes. */
export const DEFAULT_TICK_MS = 5 * 60 * 1000;

/**
 * How far back a catch up reaches. A bot that has been away for longer than
 * this has missed a digest nobody is still waiting on, and posting a term of
 * them on the morning it returns would be worse than posting none.
 */
export const MAX_CATCH_UP_HOURS = 24;

/** How often a job runs: once per campus hour, or on every pass. */
export type JobCadence = 'hourly' | 'tick';

/** The hour a job is running for, on the campus clock. */
export interface JobHour {
  /**
   * The instant the run is for: the top of the campus hour for an hourly job,
   * and the moment of the pass for a tick job, which decides what is due now.
   */
  at: Date;
  /** The campus hour, as a datetime column holds it. */
  startedAt: string;
  /** The campus date, as YYYY-MM-DD. */
  day: string;
  /** The hour on the campus clock, from zero to twenty three. */
  hour: number;
  /** The day of the week, zero for Sunday, as the digest day counts. */
  dayOfWeek: number;
}

export interface ScheduledJob {
  /** The name the run is recorded under in Job_Runs. */
  name: string;
  /** Once per campus hour by default. */
  cadence?: JobCadence;
  run(hour: JobHour): Promise<void>;
}

export interface JobSchedulerOptions {
  jobs: readonly ScheduledJob[];
  runs: JobRuns;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  tickMs?: number;
  maxCatchUpHours?: number;
}

/** What one pass did, which is what the log and the health endpoint read. */
export interface RunReport {
  /** Every job and hour that ran, in the order they ran. */
  ran: { job: string; hour: string }[];
  /** How many runs failed, each of them logged. */
  failed: number;
}

/** What the scheduler says about itself, for the health endpoint. */
export interface SchedulerState {
  /** When the scheduler last made a pass, or null before its first. */
  lastTickAt: string | null;
}

export interface JobScheduler {
  /** Make one pass: run everything that is due, and say what ran. */
  runDue(): Promise<RunReport>;
  /** Start the loop, answering with the loop itself. */
  start(): Promise<void>;
  stop(): Promise<void>;
  state(): SchedulerState;
}

/** Everything a job needs to know about the hour it is running for. */
function hourOf(at: Date, instant: Date): JobHour {
  const startedAt = campusHourStamp(instant);
  return {
    at,
    startedAt,
    day: startedAt.slice(0, 10),
    hour: campusHour(instant),
    dayOfWeek: campusDayOfWeek(instant),
  };
}

export function createJobScheduler(options: JobSchedulerOptions): JobScheduler {
  const {
    jobs,
    runs,
    now = () => new Date(),
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    tickMs = DEFAULT_TICK_MS,
    maxCatchUpHours = MAX_CATCH_UP_HOURS,
  } = options;

  let running = false;
  let loop: Promise<void> | null = null;
  let lastTickAt: string | null = null;

  /**
   * The campus hours an hourly job still owes, oldest first.
   *
   * A job that has never run owes only the hour it is in: the hours before the
   * bot existed are not hours it missed. Everything else is counted from the
   * hour it last ran for, in instants rather than in wall clock readings,
   * because a day is not always twenty four hours long on a clock that moves
   * twice a year but an hour is always an hour.
   */
  async function dueHours(job: ScheduledJob, at: Date): Promise<Date[]> {
    const thisHour = campusHourStart(at);
    const last = await runs.lastRunAt(job.name);
    if (last === null) return [thisHour];

    const from = toInstant(last);
    if (!from || from.getTime() >= thisHour.getTime()) return [];

    const hours: Date[] = [];
    for (let instant = from.getTime() + HOUR_MS; instant <= thisHour.getTime(); instant += HOUR_MS) {
      hours.push(new Date(instant));
    }
    return hours.slice(-maxCatchUpHours);
  }

  async function runOnce(job: ScheduledJob, hour: JobHour): Promise<boolean> {
    try {
      await job.run(hour);
      return true;
    } catch (err) {
      console.error(`the job ${job.name} failed for the hour ${hour.startedAt}:`, (err as Error).message);
      return false;
    }
  }

  async function runDue(): Promise<RunReport> {
    const at = now();
    lastTickAt = campusStamp(at);
    const report: RunReport = { ran: [], failed: 0 };

    for (const job of jobs) {
      if ((job.cadence ?? 'hourly') === 'tick') {
        const hour = hourOf(at, at);
        if (await runOnce(job, hour)) {
          report.ran.push({ job: job.name, hour: hour.startedAt });
          await runs.recordRun(job.name, lastTickAt);
        } else {
          report.failed += 1;
        }
        continue;
      }

      let owed: Date[];
      try {
        owed = await dueHours(job, at);
      } catch (err) {
        report.failed += 1;
        console.error(`reading when the job ${job.name} last ran failed:`, (err as Error).message);
        continue;
      }

      for (const instant of owed) {
        const hour = hourOf(instant, instant);
        if (!(await runOnce(job, hour))) {
          // The hour is not written down, so the next pass runs it again, and
          // the hours after it wait rather than running out of order.
          report.failed += 1;
          break;
        }
        report.ran.push({ job: job.name, hour: hour.startedAt });
        await runs.recordRun(job.name, hour.startedAt);
      }
    }

    return report;
  }

  async function every(): Promise<void> {
    while (running) {
      try {
        await runDue();
      } catch (err) {
        // Every job is already guarded, so what reaches here is the machinery
        // around them: a Job_Runs write the database refused, or a clock
        // reading that failed. A loop that ended because of one of those
        // would leave the bot sending nothing, and looking from outside
        // exactly like a bot with nothing to send.
        console.error('a pass of the scheduler failed:', (err as Error).message);
      }
      if (!running) break;
      await sleep(tickMs);
    }
  }

  return {
    runDue,

    start(): Promise<void> {
      if (running) return loop ?? Promise.resolve();
      running = true;
      loop = every();
      return loop;
    },

    async stop(): Promise<void> {
      running = false;
      await loop;
      loop = null;
    },

    state: () => ({ lastTickAt }),
  };
}
