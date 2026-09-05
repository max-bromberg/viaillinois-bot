import { describe, it, expect } from 'vitest';
import { DEFAULT_TICK_MS, MAX_CATCH_UP_HOURS, createJobScheduler, type JobHour } from '../../src/jobs/scheduler.ts';
import { memoryJobRuns } from '../support/proactive.ts';

/**
 * The scheduler.
 *
 * Section 7 of the design asks for one thing from it: a bot that was down over
 * a digest hour sends the digest when it returns, rather than skipping the week
 * or sending it twice. That is three claims, and each of them is a test here at
 * a fixed instant: the hour that has just arrived runs, the hour that already
 * ran does not run again, and the hours a bot was away for run once each, in
 * the order they happened.
 */
describe('running the jobs on the campus clock', () => {
  function built(at: Date, options: { maxCatchUpHours?: number } = {}) {
    const clock = { at };
    const runs = memoryJobRuns();
    const hours: string[] = [];
    const ticks: string[] = [];
    const waits: number[] = [];

    const scheduler = createJobScheduler({
      runs,
      jobs: [
        {
          name: 'guild.digest',
          async run(hour: JobHour) { hours.push(hour.startedAt); },
        },
        {
          name: 'personal.reminders',
          cadence: 'tick',
          async run(hour: JobHour) { ticks.push(hour.startedAt); },
        },
      ],
      now: () => clock.at,
      sleep: async (milliseconds: number) => { waits.push(milliseconds); },
      ...options,
    });

    return { scheduler, runs, hours, ticks, waits, clock };
  }

  it('runs an hourly job for the hour it is in when it has never run before', async () => {
    const { scheduler, hours } = built(new Date('2026-09-06T23:20:00Z'));
    await scheduler.runDue();
    expect(hours).toEqual(['2026-09-06 18:00:00']);
  });

  it('does not run an hourly job twice in the same hour', async () => {
    const { scheduler, hours, clock } = built(new Date('2026-09-06T23:20:00Z'));
    await scheduler.runDue();
    clock.at = new Date('2026-09-06T23:55:00Z');
    await scheduler.runDue();
    expect(hours).toEqual(['2026-09-06 18:00:00']);
  });

  it('runs the next hour when it arrives', async () => {
    const { scheduler, hours, clock } = built(new Date('2026-09-06T23:20:00Z'));
    await scheduler.runDue();
    clock.at = new Date('2026-09-07T00:05:00Z');
    await scheduler.runDue();
    expect(hours).toEqual(['2026-09-06 18:00:00', '2026-09-06 19:00:00']);
  });

  /**
   * The bot was down from six in the evening until nine. The three hours it
   * missed each run once, in order, so the digest that was due at six is sent
   * when the bot returns rather than skipped.
   */
  it('runs each hour a bot that was down missed, once and in order', async () => {
    const { scheduler, hours, clock } = built(new Date('2026-09-06T23:20:00Z'));
    await scheduler.runDue();

    clock.at = new Date('2026-09-07T02:10:00Z');
    await scheduler.runDue();

    expect(hours).toEqual([
      '2026-09-06 18:00:00',
      '2026-09-06 19:00:00',
      '2026-09-06 20:00:00',
      '2026-09-06 21:00:00',
    ]);
  });

  it('tells a job which day of the week and which hour on the campus clock it is running for', async () => {
    const seen: JobHour[] = [];
    const runs = memoryJobRuns();
    const scheduler = createJobScheduler({
      runs,
      jobs: [{ name: 'guild.digest', async run(hour) { seen.push(hour); } }],
      now: () => new Date('2026-09-06T23:20:00Z'),
    });

    await scheduler.runDue();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.day).toBe('2026-09-06');
    expect(seen[0]!.hour).toBe(18);
    expect(seen[0]!.dayOfWeek).toBe(0);
    expect(seen[0]!.at.toISOString()).toBe('2026-09-06T23:00:00.000Z');
  });

  it('records the hour it ran for, so that a restart carries on from there', async () => {
    const { scheduler, runs } = built(new Date('2026-09-06T23:20:00Z'));
    await scheduler.runDue();
    expect(await runs.lastRunAt('guild.digest')).toBe('2026-09-06 18:00:00');
  });

  /**
   * A bot that was away for a term does not post a term of digests when it
   * returns. The cap is what stops that, and everything older than the cap is
   * a week nobody is waiting on any more.
   */
  it('catches up on no more hours than the cap allows', async () => {
    const { scheduler, hours, clock } = built(new Date('2026-09-06T23:20:00Z'), { maxCatchUpHours: 3 });
    await scheduler.runDue();

    clock.at = new Date('2026-09-08T23:20:00Z');
    await scheduler.runDue();

    expect(hours).toHaveLength(4);
    expect(hours.slice(1)).toEqual([
      '2026-09-08 16:00:00',
      '2026-09-08 17:00:00',
      '2026-09-08 18:00:00',
    ]);
  });

  it('runs a job of the tick cadence on every run, and never catches one up', async () => {
    const { scheduler, ticks, clock } = built(new Date('2026-09-06T23:20:00Z'));
    await scheduler.runDue();
    clock.at = new Date('2026-09-06T23:25:00Z');
    await scheduler.runDue();
    clock.at = new Date('2026-09-07T05:25:00Z');
    await scheduler.runDue();
    expect(ticks).toHaveLength(3);
  });

  it('gives a job of the tick cadence the instant it is running at', async () => {
    const seen: JobHour[] = [];
    const scheduler = createJobScheduler({
      runs: memoryJobRuns(),
      jobs: [{ name: 'personal.reminders', cadence: 'tick', async run(hour) { seen.push(hour); } }],
      now: () => new Date('2026-09-06T23:20:00Z'),
    });
    await scheduler.runDue();
    expect(seen[0]!.at.toISOString()).toBe('2026-09-06T23:20:00.000Z');
  });

  it('carries on to the next job when one of them fails, and says how many failed', async () => {
    const runs = memoryJobRuns();
    const done: string[] = [];
    const scheduler = createJobScheduler({
      runs,
      jobs: [
        { name: 'guild.digest', async run() { throw new Error('Discord did not answer'); } },
        { name: 'personal.digest', async run() { done.push('personal.digest'); } },
      ],
      now: () => new Date('2026-09-06T23:20:00Z'),
    });

    const report = await scheduler.runDue();
    expect(report.failed).toBe(1);
    expect(done).toEqual(['personal.digest']);
  });

  /**
   * An hour that failed is not written down as an hour that ran, so the next
   * run tries it again. Everything a job posts goes through Deliveries, so a
   * retry of an hour that half succeeded finishes it rather than repeating it.
   */
  it('leaves an hour that failed to be run again', async () => {
    const runs = memoryJobRuns();
    let attempts = 0;
    const scheduler = createJobScheduler({
      runs,
      jobs: [{
        name: 'guild.digest',
        async run() {
          attempts += 1;
          if (attempts === 1) throw new Error('Discord did not answer');
        },
      }],
      now: () => new Date('2026-09-06T23:20:00Z'),
    });

    await scheduler.runDue();
    expect(await runs.lastRunAt('guild.digest')).toBe(null);
    await scheduler.runDue();
    expect(attempts).toBe(2);
    expect(await runs.lastRunAt('guild.digest')).toBe('2026-09-06 18:00:00');
  });

  it('runs, waits, and runs again until it is stopped', async () => {
    const runs = memoryJobRuns();
    const waits: number[] = [];
    let ran = 0;
    const scheduler = createJobScheduler({
      runs,
      jobs: [{ name: 'guild.digest', cadence: 'tick', async run() { ran += 1; } }],
      now: () => new Date('2026-09-06T23:20:00Z'),
      sleep: async (milliseconds: number) => {
        waits.push(milliseconds);
        if (waits.length >= 2) void scheduler.stop();
      },
    });

    await scheduler.start();
    expect(waits).toEqual([DEFAULT_TICK_MS, DEFAULT_TICK_MS]);
    expect(ran).toBe(2);
  });

  it('reports when it last looked, so that a scheduler which has stopped can be told apart', async () => {
    const { scheduler } = built(new Date('2026-09-06T23:20:00Z'));
    expect(scheduler.state().lastTickAt).toBe(null);
    await scheduler.runDue();
    expect(scheduler.state().lastTickAt).toBe('2026-09-06 18:20:00');
  });

  it('caps the catch up at a day by default', () => {
    expect(MAX_CATCH_UP_HOURS).toBe(24);
  });
});
