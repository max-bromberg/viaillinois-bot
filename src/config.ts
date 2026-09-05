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

/**
 * The sliding window limits from section 9 of the design. They have defaults
 * because a deployment should not have to think about them, and they are
 * readable from the environment because a deployment that is being abused
 * should not have to wait for a release to tighten them.
 */
export interface RateLimitConfig {
  unlinkedPerHour: number;
  linkedPerHour: number;
  guildPerHour: number;
  /**
   * How many completions one Discord account may ask for in a minute. An
   * autocomplete is not a command, so it is counted over its own window and
   * against its own subject, and this is set wide enough that nobody reaches
   * it by typing a name.
   */
  autocompletePerMinute: number;
}

export interface BotConfig {
  discordToken: string;
  discordApplicationId: string;
  discordPublicKey: string;
  viaInternalUrl: string;
  /** Where the website is, which every link button the bot posts opens. */
  viaPublicUrl: string;
  botServiceToken: string;
  database: DatabaseConfig;
  healthPort: number;
  rateLimits: RateLimitConfig;
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

/**
 * Where the website is when VIA_PUBLIC_URL is not set, which is where it
 * actually runs. It is a variable rather than a constant so that a developer
 * running against a local web platform gets link buttons that open their own
 * copy rather than production.
 */
export const DEFAULT_VIA_PUBLIC_URL = 'https://viaillinois.com';

/**
 * The rate limits a deployment that names none of them runs with. A student
 * running commands hand over hand reaches the unlinked limit in about a
 * minute of deliberate effort and never reaches it by using the bot, and the
 * server ceiling is high enough that a busy server during an event week never
 * sees it.
 */
export const DEFAULT_RATE_LIMITS: RateLimitConfig = {
  unlinkedPerHour: 30,
  linkedPerHour: 120,
  guildPerHour: 600,
  // Five completions a second for a whole minute is more typing than anybody
  // does, and it still bounds what one account can ask the caches to hold.
  autocompletePerMinute: 300,
};

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

/** A limit is a whole number of commands, and one that is not positive refuses everybody. */
function commandsPerHour(env: Environment, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d{1,7}$/.test(raw) || Number(raw) === 0) {
    throw new Error(
      `The environment variable ${name} must be a whole number of commands per hour, and "${raw}" is not one.`
    );
  }
  return Number(raw);
}

/** The same reading for the window that is counted per minute rather than per hour. */
function completionsPerMinute(env: Environment, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d{1,7}$/.test(raw) || Number(raw) === 0) {
    throw new Error(
      `The environment variable ${name} must be a whole number of completions per minute, and "${raw}" is not one.`
    );
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
  const publicUrlRaw = env.VIA_PUBLIC_URL?.trim();

  return {
    discordToken: required(env, 'DISCORD_TOKEN'),
    discordApplicationId: required(env, 'DISCORD_APPLICATION_ID'),
    discordPublicKey: required(env, 'DISCORD_PUBLIC_KEY'),
    viaInternalUrl: httpAddress('VIA_INTERNAL_URL', required(env, 'VIA_INTERNAL_URL')),
    viaPublicUrl: publicUrlRaw
      ? httpAddress('VIA_PUBLIC_URL', publicUrlRaw)
      : DEFAULT_VIA_PUBLIC_URL,
    botServiceToken: required(env, 'BOT_SERVICE_TOKEN'),
    database: {
      host: required(env, 'DB_HOST'),
      port: port('DB_PORT', required(env, 'DB_PORT')),
      user: required(env, 'BOT_DB_USER'),
      password: required(env, 'BOT_DB_PASSWORD'),
      database: required(env, 'BOT_DB_NAME'),
    },
    healthPort: healthPortRaw ? port('HEALTH_PORT', healthPortRaw) : DEFAULT_HEALTH_PORT,
    rateLimits: {
      unlinkedPerHour: commandsPerHour(env, 'RATE_LIMIT_UNLINKED_PER_HOUR', DEFAULT_RATE_LIMITS.unlinkedPerHour),
      linkedPerHour: commandsPerHour(env, 'RATE_LIMIT_LINKED_PER_HOUR', DEFAULT_RATE_LIMITS.linkedPerHour),
      guildPerHour: commandsPerHour(env, 'RATE_LIMIT_GUILD_PER_HOUR', DEFAULT_RATE_LIMITS.guildPerHour),
      autocompletePerMinute: completionsPerMinute(
        env,
        'RATE_LIMIT_AUTOCOMPLETE_PER_MINUTE',
        DEFAULT_RATE_LIMITS.autocompletePerMinute,
      ),
    },
  };
}
