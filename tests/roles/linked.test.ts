import { describe, it, expect } from 'vitest';
import {
  LINKED_ROLE_METADATA, registerLinkedRoleMetadata, linkedRolesAdvice,
} from '../../src/roles/linked.ts';
import { linkCommand } from '../../src/commands/link.ts';
import { interaction, testContext } from '../commands/support.ts';

/**
 * Discord's linked roles.
 *
 * An application can publish a few facts about a person, and any server can
 * then require one of them for a role of its own, through Discord's own
 * verification screen. That solves a problem every organization server already
 * has by hand: letting only students with a verified NetID into a channel.
 *
 * The bot's part of it is small and is all here. It registers the three facts
 * once at startup, and it tells a person where the verification is started
 * from, which is the server's role settings rather than any address the bot
 * can hand out. Pushing the facts themselves is the web platform's, because
 * the web platform holds the Discord authorization from the link flow.
 */

describe('the facts the application publishes', () => {
  it('registers the three facts the design names', () => {
    expect(LINKED_ROLE_METADATA.map(fact => fact.key))
      .toEqual(['verified_netid', 'on_board', 'linked_since']);
  });

  it('keys and names each fact the way Discord requires', () => {
    for (const fact of LINKED_ROLE_METADATA) {
      expect(fact.key).toMatch(/^[a-z_]{1,50}$/);
      expect(fact.name.length).toBeGreaterThan(0);
      expect(fact.name.length).toBeLessThanOrEqual(100);
      expect(fact.description.length).toBeGreaterThan(0);
      expect(fact.description.length).toBeLessThanOrEqual(200);
    }
  });

  it('puts the facts to Discord for the application the configuration names', async () => {
    const put: Array<{ route: string; body: unknown }> = [];
    const rest = { put: async (route: string, options: { body: unknown }) => { put.push({ route, body: options.body }); } };

    const registered = await registerLinkedRoleMetadata({
      rest: rest as never,
      applicationId: '1000000000000000001',
    });

    expect(registered).toBe(LINKED_ROLE_METADATA.length);
    expect(put).toHaveLength(1);
    expect(put[0]!.route).toContain('1000000000000000001');
    expect(put[0]!.body).toEqual(LINKED_ROLE_METADATA.map(fact => ({
      key: fact.key,
      name: fact.name,
      description: fact.description,
      type: fact.type,
    })));
  });

  it('says the registration failed rather than stopping the bot from starting', async () => {
    const rest = { put: async () => { throw new Error('Discord did not answer'); } };
    const registered = await registerLinkedRoleMetadata({
      rest: rest as never,
      applicationId: '1000000000000000001',
    });
    expect(registered).toBe(0);
  });
});

describe('what a person is told about linked roles', () => {
  it('says where the verification is started from, which is the server role settings', () => {
    expect(linkedRolesAdvice()).toContain('Links');
    expect(linkedRolesAdvice()).toContain('role');
  });

  it('is offered in the answer to the link command', async () => {
    const { context } = testContext();
    const reply = await linkCommand.run(interaction({ commandName: 'link' }), context);
    expect(reply.content).toContain('verified');
  });
});
