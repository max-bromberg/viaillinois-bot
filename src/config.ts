/**
 * Startup configuration.
 *
 * Every variable the bot needs is read here, once, and validated before
 * anything else starts. A missing variable is a sentence naming it rather
 * than a connection error three modules away, because the person reading the
 * container log is deploying, not debugging.
 */

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export interface BotConfig {
  discordToken: string;
  discordApplicationId: string;
  discordPublicKey: string;
  viaInternalUrl: string;
  botServiceToken: string;
  database: DatabaseConfig;
  healthPort: number;
}

/** The variables that have no default, in the order the deployment document lists them. */
export const REQUIRED_VARIABLES = [
  'DISCORD_TOKEN',
  'DISCORD_APPLICATION_ID',
  'DISCORD_PUBLIC_KEY',
  'VIA_INTERNAL_URL',
  'BOT_SERVICE_TOKEN',
  'DB_HOST',
  'DB_PORT',
  'BOT_DB_USER',
  'BOT_DB_PASSWORD',
  'BOT_DB_NAME',
] as const;

/** The port the health listener binds when HEALTH_PORT is not set. */
export const DEFAULT_HEALTH_PORT = 3002;

type Environment = Record<string, string | undefined>;

function required(env: Environment, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`The environment variable ${name} is not set, and the bot cannot start without it.`);
  }
  return value;
}

function port(name: string, raw: string): number {
  if (!/^\d{1,5}$/.test(raw) || Number(raw) > 65535) {
    throw new Error(`The environment variable ${name} must be a port number, and "${raw}" is not one.`);
  }
  return Number(raw);
}

function httpAddress(name: string, raw: string): string {
  let parsed: URL | undefined;
  try {
    parsed = new URL(raw);
  } catch {
    parsed = undefined;
  }
  if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new Error(`The environment variable ${name} must be an http or https address, and "${raw}" is not one.`);
  }
  return raw;
}

/**
 * Read and validate the configuration from the given environment, which is
 * process.env unless a test hands in its own.
 */
export function loadConfig(env: Environment = process.env): BotConfig {
  for (const name of REQUIRED_VARIABLES) required(env, name);

  const healthPortRaw = env.HEALTH_PORT?.trim();

  return {
    discordToken: required(env, 'DISCORD_TOKEN'),
    discordApplicationId: required(env, 'DISCORD_APPLICATION_ID'),
    discordPublicKey: required(env, 'DISCORD_PUBLIC_KEY'),
    viaInternalUrl: httpAddress('VIA_INTERNAL_URL', required(env, 'VIA_INTERNAL_URL')),
    botServiceToken: required(env, 'BOT_SERVICE_TOKEN'),
    database: {
      host: required(env, 'DB_HOST'),
      port: port('DB_PORT', required(env, 'DB_PORT')),
      user: required(env, 'BOT_DB_USER'),
      password: required(env, 'BOT_DB_PASSWORD'),
      database: required(env, 'BOT_DB_NAME'),
    },
    healthPort: healthPortRaw ? port('HEALTH_PORT', healthPortRaw) : DEFAULT_HEALTH_PORT,
  };
}
