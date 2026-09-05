import { campusStamp } from '../render/campusTime.ts';
import { MIRROR_FEATURE, type ScheduledEventMirror } from '../mirror/scheduledEvents.ts';
import type { GuildStore } from '../guilds/store.ts';

/**
 * The daily roll of the mirroring window.
 *
 * The window is a fortnight by default, which is what keeps a term of weekly
 * meetings from filling a server's Events tab, and a window that does not move
 * is a window that empties. Once a day this job looks at every server that has
 * switched mirroring on and creates the scheduled events for the occurrences
 * that have entered the window since yesterday.
 *
 * Nothing is deleted. An occurrence that has left the window has happened, and
 * it belongs to the server's own history now, along with the interest people
 * left on it.
 *
 * One server failing does not stop the others. The commonest reason for one to
 * fail is a permission the server has taken away, which the mirror itself
 * turns into a feature switched off and a manager told, and the rest of the
 * servers still have windows to roll.
 */

/** How long the job waits between runs, which is a day. */
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface MirrorWindowJobOptions {
  guilds: GuildStore;
  mirror: ScheduledEventMirror;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  intervalMs?: number;
}

/** What one run did, which is what the log reads. */
export interface RollResult {
  /** How many servers had their window rolled. */
  servers: number;
  /** How many occurrences were applied across all of them. */
  events: number;
  /** How many servers failed, each of them logged. */
  failed: number;
  /** When the run happened, in campus wall clock. */
  ranAt: string;
}

export interface MirrorWindowJob {
  runOnce(): Promise<RollResult>;
  /** Start the daily loop, answering with the loop itself. */
  start(): Promise<void>;
  stop(): Promise<void>;
  /** When the job last ran, or null before its first run. */
  lastRunAt(): string | null;
}

export function createMirrorWindowJob(options: MirrorWindowJobOptions): MirrorWindowJob {
  const {
    guilds,
    mirror,
    now = () => new Date(),
    sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
    intervalMs = DEFAULT_INTERVAL_MS,
  } = options;

  let running = false;
  let loop: Promise<void> | null = null;
  let ranAt: string | null = null;

  async function runOnce(): Promise<RollResult> {
    const result: RollResult = { servers: 0, events: 0, failed: 0, ranAt: campusStamp(now()) };
    ranAt = result.ranAt;

    let installations;
    try {
      installations = await guilds.listInstallations();
    } catch (err) {
      console.error('reading the servers to roll the mirroring window for failed:', (err as Error).message);
      return result;
    }

    for (const installation of installations) {
      try {
        if (!(await guilds.isFeatureEnabled(installation.guildId, MIRROR_FEATURE))) continue;
        result.events += await mirror.rollGuild(installation);
        result.servers += 1;
      } catch (err) {
        result.failed += 1;
        console.error(
          `rolling the mirroring window in server ${installation.guildId} failed:`,
          (err as Error).message,
        );
      }
    }

    console.log(`the mirroring window was rolled in ${result.servers} servers over ${result.events} events`);
    return result;
  }

  async function daily(): Promise<void> {
    while (running) {
      await runOnce();
      if (!running) break;
      await sleep(intervalMs);
    }
  }

  return {
    runOnce,

    start(): Promise<void> {
      if (running) return loop ?? Promise.resolve();
      running = true;
      loop = daily();
      return loop;
    },

    async stop(): Promise<void> {
      running = false;
      await loop;
      loop = null;
    },

    lastRunAt: () => ranAt,
  };
}
