import { describe, it, expect, beforeEach } from 'vitest';
import {
  createBindingReporter, createGuildBindingHandlers,
} from '../../src/guilds/binding.ts';
import { memoryGuildStore } from '../commands/support.ts';
import { createFakeViaClient } from '../../src/via/fake.ts';

/**
 * Telling the web platform which server is bound to which organization, and
 * doing what the website says when a board disconnects one.
 *
 * The binding belongs here. It is a fact about a Discord server and the bot is
 * what is installed in it, so Guild_Installations is the record of it. The
 * website has no account on this database and is not meant to have one, so a
 * board looking at their own dashboard would have nothing to read unless the
 * bot said what it has. That is what the reporter is for.
 *
 * The instruction comes back the other way, through the outbox, because the
 * website cannot reach into this database either. A board that disconnects a
 * server on the website has it cleared here when the bot next reads its
 * instructions.
 */
describe('reporting a binding to the web platform', () => {
  const GUILD = '900000000000000001';
  const MANAGER = '204255221017214977';

  let guilds: ReturnType<typeof memoryGuildStore>;
  let via: ReturnType<typeof createFakeViaClient>;

  beforeEach(async () => {
    guilds = memoryGuildStore();
    via = createFakeViaClient();
    await guilds.createInstallation(GUILD, MANAGER);
    await guilds.setKind(GUILD, 'rso');
  });

  const reporter = () => createBindingReporter({ guilds, via });

  it('tells the web platform which organization a server was bound to', async () => {
    await guilds.setBinding(GUILD, { binding: 'rso', rsoId: 4, boundBy: MANAGER });
    await reporter().report(GUILD, 'IEEE at Illinois');

    expect(via.reportedBindings).toEqual([
      { guildId: GUILD, rsoId: 4, guildName: 'IEEE at Illinois', boundBy: MANAGER },
    ]);
  });

  /**
   * A server bound to all of ECE, or to a chosen set, belongs to no single
   * organization, so there is no board whose dashboard it would appear on.
   * Reporting it would put a row under an organization that did not ask for it.
   */
  it('tells the web platform to forget a server bound to no one organization', async () => {
    await guilds.setBinding(GUILD, { binding: 'all' });
    await reporter().report(GUILD, 'ECE at Illinois');

    expect(via.reportedBindings).toEqual([]);
    expect(via.forgottenBindings).toEqual([GUILD]);
  });

  it('tells the web platform to forget a server that is not set up at all', async () => {
    await reporter().report(GUILD, 'Somewhere');
    expect(via.forgottenBindings).toEqual([GUILD]);
  });

  /**
   * The report is what the bot has, so a server that has gone is a removal
   * rather than a silence. Otherwise a board would go on being shown a server
   * the bot was thrown out of weeks ago.
   */
  it('tells the web platform to forget a server the bot has left', async () => {
    await reporter().forget(GUILD);
    expect(via.forgottenBindings).toEqual([GUILD]);
  });

  /**
   * The web platform being away is not a reason for the setup command to fail
   * in front of the person running it. The binding is already recorded here,
   * which is what makes the bot work in that server, and the mirror catches up
   * the next time anything reports.
   */
  it('does not fail the caller when the web platform will not take the report', async () => {
    await guilds.setBinding(GUILD, { binding: 'rso', rsoId: 4, boundBy: MANAGER });
    via.failNextWith(new Error('VIA did not answer.'));

    await expect(reporter().report(GUILD, 'IEEE at Illinois')).resolves.toBeUndefined();
  });
});

describe('a board disconnecting a server from the website', () => {
  const GUILD = '900000000000000001';
  const MANAGER = '204255221017214977';

  let guilds: ReturnType<typeof memoryGuildStore>;

  beforeEach(async () => {
    guilds = memoryGuildStore();
    await guilds.createInstallation(GUILD, MANAGER);
    await guilds.setKind(GUILD, 'rso');
    await guilds.setBinding(GUILD, { binding: 'rso', rsoId: 4, boundBy: MANAGER });
  });

  const handle = (payload: Record<string, unknown>) =>
    createGuildBindingHandlers({ guilds })['guild.unbound']({
      outboxId: 12, kind: 'guild.unbound', subjectType: 'guild',
      subjectId: String(payload.guild_id ?? ''), rsoId: 4, payload,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

  it('clears the binding the website says a board disconnected', async () => {
    await handle({ guild_id: GUILD, rso_id: 4 });

    const installation = await guilds.getInstallation(GUILD);
    expect(installation?.rsoId).toBe(null);
    expect(installation?.binding).toBe(null);
  });

  /**
   * The instruction names the organization the board was acting for. A server
   * that has since been bound to a different organization is not theirs to
   * disconnect any more, and clearing it would undo somebody else's setup.
   */
  it('leaves a server that has since been bound to another organization', async () => {
    await guilds.setBinding(GUILD, { binding: 'rso', rsoId: 9, boundBy: MANAGER });
    await handle({ guild_id: GUILD, rso_id: 4 });

    const installation = await guilds.getInstallation(GUILD);
    expect(installation?.rsoId).toBe(9);
  });

  /** A server the bot is no longer in is nothing to clear, and not an error. */
  it('does nothing about a server the bot has no record of', async () => {
    await expect(handle({ guild_id: '900000000000000009', rso_id: 4 }))
      .resolves.toBeUndefined();
  });

  it('does nothing when the instruction names no server', async () => {
    await expect(handle({ rso_id: 4 })).resolves.toBeUndefined();
    expect((await guilds.getInstallation(GUILD))?.rsoId).toBe(4);
  });
});

/**
 * The two moments the mirror would otherwise go stale.
 *
 * Both are the bot saying what it has rather than what changed. A server the
 * bot has left is a removal, because a board would otherwise go on being shown
 * a server the bot was thrown out of weeks ago, and a server bound during
 * setup is a report, because that is the moment the board expects to see it
 * appear on their dashboard.
 */
describe('the moments a binding is reported', () => {
  const GUILD = '900000000000000001';
  const MANAGER = '204255221017214977';

  it('tells the web platform when the bot is removed from a server', async () => {
    const { createGuildLifecycle } = await import('../../src/guilds/lifecycle.ts');
    const guilds = memoryGuildStore();
    const via = createFakeViaClient();
    await guilds.createInstallation(GUILD, MANAGER);
    await guilds.setBinding(GUILD, { binding: 'rso', rsoId: 4, boundBy: MANAGER });

    const lifecycle = createGuildLifecycle({
      guilds,
      reporter: createBindingReporter({ guilds, via }),
    });
    await lifecycle.onGuildDelete({ id: GUILD, available: true, ownerId: MANAGER });

    expect(via.forgottenBindings).toEqual([GUILD]);
  });

  /**
   * A server Discord says is unavailable is a server having an outage, not one
   * the bot was removed from, and its setup is left exactly as it was. Telling
   * the web platform it had gone would take it off the board's dashboard for
   * the length of somebody else's incident.
   */
  it('says nothing about a server that is only unavailable', async () => {
    const { createGuildLifecycle } = await import('../../src/guilds/lifecycle.ts');
    const guilds = memoryGuildStore();
    const via = createFakeViaClient();
    await guilds.createInstallation(GUILD, MANAGER);

    const lifecycle = createGuildLifecycle({
      guilds,
      reporter: createBindingReporter({ guilds, via }),
    });
    await lifecycle.onGuildDelete({ id: GUILD, available: false, ownerId: MANAGER });

    expect(via.forgottenBindings).toEqual([]);
  });
});
