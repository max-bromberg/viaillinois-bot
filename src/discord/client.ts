import { Client, Events, type ClientOptions } from 'discord.js';
import { GATEWAY_INTENTS } from './intents.ts';

/**
 * The one gateway connection.
 *
 * The bot runs as a single shard, which is ample for the number of servers
 * involved. This module owns the connection and nothing else: it builds the
 * client from the intents list, hands every interaction to the dispatcher it
 * was given, and answers whether the connection is up so that the health
 * endpoint can say so. Every decision about what an interaction means is made
 * past the adapter, not here.
 *
 * The client is injectable so that these paths are tested without reaching
 * Discord, which the test environment could not reach in any case.
 */

export interface GatewayOptions {
  /** DISCORD_TOKEN, from the configuration. */
  token: string;
  /** What to do with an interaction, which is the dispatcher in src/commands. */
  dispatch: (interaction: unknown) => Promise<void>;
  /** Told the bot user tag once the connection is up, for the startup log. */
  onReady?: (tag: string) => void;
  /**
   * Told about a server the bot is in, raw, whenever the gateway announces
   * one. That is every server on every connection, not only the ones just
   * joined, so what is done with it has to be safe to do again.
   */
  onGuildCreate?: (raw: unknown) => Promise<void>;
  /** Told about a server the bot has left or that has gone down. */
  onGuildDelete?: (raw: unknown) => Promise<void>;
  /**
   * Told when somebody marks themselves interested in one of a server's
   * scheduled events, and when they take that back. Both events are one signal
   * with a direction, so one handler answers both and is told which it was.
   */
  onScheduledEventInterest?: (rawEvent: unknown, rawUser: unknown, interested: boolean) => Promise<void>;
  /** Injected by tests, which pass a client that connects to nothing. */
  createClient?: (options: ClientOptions) => Client;
}

export interface BotGateway {
  /** The library client, for the few places that need it, such as sending a direct message. */
  client: Client;
  /** Whether the gateway connection is up, which the health endpoint reports. */
  isConnected(): boolean;
  login(): Promise<void>;
  destroy(): Promise<void>;
}

export function createGateway(options: GatewayOptions): BotGateway {
  const {
    token,
    dispatch,
    onReady,
    onGuildCreate,
    onGuildDelete,
    onScheduledEventInterest,
    createClient = (clientOptions: ClientOptions) => new Client(clientOptions),
  } = options;

  const client = createClient({ intents: [...GATEWAY_INTENTS] });

  client.once(Events.ClientReady, (ready: { user?: { tag?: string } }) => {
    const tag = ready?.user?.tag ?? 'the bot user';
    console.log(`via-bot: connected to the Discord gateway as ${tag}`);
    onReady?.(tag);
  });

  client.on(Events.Error, (err: Error) => {
    console.error('gateway error:', err.message);
  });

  /**
   * One server failing must not take the connection down, exactly as one
   * command failing must not. There is nobody to answer here, so the failure
   * is logged and the next server is handled.
   */
  const guard = (what: string, handle?: (raw: unknown) => Promise<void>) =>
    async (raw: unknown) => {
      if (!handle) return;
      try {
        await handle(raw);
      } catch (err) {
        console.error(`${what} failed:`, (err as Error).message);
      }
    };

  client.on(Events.GuildCreate, guard('handling a server the bot is in', onGuildCreate));
  client.on(Events.GuildDelete, guard('handling a server the bot has left', onGuildDelete));

  /**
   * One person's interest failing to reach VIA must not take the connection
   * down either, and there is nobody to answer, so it is logged like the
   * others.
   */
  const interest = (interested: boolean) => async (rawEvent: unknown, rawUser: unknown) => {
    if (!onScheduledEventInterest) return;
    try {
      await onScheduledEventInterest(rawEvent, rawUser, interested);
    } catch (err) {
      console.error('recording interest in a scheduled event failed:', (err as Error).message);
    }
  };

  client.on(Events.GuildScheduledEventUserAdd, interest(true));
  client.on(Events.GuildScheduledEventUserRemove, interest(false));

  client.on(Events.InteractionCreate, async (interaction: unknown) => {
    try {
      await dispatch(interaction);
    } catch (err) {
      // One command that throws must not take the connection down with it.
      // The dispatcher answers the person; this is the last resort behind it.
      console.error('interaction dispatch failed:', (err as Error).message);
    }
  });

  return {
    client,
    isConnected: () => client.isReady(),
    login: async () => { await client.login(token); },
    destroy: async () => { await client.destroy(); },
  };
}
