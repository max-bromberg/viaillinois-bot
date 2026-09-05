import { describe, it, expect } from 'vitest';
import { createSpread, POST_SPREAD_MS } from '../../src/delivery/spread.ts';

/**
 * The pause between one server and the next.
 *
 * Section 9 of the design asks the proactive jobs to spread their posts rather
 * than firing every server's digest in the same second, and this is the whole
 * of that: a short wait before every server after the first.
 */
describe('spreading the proactive posts', () => {
  function recording(spreadMs?: number) {
    const waits: number[] = [];
    const spread = createSpread({
      ...(spreadMs === undefined ? {} : { spreadMs }),
      sleep: async (milliseconds: number) => { waits.push(milliseconds); },
    });
    return { waits, spread };
  }

  it('waits a quarter of a second between servers', () => {
    expect(POST_SPREAD_MS).toBe(250);
  });

  it('waits before every server after the first, and not before the first', async () => {
    const { waits, spread } = recording();
    for (const index of [0, 1, 2]) await spread(index);
    expect(waits).toEqual([POST_SPREAD_MS, POST_SPREAD_MS]);
  });

  it('waits not at all when a caller asked for no spread', async () => {
    const { waits, spread } = recording(0);
    for (const index of [0, 1, 2]) await spread(index);
    expect(waits).toEqual([]);
  });
});
