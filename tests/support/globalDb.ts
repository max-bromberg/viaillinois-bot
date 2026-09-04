import { stopTestDb } from './testDb.ts';

/**
 * Database suites bring the throwaway container up themselves, because a suite
 * has to be able to run on its own. Tearing it down is done once here, after
 * the whole run, so that one suite finishing cannot pull the container out
 * from under another one that is still using it.
 */
export function setup() {
  return async function teardown() {
    await stopTestDb().catch(() => {});
  };
}
