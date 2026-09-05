import { describe, it, expect, beforeEach } from 'vitest';
import { createLinkHandlers, linkConfirmation } from '../../src/identity/links.ts';
import { createNetIdDirectory } from '../../src/roles/directory.ts';
import { userTarget } from '../../src/delivery/deliveries.ts';
import { memoryDeliveries, recordingDelivery } from '../support/proactive.ts';
import type { NetIdDirectory } from '../../src/roles/directory.ts';
import type { OutboxEntry } from '../../src/via/client.ts';

/**
 * What the bot does when the outbox says a link was made or taken away.
 *
 * Section 4 of the design: the web platform records the link, and the bot
 * learns of it through the outbox and confirms it to the person in a direct
 * message. Unlinking deletes every subscription and preference the bot held
 * for that Discord account, whichever side it was done from, so the entry is
 * what carries an unlink made on the website across to the bot.
 *
 * Both messages go through Deliveries first, keyed by the outbox entry and the
 * person, so an entry handled twice writes once.
 */

const ROSA = '204255221017214977';

function entryOf(kind: string, payload: Record<string, unknown>, outboxId = 1): OutboxEntry {
  return {
    outboxId,
    kind,
    subjectType: 'link',
    subjectId: ROSA,
    rsoId: null,
    payload,
    createdAt: '2026-09-05T12:00:00-05:00',
  };
}

const completed = (outboxId = 1) => entryOf('link.completed', {
  discord_user_id: ROSA,
  net_id: 'rgarcia7',
  display_name: 'Rosa Garcia',
}, outboxId);

const revoked = (outboxId = 2) => entryOf('link.revoked', {
  discord_user_id: ROSA,
  net_id: 'rgarcia7',
}, outboxId);

describe('the link outbox handlers', () => {
  let deliveries: ReturnType<typeof memoryDeliveries>;
  let delivery: ReturnType<typeof recordingDelivery>;
  let directory: NetIdDirectory;
  let forgotten: string[];

  function built() {
    return createLinkHandlers({
      deliveries,
      deliver: delivery.deliver,
      directory,
      deleteLocalData: async (discordUserId: string) => {
        forgotten.push(discordUserId);
      },
    });
  }

  beforeEach(() => {
    deliveries = memoryDeliveries();
    delivery = recordingDelivery();
    directory = createNetIdDirectory();
    forgotten = [];
  });

  it('answers both of the link kinds and nothing else', () => {
    expect(Object.keys(built()).sort()).toEqual(['link.completed', 'link.revoked']);
  });

  it('confirms a new link to the person by direct message', async () => {
    await built()['link.completed']!(completed());

    expect(delivery.sent).toHaveLength(1);
    expect(delivery.sent[0]!.discordUserId).toBe(ROSA);
    expect(delivery.sent[0]!.reply.content).toBe(linkConfirmation('Rosa Garcia'));
    expect(delivery.sent[0]!.reply.content).toContain('Rosa Garcia');
  });

  it('confirms once however many times the entry is handled', async () => {
    await built()['link.completed']!(completed());
    await built()['link.completed']!(completed());
    expect(delivery.sent).toHaveLength(1);
  });

  it('writes the confirmation down against the entry and the person', async () => {
    await built()['link.completed']!(completed());

    const rows = deliveries.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outboxId).toBe(1);
    expect(rows[0]!.target).toBe(userTarget(ROSA));
    expect(rows[0]!.kind).toBe('direct_message');
    expect(rows[0]!.deliveredAt).not.toBe(null);
  });

  /**
   * A confirmation Discord would not take is still owed, so the delivery row
   * stays pending and the entry is asked for again.
   */
  it('asks for the entry again when the confirmation could not be sent', async () => {
    delivery.failNext();
    await expect(built()['link.completed']!(completed())).rejects.toThrow();
    expect((await deliveries.pending())).toHaveLength(1);
  });

  it('says nothing about an entry that names no Discord account', async () => {
    await built()['link.completed']!(entryOf('link.completed', {}));
    expect(delivery.sent).toEqual([]);
  });

  it('deletes everything the bot held for an account that unlinked', async () => {
    await built()['link.revoked']!(revoked());
    expect(forgotten).toEqual([ROSA]);
  });

  it('forgets who the NetID was, so no role is given on a link that has gone', async () => {
    directory.remember({
      discordUserId: ROSA,
      netId: 'rgarcia7',
      displayName: 'Rosa Garcia',
      isGlobalAdmin: false,
      linkedAt: '2026-09-04T18:32:11-05:00',
      memberships: [],
    });
    expect(directory.discordUserFor('rgarcia7')).toBe(ROSA);

    await built()['link.revoked']!(revoked());
    expect(directory.discordUserFor('rgarcia7')).toBe(null);
  });

  it('writes to nobody about an unlink, because there is nothing to say', async () => {
    await built()['link.revoked']!(revoked());
    expect(delivery.sent).toEqual([]);
  });

  it('deletes nothing for an entry that names no Discord account', async () => {
    await built()['link.revoked']!(entryOf('link.revoked', {}));
    expect(forgotten).toEqual([]);
  });
});
