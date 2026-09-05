import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDb, resetTestDb, useTestDbEnvironment } from '../support/testDb.ts';

let db: typeof import('../../src/db/client.ts').db;
let pool: typeof import('../../src/db/client.ts').pool;
let schema: typeof import('../../src/db/schema.ts');
let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;
let createGuildStore: typeof import('../../src/guilds/store.ts').createGuildStore;
let features: typeof import('../../src/features/registry.ts').features;

/**
 * The server records.
 *
 * What a server is bound to, which features it changed, and which channels it
 * bound are claims about rows, so they are tested against a real database
 * rather than against a map in memory. The claim this suite cares most about
 * is that a freshly installed server is honestly recorded as one that has not
 * been set up: a server that was never asked what it is must not read back as
 * an organization server that follows every organization on campus.
 */
describe('the server records', () => {
  const guild = '900000000000000001';
  const other = '900000000000000002';
  const manager = '204255221017214977';

  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ db, pool } = await import('../../src/db/client.ts'));
    schema = await import('../../src/db/schema.ts');
    ({ applyMigrations } = await import('../../src/db/migrate.ts'));
    ({ createGuildStore } = await import('../../src/guilds/store.ts'));
    ({ features } = await import('../../src/features/registry.ts'));
  }, 180_000);

  beforeEach(async () => {
    await resetTestDb();
    await applyMigrations();
  });

  afterAll(async () => { await pool.end(); });

  const store = () => createGuildStore(db);

  it('records a server that has just installed the bot as one that is not set up', async () => {
    await store().createInstallation(guild, manager);

    const installation = await store().getInstallation(guild);
    expect(installation).not.toBeNull();
    expect(installation!.guildId).toBe(guild);
    expect(installation!.kind).toBeNull();
    expect(installation!.binding).toBeNull();
    expect(installation!.rsoId).toBeNull();
    expect(installation!.installedBy).toBe(manager);
    expect(installation!.isSetUp).toBe(false);
  });

  it('answers with nothing for a server the bot was never installed in', async () => {
    expect(await store().getInstallation(guild)).toBeNull();
  });

  it('leaves the first installation alone when the same server is announced again', async () => {
    await store().createInstallation(guild, manager);
    await store().setKind(guild, 'community');
    await store().createInstallation(guild, '301422551071492041');

    const installation = await store().getInstallation(guild);
    expect(installation!.installedBy).toBe(manager);
    expect(installation!.kind).toBe('community');
  });

  it('records the kind a manager chose', async () => {
    await store().createInstallation(guild, manager);
    await store().setKind(guild, 'rso');
    expect((await store().getInstallation(guild))!.kind).toBe('rso');
  });

  it('records a binding to one organization and clears it when the binding changes', async () => {
    await store().createInstallation(guild, manager);
    await store().setBinding(guild, { binding: 'rso', rsoId: 4 });

    let installation = await store().getInstallation(guild);
    expect(installation!.binding).toBe('rso');
    expect(installation!.rsoId).toBe(4);

    await store().setBinding(guild, { binding: 'all' });
    installation = await store().getInstallation(guild);
    expect(installation!.binding).toBe('all');
    expect(installation!.rsoId).toBeNull();
  });

  it('counts a server as set up once it has a kind and a binding', async () => {
    await store().createInstallation(guild, manager);
    await store().setKind(guild, 'community');
    expect((await store().getInstallation(guild))!.isSetUp).toBe(false);

    await store().setBinding(guild, { binding: 'all' });
    expect((await store().getInstallation(guild))!.isSetUp).toBe(true);
  });

  it('answers the registry default for every feature the server never changed', async () => {
    await store().createInstallation(guild, manager);
    for (const feature of features) {
      expect(await store().isFeatureEnabled(guild, feature.id)).toBe(feature.defaultEnabled);
    }
  });

  it('answers what the server chose for a feature it changed', async () => {
    await store().createInstallation(guild, manager);
    await store().setFeatureEnabled(guild, 'events.list', false);
    expect(await store().isFeatureEnabled(guild, 'events.list')).toBe(false);

    await store().setFeatureEnabled(guild, 'events.list', true);
    expect(await store().isFeatureEnabled(guild, 'events.list')).toBe(true);
  });

  it('refuses a feature identifier the registry does not have', async () => {
    await store().createInstallation(guild, manager);
    await expect(store().isFeatureEnabled(guild, 'events.nonesuch'))
      .rejects.toThrow('There is no feature with the identifier events.nonesuch.');
  });

  it('reads back every feature a server changed in one call', async () => {
    await store().createInstallation(guild, manager);
    await store().setFeatureEnabled(guild, 'events.list', false);
    await store().setFeatureEnabled(guild, 'identity.link', false);
    expect(await store().listFeatureChanges(guild)).toEqual({
      'events.list': false,
      'identity.link': false,
    });
  });

  it('binds a channel to a purpose and rebinds it to another channel', async () => {
    await store().createInstallation(guild, manager);
    await store().bindChannel(guild, 'announcements', '700000000000000001');
    expect(await store().listChannels(guild)).toEqual({ announcements: '700000000000000001' });

    await store().bindChannel(guild, 'announcements', '700000000000000002');
    expect(await store().listChannels(guild)).toEqual({ announcements: '700000000000000002' });
  });

  it('unbinds a channel purpose', async () => {
    await store().createInstallation(guild, manager);
    await store().bindChannel(guild, 'digest', '700000000000000003');
    await store().unbindChannel(guild, 'digest');
    expect(await store().listChannels(guild)).toEqual({});
  });

  it('replaces the followed set rather than adding to it', async () => {
    await store().createInstallation(guild, manager);
    await store().setFollowedRsos(guild, [4, 9]);
    expect(await store().listFollowedRsos(guild)).toEqual([4, 9]);

    await store().setFollowedRsos(guild, [9, 11]);
    expect(await store().listFollowedRsos(guild)).toEqual([9, 11]);

    await store().setFollowedRsos(guild, []);
    expect(await store().listFollowedRsos(guild)).toEqual([]);
  });

  it('deletes every row for a server and says how many of each it deleted', async () => {
    await store().createInstallation(guild, manager);
    await store().setKind(guild, 'community');
    await store().setBinding(guild, { binding: 'set' });
    await store().setFollowedRsos(guild, [4, 9]);
    await store().setFeatureEnabled(guild, 'events.list', false);
    await store().bindChannel(guild, 'announcements', '700000000000000001');
    await store().bindChannel(guild, 'digest', '700000000000000002');

    await store().createInstallation(other, manager);
    await store().setFollowedRsos(other, [4]);

    const deleted = await store().removeGuild(guild);
    expect(deleted).toEqual({ features: 1, channels: 2, followedRsos: 2, installation: true });

    expect(await store().getInstallation(guild)).toBeNull();
    expect(await store().listChannels(guild)).toEqual({});
    expect(await store().listFollowedRsos(guild)).toEqual([]);
    expect(await store().listFeatureChanges(guild)).toEqual({});

    expect(await store().getInstallation(other)).not.toBeNull();
    expect(await store().listFollowedRsos(other)).toEqual([4]);
  });

  it('says it deleted nothing for a server the bot was never installed in', async () => {
    expect(await store().removeGuild(guild)).toEqual({
      features: 0, channels: 0, followedRsos: 0, installation: false,
    });
  });

  it('leaves no orphan rows behind, whichever table is looked at', async () => {
    await store().createInstallation(guild, manager);
    await store().setFeatureEnabled(guild, 'events.list', false);
    await store().bindChannel(guild, 'announcements', '700000000000000001');
    await store().setFollowedRsos(guild, [4]);
    await store().removeGuild(guild);

    expect(await db.select().from(schema.guildFeatures)).toEqual([]);
    expect(await db.select().from(schema.guildChannels)).toEqual([]);
    expect(await db.select().from(schema.guildFollowedRsos)).toEqual([]);
    expect(await db.select().from(schema.guildInstallations)).toEqual([]);
  });
});
