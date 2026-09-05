import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDb, resetTestDb, useTestDbEnvironment } from '../support/testDb.ts';

let db: typeof import('../../src/db/client.ts').db;
let pool: typeof import('../../src/db/client.ts').pool;
let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;
let createGuildStore: typeof import('../../src/guilds/store.ts').createGuildStore;
let createRoleGrants: typeof import('../../src/roles/grants.ts').createRoleGrants;
let createSchedulerPolls: typeof import('../../src/scheduler/polls.ts').createSchedulerPolls;

/**
 * What a board's work leaves in the database.
 *
 * Two of these claims are about rows rather than about behaviour, so they are
 * tested against a real database. The bot never removes a role it did not
 * grant, which is a claim about what Role_Grants holds and what happens to it
 * when a server is removed. And a poll is read back exactly as it was written,
 * including the evenings it offered, which is a claim about a JSON column
 * surviving a round trip through MySQL.
 */
describe('what a board leaves in the database', () => {
  const guild = '900000000000000001';
  const other = '900000000000000002';
  const manager = '204255221017214977';
  const bo = '301422551071492041';
  const memberRole = '500000000000000001';
  const boardRole = '500000000000000003';

  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ db, pool } = await import('../../src/db/client.ts'));
    ({ applyMigrations } = await import('../../src/db/migrate.ts'));
    ({ createGuildStore } = await import('../../src/guilds/store.ts'));
    ({ createRoleGrants } = await import('../../src/roles/grants.ts'));
    ({ createSchedulerPolls } = await import('../../src/scheduler/polls.ts'));
  }, 180_000);

  beforeEach(async () => {
    await resetTestDb();
    await applyMigrations();
    await createGuildStore(db).createInstallation(guild, manager);
    await createGuildStore(db).createInstallation(other, manager);
  });

  afterAll(async () => { await pool.end(); });

  describe('the board member a server was bound by', () => {
    it('is written down when the server is bound to one organization', async () => {
      const store = createGuildStore(db);
      await store.setBinding(guild, { binding: 'rso', rsoId: 1, boundBy: manager });
      expect((await store.getInstallation(guild))!.boundBy).toBe(manager);
    });

    it('is cleared when the server stops speaking for one organization', async () => {
      const store = createGuildStore(db);
      await store.setBinding(guild, { binding: 'rso', rsoId: 1, boundBy: manager });
      await store.setBinding(guild, { binding: 'all' });
      expect((await store.getInstallation(guild))!.boundBy).toBe(null);
    });

    it('is null for a server nobody has bound', async () => {
      expect((await createGuildStore(db).getInstallation(guild))!.boundBy).toBe(null);
    });
  });

  describe('the roles a server mapped', () => {
    it('holds one Discord role per VIA membership role, and replaces one that changes', async () => {
      const store = createGuildStore(db);
      await store.setRoleMapping(guild, 'member', memberRole);
      await store.setRoleMapping(guild, 'board', boardRole);
      expect(await store.listRoleMappings(guild)).toEqual({ member: memberRole, board: boardRole });

      await store.setRoleMapping(guild, 'member', boardRole);
      expect((await store.listRoleMappings(guild)).member).toBe(boardRole);
    });

    it('keeps the mappings of one server to that server', async () => {
      const store = createGuildStore(db);
      await store.setRoleMapping(guild, 'member', memberRole);
      expect(await store.listRoleMappings(other)).toEqual({});
    });

    it('forgets them when the server is removed', async () => {
      const store = createGuildStore(db);
      await store.setRoleMapping(guild, 'member', memberRole);
      await store.removeGuild(guild);
      expect(await store.listRoleMappings(guild)).toEqual({});
    });
  });

  describe('the roles the bot granted', () => {
    it('reads back only what the bot itself wrote down', async () => {
      const grants = createRoleGrants(db);
      await grants.record({
        guildId: guild, discordUserId: bo, roleId: memberRole, membershipRole: 'member',
      });

      expect(await grants.listForMember(guild, bo)).toEqual([{
        guildId: guild, discordUserId: bo, roleId: memberRole, membershipRole: 'member',
      }]);
      // A role nobody wrote down is not there to be found, which is what stops
      // the bot taking away a role a manager gave by hand.
      expect(await grants.listForMember(guild, manager)).toEqual([]);
    });

    it('records the same grant twice as one row', async () => {
      const grants = createRoleGrants(db);
      const grant = {
        guildId: guild, discordUserId: bo, roleId: memberRole, membershipRole: 'member' as const,
      };
      await grants.record(grant);
      await grants.record(grant);
      expect(await grants.listForGuild(guild)).toHaveLength(1);
    });

    it('says whether there was a grant to forget', async () => {
      const grants = createRoleGrants(db);
      await grants.record({
        guildId: guild, discordUserId: bo, roleId: memberRole, membershipRole: 'member',
      });

      expect(await grants.forget({ guildId: guild, discordUserId: bo, roleId: memberRole })).toBe(true);
      expect(await grants.forget({ guildId: guild, discordUserId: bo, roleId: memberRole })).toBe(false);
      expect(await grants.listForGuild(guild)).toEqual([]);
    });

    it('goes with the server when the server is removed', async () => {
      const grants = createRoleGrants(db);
      await grants.record({
        guildId: guild, discordUserId: bo, roleId: memberRole, membershipRole: 'member',
      });
      await grants.record({
        guildId: other, discordUserId: bo, roleId: memberRole, membershipRole: 'member',
      });

      expect(await grants.removeGuild(guild)).toBe(1);
      expect(await grants.listForGuild(guild)).toEqual([]);
      expect(await grants.listForGuild(other)).toHaveLength(1);
    });
  });

  describe('the polls the scheduler opened', () => {
    const poll = () => ({
      guildId: guild,
      channelId: '700000000000000001',
      messageId: '800000000000000001',
      rsoId: 1,
      openedBy: manager,
      ask: { rsoId: 1, span: 'term' as const, minutes: 60, earliestHour: 18, latestHour: 22 },
      candidates: [{
        startTime: '2026-09-16T18:00',
        locationId: 5,
        building: 'Electrical & Computer Eng Bldg',
        roomNumber: '1002',
        score: 91,
        intervalWeeks: 1,
        until: '2026-12-09',
        answer: 'Wednesdays at 6:00 PM, Electrical & Computer Eng',
      }],
      closesAt: '2026-09-09 12:00:00',
    });

    it('reads a poll back exactly as it was written, evenings and all', async () => {
      const polls = createSchedulerPolls(db);
      const opened = await polls.open(poll());

      const read = await polls.get(opened.pollId);
      expect(read!.ask).toEqual(poll().ask);
      expect(read!.candidates).toEqual(poll().candidates);
      expect(read!.closesAt).toBe('2026-09-09 12:00:00');
      expect(read!.closedAt).toBe(null);
    });

    it('answers with the polls whose time is up, and with nothing before then', async () => {
      const polls = createSchedulerPolls(db);
      await polls.open(poll());

      expect(await polls.due('2026-09-09 11:00:00')).toEqual([]);
      expect(await polls.due('2026-09-09 12:00:00')).toHaveLength(1);
    });

    it('stops answering with a poll whose result has been posted', async () => {
      const polls = createSchedulerPolls(db);
      const opened = await polls.open(poll());

      await polls.recordClosed(opened.pollId, '2026-09-09 12:05:00');
      expect(await polls.due('2026-09-09 13:00:00')).toEqual([]);
      expect((await polls.get(opened.pollId))!.closedAt).toBe('2026-09-09 12:05:00');
    });

    it('goes with the server when the server is removed', async () => {
      const polls = createSchedulerPolls(db);
      await polls.open(poll());
      expect(await polls.removeGuild(guild)).toBe(1);
      expect(await polls.due('2026-09-30 12:00:00')).toEqual([]);
    });
  });
});
