import type { Config } from 'drizzle-kit';

// Paths are relative to the working directory, not to this file, so drizzle-kit
// is run from the repository root.
export default {
  dialect: 'mysql',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    host:     process.env.DB_HOST     || 'localhost',
    port:     parseInt(process.env.DB_PORT || '3306'),
    user:     process.env.BOT_DB_USER     || 'root',
    password: process.env.BOT_DB_PASSWORD || '',
    database: process.env.BOT_DB_NAME     || 'via_bot',
  },
} satisfies Config;
