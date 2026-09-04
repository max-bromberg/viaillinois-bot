import mysql from 'mysql2/promise';

/**
 * Connection settings for the bot's own account, read from the environment
 * the way the deployed stack sets it. The defaults exist for a developer's
 * machine; src/config.ts is what refuses to start without them in production.
 */
export function databaseConfigFromEnv() {
  return {
    host:     process.env.DB_HOST         || 'localhost',
    port:     parseInt(process.env.DB_PORT || '3306', 10),
    user:     process.env.BOT_DB_USER     || 'via_bot',
    password: process.env.BOT_DB_PASSWORD || '',
    database: process.env.BOT_DB_NAME     || 'via_bot',
  };
}

/**
 * Connection settings for the migrate script, which needs more than the
 * application account has. The default is root with the bot database
 * password, because that is how the database container is provisioned. A
 * deployment that prefers a dedicated account sets BOT_DB_ADMIN_USER and
 * BOT_DB_ADMIN_PASSWORD instead.
 */
export function adminConfigFromEnv() {
  const base = databaseConfigFromEnv();
  return {
    ...base,
    user:     process.env.BOT_DB_ADMIN_USER     || 'root',
    password: process.env.BOT_DB_ADMIN_PASSWORD || base.password,
  };
}

/**
 * There is exactly one connection pool in this process. Drizzle runs over it,
 * and so does the health probe.
 */
export const pool = mysql.createPool({
  ...databaseConfigFromEnv(),
  waitForConnections: true,
  connectionLimit: 5,
  queueLimit: 50,
  connectTimeout: 10_000,
  // Datetime columns hold campus wall clock, so they are read back as the
  // strings they are. The driver would otherwise parse each one into a Date
  // using the zone this process happens to run in, and JSON would then publish
  // that as UTC, moving every event by the difference between the two.
  dateStrings: true,
});

export default pool;
