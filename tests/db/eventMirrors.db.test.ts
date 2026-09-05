import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { startTestDb, resetTestDb, useTestDbEnvironment } from '../support/testDb.ts';

let db: typeof import('../../src/db/client.ts').db;
let pool: typeof import('../../src/db/client.ts').pool;
let applyMigrations: typeof import('../../src/db/migrate.ts').applyMigrations;
let createGuildStore: typeof import('../../src/guilds/store.ts').createGuildStore;
let createEventMirrors: typeof import('../../src/mirror/eventMirrors.ts').createEventMirrors;

/**
 * Event_Mirrors.
 *
 * One row says what a VIA event became in one server: the Discord scheduled
 * event that mirrors it, and the announcement message that a change edits in
 * place and that a notice replies to. Both sides can be absent, because a
 * server may mirror without announcing or announce without mirroring, and
 * they are one row rather than two tables because they are two answers to the
 * same question, which is where this event is in this server.
 */
describe('what an event became in a server', () => {
  const guild = '900000000000000001';
  const other = '900000000000000002';
  const manager = '204255221017214977';
  const channel = '700000000000000001';

  beforeAll(async () => {
    await startTestDb();
    useTestDbEnvironment();
    ({ db, pool } = await import('../../src/db/client.ts'));
    ({ applyMigrations } = await import('../../src/db/migrate.ts'));
    ({ createGuildStore } = await import('../../src/guilds/store.ts'));
    ({ createEventMirrors } = await import('../../src/mirror/eventMirrors.ts'));
  }, 180_000);

  beforeEach(async () => {
    await resetTestDb();
    await applyMigrations();
    // The rows hang off the server, so the server has to exist first.
    await createGuildStore(db).createInstallation(guild, manager);
    await createGuildStore(db).createInstallation(other, manager);
  });

  afterAll(async () => { await pool.end(); });

  const mirrors = () => createEventMirrors(db, { now: () => new Date('2026-09-05T14:30:00Z') });

  it('holds nothing for an event no server has seen', async () => {
    expect(await mirrors().get(guild, 10)).toBe(null);
  });

  it('records the announcement a server posted, with the channel it went to', async () => {
    await mirrors().recordAnnouncement(guild, 10, { channelId: channel, messageId: '800000000000000001' });
    const held = await mirrors().get(guild, 10);
    expect(held!.announcementChannelId).toBe(channel);
    expect(held!.announcementMessageId).toBe('800000000000000001');
    expect(held!.scheduledEventId).toBe(null);
  });

  it('records the scheduled event a server created without losing the announcement', async () => {
    await mirrors().recordAnnouncement(guild, 10, { channelId: channel, messageId: '800000000000000001' });
    await mirrors().recordScheduledEvent(guild, 10, '600000000000000001');

    const held = await mirrors().get(guild, 10);
    expect(held!.scheduledEventId).toBe('600000000000000001');
    expect(held!.announcementMessageId).toBe('800000000000000001');
  });

  it('keeps one row per server and event, so two servers do not share an announcement', async () => {
    await mirrors().recordAnnouncement(guild, 10, { channelId: channel, messageId: '800000000000000001' });
    await mirrors().recordAnnouncement(other, 10, { channelId: channel, messageId: '800000000000000002' });

    expect((await mirrors().get(guild, 10))!.announcementMessageId).toBe('800000000000000001');
    expect((await mirrors().get(other, 10))!.announcementMessageId).toBe('800000000000000002');
  });

  it('replaces an announcement when the same event is announced again', async () => {
    await mirrors().recordAnnouncement(guild, 10, { channelId: channel, messageId: '800000000000000001' });
    await mirrors().recordAnnouncement(guild, 10, { channelId: channel, messageId: '800000000000000009' });

    expect((await mirrors().get(guild, 10))!.announcementMessageId).toBe('800000000000000009');
    expect(await mirrors().listByGuild(guild)).toHaveLength(1);
  });

  /**
   * A series is announced once, against the first of its events, so a change
   * to the series has to find that one announcement from the events the entry
   * names rather than from an event identifier it does not have.
   */
  it('finds the one announcement a series left behind, whichever of its events is named', async () => {
    await mirrors().recordScheduledEvent(guild, 10, '600000000000000001');
    await mirrors().recordAnnouncement(guild, 11, { channelId: channel, messageId: '800000000000000002' });

    const found = await mirrors().findAnnouncement(guild, [10, 11, 12]);
    expect(found!.eventId).toBe(11);
    expect(found!.announcementMessageId).toBe('800000000000000002');
  });

  it('finds no announcement when none of the events named has one', async () => {
    await mirrors().recordScheduledEvent(guild, 10, '600000000000000001');
    expect(await mirrors().findAnnouncement(guild, [10, 11])).toBe(null);
  });

  it('finds the event a Discord scheduled event mirrors, which is what an interest signal names', async () => {
    await mirrors().recordScheduledEvent(guild, 10, '600000000000000001');
    const found = await mirrors().byScheduledEvent(guild, '600000000000000001');
    expect(found!.eventId).toBe(10);
    expect(await mirrors().byScheduledEvent(other, '600000000000000001')).toBe(null);
  });

  it('lists what one server holds, and what one event became across servers', async () => {
    await mirrors().recordScheduledEvent(guild, 10, '600000000000000001');
    await mirrors().recordScheduledEvent(guild, 11, '600000000000000002');
    await mirrors().recordScheduledEvent(other, 10, '600000000000000003');

    expect((await mirrors().listByGuild(guild)).map(row => row.eventId).sort()).toEqual([10, 11]);
    expect((await mirrors().listByEvent(10)).map(row => row.guildId).sort()).toEqual([guild, other]);
  });

  it('forgets one event in one server, leaving the same event in another alone', async () => {
    await mirrors().recordScheduledEvent(guild, 10, '600000000000000001');
    await mirrors().recordScheduledEvent(other, 10, '600000000000000003');

    await mirrors().remove(guild, 10);
    expect(await mirrors().get(guild, 10)).toBe(null);
    expect(await mirrors().get(other, 10)).not.toBe(null);
  });

  it('forgets everything one server holds, which is what removal does', async () => {
    await mirrors().recordScheduledEvent(guild, 10, '600000000000000001');
    await mirrors().recordAnnouncement(guild, 11, { channelId: channel, messageId: '800000000000000002' });
    await mirrors().recordScheduledEvent(other, 10, '600000000000000003');

    expect(await mirrors().removeGuild(guild)).toBe(2);
    expect(await mirrors().listByGuild(guild)).toEqual([]);
    expect(await mirrors().listByGuild(other)).toHaveLength(1);
  });

  it('clears the scheduled event when Discord no longer has one, keeping the announcement', async () => {
    await mirrors().recordAnnouncement(guild, 10, { channelId: channel, messageId: '800000000000000001' });
    await mirrors().recordScheduledEvent(guild, 10, '600000000000000001');

    await mirrors().recordScheduledEvent(guild, 10, null);
    const held = await mirrors().get(guild, 10);
    expect(held!.scheduledEventId).toBe(null);
    expect(held!.announcementMessageId).toBe('800000000000000001');
  });
});
