import { toComponents, type Reply } from './adapter.ts';
import type { Client } from 'discord.js';

/**
 * Sending one direct message.
 *
 * A direct message can always fail, and the commonest reason is not a fault:
 * a person can turn off messages from servers they share with the bot, and
 * Discord answers with code 50007 when they have. Nothing the bot sends by
 * direct message is important enough to fail a command over, so the sender
 * answers what happened and never throws.
 *
 * There are two ways in, because there are two callers with different
 * questions. A command wants to know whether its one message arrived, and gets
 * a yes or a no. A job wants to tell a person who has closed their direct
 * messages from Discord having a bad minute, because the design has the bot
 * switch that person's direct messages off rather than write to them every
 * week and fail every week, and a bad minute is a message still owed.
 */

/** Discord's code for a person whose settings do not allow the message. */
const CANNOT_SEND_TO_USER = 50007;

/** What became of a direct message the bot tried to send. */
export type DirectMessageOutcome = 'sent' | 'blocked' | 'failed';

export type DirectMessageSender = (discordUserId: string, content: string) => Promise<boolean>;

export type DirectMessageDelivery = (discordUserId: string, reply: Reply) => Promise<DirectMessageOutcome>;

export function createDirectMessageDelivery(client: Client): DirectMessageDelivery {
  return async function deliver(discordUserId: string, reply: Reply): Promise<DirectMessageOutcome> {
    try {
      const user = await client.users.fetch(discordUserId);
      await user.send({ content: reply.content, components: toComponents(reply) as never });
      return 'sent';
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === CANNOT_SEND_TO_USER) {
        console.log(`direct message not sent: ${discordUserId} does not accept them`);
        return 'blocked';
      }
      console.error('direct message failed:', (err as Error).message);
      return 'failed';
    }
  };
}

export function createDirectMessageSender(client: Client): DirectMessageSender {
  return async function sendDirectMessage(discordUserId: string, content: string): Promise<boolean> {
    try {
      const user = await client.users.fetch(discordUserId);
      await user.send(content);
      return true;
    } catch (err) {
      const code = (err as { code?: number }).code;
      if (code === CANNOT_SEND_TO_USER) {
        console.log(`direct message not sent: ${discordUserId} does not accept them`);
      } else {
        console.error('direct message failed:', (err as Error).message);
      }
      return false;
    }
  };
}
