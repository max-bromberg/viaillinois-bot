import { describe, it, expect } from 'vitest';
import { loadConfig, REQUIRED_VARIABLES } from '../src/config.ts';

/** Every variable set, the way the deployed stack sets them. */
function fullEnvironment(): Record<string, string> {
  return {
    DISCORD_TOKEN: 'discord-token',
    DISCORD_APPLICATION_ID: '123456789012345678',
    DISCORD_PUBLIC_KEY: 'public-key',
    VIA_INTERNAL_URL: 'http://via:3001',
    BOT_SERVICE_TOKEN: 'service-token',
    DB_HOST: 'via-db',
    DB_PORT: '3306',
    BOT_DB_USER: 'via_bot',
    BOT_DB_PASSWORD: 'secret',
    BOT_DB_NAME: 'via_bot',
    HEALTH_PORT: '3002',
  };
}

describe('loadConfig', () => {
  it('reads every variable into a typed configuration', () => {
    const config = loadConfig(fullEnvironment());
    expect(config).toEqual({
      discordToken: 'discord-token',
      discordApplicationId: '123456789012345678',
      discordPublicKey: 'public-key',
      viaInternalUrl: 'http://via:3001',
      botServiceToken: 'service-token',
      database: {
        host: 'via-db',
        port: 3306,
        user: 'via_bot',
        password: 'secret',
        database: 'via_bot',
      },
      healthPort: 3002,
      rateLimits: {
        unlinkedPerHour: 30,
        linkedPerHour: 120,
        guildPerHour: 600,
      },
    });
  });

  it('defaults every rate limit when none is named, to the numbers the design settled on', () => {
    const env = fullEnvironment();
    expect(loadConfig(env).rateLimits).toEqual({
      unlinkedPerHour: 30,
      linkedPerHour: 120,
      guildPerHour: 600,
    });
  });

  it('reads a rate limit a deployment chose to change', () => {
    const env = fullEnvironment();
    env.RATE_LIMIT_UNLINKED_PER_HOUR = '10';
    env.RATE_LIMIT_LINKED_PER_HOUR = '200';
    env.RATE_LIMIT_GUILD_PER_HOUR = '1000';
    expect(loadConfig(env).rateLimits).toEqual({
      unlinkedPerHour: 10,
      linkedPerHour: 200,
      guildPerHour: 1000,
    });
  });

  for (const name of [
    'RATE_LIMIT_UNLINKED_PER_HOUR',
    'RATE_LIMIT_LINKED_PER_HOUR',
    'RATE_LIMIT_GUILD_PER_HOUR',
  ]) {
    it(`refuses a ${name} that is not a whole number of commands`, () => {
      const env = fullEnvironment();
      env[name] = 'lots';
      expect(() => loadConfig(env)).toThrow(
        `The environment variable ${name} must be a whole number of commands per hour, and "lots" is not one.`
      );
    });

    it(`refuses a ${name} of zero, because a limit of zero refuses everybody`, () => {
      const env = fullEnvironment();
      env[name] = '0';
      expect(() => loadConfig(env)).toThrow(name);
    });
  }

  it('defaults the health port to 3002 when HEALTH_PORT is not set', () => {
    const env = fullEnvironment();
    delete env.HEALTH_PORT;
    expect(loadConfig(env).healthPort).toBe(3002);
  });

  it('lists every required variable so the deployment document can be checked against it', () => {
    expect(REQUIRED_VARIABLES).toEqual([
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
    ]);
  });

  for (const name of [
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
  ]) {
    it(`refuses to start without ${name} and names it in a sentence`, () => {
      const env = fullEnvironment();
      delete env[name];
      expect(() => loadConfig(env)).toThrow(
        `The environment variable ${name} is not set, and the bot cannot start without it.`
      );
    });

    it(`treats an empty ${name} as missing`, () => {
      const env = fullEnvironment();
      env[name] = '   ';
      expect(() => loadConfig(env)).toThrow(name);
    });
  }

  it('refuses a DB_PORT that is not a whole number', () => {
    const env = fullEnvironment();
    env.DB_PORT = 'three thousand';
    expect(() => loadConfig(env)).toThrow(
      'The environment variable DB_PORT must be a port number, and "three thousand" is not one.'
    );
  });

  it('refuses a HEALTH_PORT that is not a whole number', () => {
    const env = fullEnvironment();
    env.HEALTH_PORT = '0x3002';
    expect(() => loadConfig(env)).toThrow('HEALTH_PORT');
  });

  it('refuses a VIA_INTERNAL_URL that is not an http address', () => {
    const env = fullEnvironment();
    env.VIA_INTERNAL_URL = 'via:3001';
    expect(() => loadConfig(env)).toThrow(
      'The environment variable VIA_INTERNAL_URL must be an http or https address, and "via:3001" is not one.'
    );
  });

  it('reads from process.env when no environment is given', () => {
    const saved = { ...process.env };
    try {
      for (const [k, v] of Object.entries(fullEnvironment())) process.env[k] = v;
      expect(loadConfig().discordApplicationId).toBe('123456789012345678');
    } finally {
      for (const k of Object.keys(fullEnvironment())) delete process.env[k];
      Object.assign(process.env, saved);
    }
  });
});
