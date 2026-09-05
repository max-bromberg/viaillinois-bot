import { userTarget, type Deliveries } from '../delivery/deliveries.ts';
import type { DirectMessageDelivery } from '../discord/directMessages.ts';
import type { NetIdDirectory } from '../roles/directory.ts';
import type { OutboxEntry } from '../via/client.ts';
import type { OutboxHandlers } from '../outbox/consumer.ts';

/**
 * What the bot does when the outbox says a link was made or taken away.
 *
 * Section 4 of the design describes the whole of linking, and the two ends of
 * it are here. The web platform records the link and writes `link.completed`,
 * and the bot learns of it from the outbox and confirms it to the person in a
 * direct message. Either side can unlink, and when the website is the side
 * that did it the bot hears about it only through `link.revoked`, so that is
 * where every subscription, preference, reminder and course the bot held for
 * that Discord account is deleted.
 *
 * The outbox is the whole mechanism. Nothing here waits, polls or watches for
 * a link: a person who finishes linking on the web platform is confirmed
 * whenever the entry arrives, which is within the consumer's few seconds, and
 * a person who finishes an hour later is confirmed then rather than not at
 * all.
 *
 * The confirmation is sent whatever the person's direct message switch says.
 * It is the answer to something they have just done deliberately rather than
 * one of the messages the switch is about, and a link that is made and never
 * confirmed is a person left wondering whether it worked.
 *
 * Both handlers go through Deliveries first, keyed by the outbox entry and the
 * person, so an entry handled twice writes once. A confirmation Discord would
 * not take leaves the delivery pending and throws, which asks the consumer for
 * the entry again.
 */

export interface LinkHandlerOptions {
  deliveries: Deliveries;
  deliver: DirectMessageDelivery;
  /** Who a NetID is, in memory, which an unlink has to forget. */
  directory: Pick<NetIdDirectory, 'forget'>;
  /** Delete every row the bot holds for a Discord account. */
  deleteLocalData: (discordUserId: string) => Promise<void>;
}

/** What somebody reads once the web platform has recorded their link. */
export function linkConfirmation(displayName: string): string {
  const named = displayName ? `, ${displayName}` : '';
  return `This Discord account is now linked to your VIA account${named}. `
    + 'You can follow organizations, set reminders and receive updates here. '
    + 'Run the unlink command at any time to undo this.';
}

/**
 * The two fields a link entry carries, whichever of the two kinds it is. The
 * Discord account is read from the payload rather than from the subject
 * identifier, because a link has two sides and the subject identifier does not
 * say which of them it names.
 */
export function readLinkChange(entry: OutboxEntry): {
  discordUserId: string;
  displayName: string;
} {
  const payload = entry.payload;
  return {
    discordUserId: String(payload.discord_user_id ?? '').trim(),
    displayName: String(payload.display_name ?? '').trim(),
  };
}

export function createLinkHandlers(options: LinkHandlerOptions): OutboxHandlers {
  const { deliveries, deliver, directory, deleteLocalData } = options;

  return {
    async 'link.completed'(entry: OutboxEntry): Promise<void> {
      const { discordUserId, displayName } = readLinkChange(entry);
      if (!discordUserId) {
        console.log(`outbox entry ${entry.outboxId} carries no Discord account to confirm a link to`);
        return;
      }

      const intended = await deliveries.intend({
        outboxId: entry.outboxId,
        target: userTarget(discordUserId),
        purpose: entry.kind,
        kind: 'direct_message',
      });
      // A row that carries the moment it was posted is a confirmation that has
      // arrived, and a row that carries none is one that is still owed.
      if (!intended.isNew && intended.deliveredAt !== null) return;

      const outcome = await deliver(discordUserId, { content: linkConfirmation(displayName) });
      if (outcome === 'failed') {
        // The delivery row stays pending, which is what says the message was
        // owed, and the entry is asked for again.
        throw new Error(`confirming the link of ${discordUserId} failed`);
      }

      // A person who does not accept direct messages from the bot has still
      // linked, and the row is recorded because a second attempt would not
      // arrive either.
      await deliveries.recordPosted(intended.deliveryId, null);
    },

    async 'link.revoked'(entry: OutboxEntry): Promise<void> {
      const { discordUserId } = readLinkChange(entry);
      if (!discordUserId) {
        console.log(`outbox entry ${entry.outboxId} carries no Discord account to forget`);
        return;
      }

      await deleteLocalData(discordUserId);
      // The in memory directory is what turns a NetID into a Discord account
      // for the membership entries, and a link that has gone must not give
      // anybody a role.
      directory.forget(discordUserId);
      console.log(`the link of ${discordUserId} was revoked, so everything the bot held for it has gone`);
    },
  };
}
