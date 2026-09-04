import { defineConfig } from 'vitest/config';

// Vitest 4 declares projects here, as the web platform does. The unit project
// covers everything that needs neither Discord nor a database, and the db
// project covers the suites whose correctness is about what the database
// guarantees.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['tests/**/*.test.ts', 'scripts/tests/**/*.test.js'],
          exclude: ['tests/**/*.db.test.ts'],
        },
      },
      {
        test: {
          name: 'db',
          include: ['tests/**/*.db.test.ts'],
          // These suites share one container on one fixed port and reset the
          // schema between tests, so two of them at once would corrupt each other.
          // A single fork runs every database file in one process, one after the
          // other, which is the only arrangement that actually holds.
          pool: 'forks',
          // Vitest 4 removed poolOptions. fileParallelism false forces
          // maxWorkers to one, which is the single process arrangement the
          // previous singleFork setting provided. Both are stated here so the
          // requirement survives a future edit to either one.
          fileParallelism: false,
          maxWorkers: 1,
          globalSetup: ['./tests/support/globalDb.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
