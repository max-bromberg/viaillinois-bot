import { describe, it, expect, vi } from 'vitest';
import { Events, type ClientOptions } from 'discord.js';
import { createGateway } from '../../src/discord/client.ts';
import { intentsBitfield } from '../../src/discord/intents.ts';

/**
 * A fake gateway client in the shape discord.js hands over: it records the
 * options it was built with, keeps the handlers that were wired to it, and
 * lets a test fire an event. No connection is made anywhere in this file.
 */
function fakeClient() {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  let ready = false;
  return {
    options: null as unknown,
    handlers,
    login: vi.fn(async (_token: string) => 'token'),
    destroy: vi.fn(async () => {}),
    isReady: () => ready,
    setReady: (value: boolean) => { ready = value; },
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return this;
    },
    once(event: string, handler: (...args: unknown[]) => unknown) {
      return this.on(event, handler);
    },
    async fire(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) await handler(...args);
    },
  };
}

function gateway(dispatch = vi.fn(async () => {})) {
  const client = fakeClient();
  const built: Array<Record<string, unknown>> = [];
  const bot = createGateway({
    token: 'discord-token',
    dispatch,
    createClient: (options: ClientOptions) => {
      built.push(options as unknown as Record<string, unknown>);
      client.options = options;
      return client as never;
    },
  });
  return { bot, client, built, dispatch };
}

describe('the gateway client', () => {
  it('builds the client with the intents the design names and nothing else', () => {
    const { built } = gateway();
    expect(built).toHaveLength(1);
    const intents = built[0]!.intents as number[];
    expect(intents.reduce((field, intent) => field | intent, 0)).toBe(intentsBitfield());
  });

  it('is not connected until the gateway says it is ready', async () => {
    const { bot, client } = gateway();
    expect(bot.isConnected()).toBe(false);
    client.setReady(true);
    await client.fire(Events.ClientReady, { user: { tag: 'via#0001' } });
    expect(bot.isConnected()).toBe(true);
  });

  it('is not connected again once the library reports the connection gone', async () => {
    const { bot, client } = gateway();
    client.setReady(true);
    await client.fire(Events.ClientReady, { user: { tag: 'via#0001' } });
    client.setReady(false);
    expect(bot.isConnected()).toBe(false);
  });

  it('hands every interaction to the dispatcher', async () => {
    const { client, dispatch } = gateway();
    const interaction = { id: '1', commandName: 'link' };
    await client.fire(Events.InteractionCreate, interaction);
    expect(dispatch).toHaveBeenCalledWith(interaction);
  });

  it('survives a dispatcher that throws, because one bad command must not end the connection', async () => {
    const failing = vi.fn(async () => { throw new Error('the dispatcher fell over'); });
    const { client } = gateway(failing);
    await expect(client.fire(Events.InteractionCreate, { id: '1' })).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalled();
  });

  it('logs in with the token from the configuration', async () => {
    const { bot, client } = gateway();
    await bot.login();
    expect(client.login).toHaveBeenCalledWith('discord-token');
  });

  it('closes the connection when the process is shutting down', async () => {
    const { bot, client } = gateway();
    await bot.destroy();
    expect(client.destroy).toHaveBeenCalled();
  });
});

describe('the gateway and the servers it is in', () => {
  it('hands a server it joined to the lifecycle, raw, for the adapter to read', async () => {
    const joined: unknown[] = [];
    const client = fakeClient();
    createGateway({
      token: 'discord-token',
      dispatch: vi.fn(async () => {}),
      onGuildCreate: async (raw: unknown) => { joined.push(raw); },
      createClient: () => client as never,
    });
    const guild = { id: '900000000000000001', ownerId: '204255221017214977', available: true };
    await client.fire(Events.GuildCreate, guild);
    expect(joined).toEqual([guild]);
  });

  it('hands a server it left to the lifecycle', async () => {
    const left: unknown[] = [];
    const client = fakeClient();
    createGateway({
      token: 'discord-token',
      dispatch: vi.fn(async () => {}),
      onGuildDelete: async (raw: unknown) => { left.push(raw); },
      createClient: () => client as never,
    });
    const guild = { id: '900000000000000001', ownerId: '204255221017214977', available: true };
    await client.fire(Events.GuildDelete, guild);
    expect(left).toEqual([guild]);
  });

  it('stays connected when handling a server throws', async () => {
    const client = fakeClient();
    createGateway({
      token: 'discord-token',
      dispatch: vi.fn(async () => {}),
      onGuildCreate: async () => { throw new Error('the database fell over'); },
      createClient: () => client as never,
    });
    await expect(client.fire(Events.GuildCreate, { id: '900000000000000001' })).resolves.toBeUndefined();
  });

  it('connects without a lifecycle at all, for a run that has none', async () => {
    const client = fakeClient();
    createGateway({
      token: 'discord-token',
      dispatch: vi.fn(async () => {}),
      createClient: () => client as never,
    });
    await expect(client.fire(Events.GuildCreate, { id: '900000000000000001' })).resolves.toBeUndefined();
  });
});
