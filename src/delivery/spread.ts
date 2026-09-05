/**
 * Spreading the proactive posts.
 *
 * Section 9 of the design asks for one thing of everything the bot posts on
 * its own: the proactive jobs spread their posts rather than firing every
 * server's digest in the same second. Discord's own rate limits are handled by
 * the library, which queues what it cannot send yet, so the cost of not
 * spreading is not a refusal. It is a burst that fills that queue and pushes
 * every interaction behind it, so a student who runs a command at six on a
 * Sunday waits behind forty digests.
 *
 * A quarter of a second between one server and the next is enough to turn a
 * burst into a trickle and short enough that a hundred servers are done inside
 * half a minute, which is well inside the hour the post belongs to.
 *
 * The pause is injected, so a test asserts what was waited rather than waiting
 * it, and nothing that runs to a clock in a test ever sleeps.
 */

/** How long the bot leaves between posting in one server and posting in the next. */
export const POST_SPREAD_MS = 250;

/** A pause taken before a server, and never before the first of them. */
export type Spread = (index: number) => Promise<void>;

export interface SpreadOptions {
  /** How long to leave between servers, which a test sets to nothing. */
  spreadMs?: number;
  /** Injected so that a test records the wait rather than serving it. */
  sleep?: (milliseconds: number) => Promise<void>;
}

export function createSpread(options: SpreadOptions = {}): Spread {
  const {
    spreadMs = POST_SPREAD_MS,
    sleep = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
  } = options;

  return async (index: number): Promise<void> => {
    if (index > 0 && spreadMs > 0) await sleep(spreadMs);
  };
}
