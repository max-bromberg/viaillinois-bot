import { drizzle } from 'drizzle-orm/mysql2';
import { pool } from './pool.ts';
import * as schema from './schema.ts';

/**
 * Drizzle client built over the one mysql2 pool.
 *
 * The bot uses Drizzle from day one, so there is no raw query path beside
 * this one. The schema is attached so that the relational query API is
 * available to everything that imports the client.
 */
export const db = drizzle(pool, { schema, mode: 'default' });

export { pool };
export default db;
