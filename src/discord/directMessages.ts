import type { Client } from 'discord.js';

/**
 * Sending one direct message.
 *
 * A direct message can always fail, and the commonest reason is not a fault:
 * a person can turn off messages from servers they share with the bot, and
 * Discord answers with code 50007 when they have. Nothing the bot sends by
 * direct message is important enough to fail a command over, so the sender
 * answers whether the message arrived and never throws.
 */

/** Discord's code for a person whose settings do not allow the message. */
const CANNOT_SEND_TO_USER = 50007;

export type DirectMessageSender = (discordUserId: string, content: string) => Promise<boolean>;

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
