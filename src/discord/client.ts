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
