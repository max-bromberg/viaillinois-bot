import { describe, it, expect, beforeEach } from 'vitest';
import {
  followCommand, unfollowCommand, followingCommand, calendarCommand,
  feedSettingsCommand, feedRemindersCommand, feedComponent,
  ALL_ORGANIZATIONS, FOLLOW_NOTHING_NAMED_MESSAGE, NOTHING_FOLLOWED_MESSAGE,
  NO_REMINDERS_MESSAGE, calendarAnswer, describeLead, LEAD_CHOICES, FORGET_REMINDER,
} from '../../src/commands/feed.ts';
import { rsoComponent, eventComponent, LINK_NEEDED_MESSAGE } from '../../src/commands/events.ts';
import { RSO_BUTTON, EVENT_BUTTON } from '../../src/render/eventCard.ts';
import { interaction, testContext, type TestContext } from './support.ts';

/**
 * Following, the settings panel, the reminders a person asked for, and the
 * personal calendar.
 *
 * Everything here needs a VIA account, because it is somebody's own feed, and
 * everything here is answered only to the person who asked, because a card can
 * sit in a channel a whole server reads. Two rules run through the tests. A
 * person who is not linked is answered with the Link button rather than with a
 * failure. And the set of organizations a person follows is sent to the web
 * platform whenever it changes, so that the calendar their phone subscribes to
 * stays in step without anybody asking it to.
 */
describe('the personal feed', () => {
  const ADA = '204255221017214977';
  let ctx: TestContext;

  beforeEach(() => {
    ctx = testContext();
    ctx.via.clearRsos();
    ctx.via.seedRso({ rsoId: 3, name: 'IEEE' });
    ctx.via.seedRso({ rsoId: 7, name: 'HKN' });
  });

  const asAda = (overrides: Record<string, unknown> = {}) =>
    interaction({ userId: ADA, commandName: 'follow', ...overrides });

  describe('following an organization', () => {
    it('answers somebody who has no VIA account with the link button', async () => {
      const reply = await followCommand.run(asAda({ options: { rso: '3' } }), ctx.context);
      expect(reply.content).toBe(LINK_NEEDED_MESSAGE);
      expect(reply.components![0]!.components[0]).toMatchObject({ customId: 'identity:link' });
    });

    it('records the follow and names the organization', async () => {
      ctx.via.seedLink(ADA);
      const reply = await followCommand.run(asAda({ options: { rso: '3' } }), ctx.context);

      expect(reply.content).toContain('IEEE');
      expect((await ctx.feed.follows(ADA)).rsoIds).toEqual([3]);
    });

    it('says so plainly when the person already follows it', async () => {
      ctx.via.seedLink(ADA);
      await followCommand.run(asAda({ options: { rso: '3' } }), ctx.context);
      const reply = await followCommand.run(asAda({ options: { rso: '3' } }), ctx.context);
      expect(reply.content).toContain('already');
    });

    it('follows every organization in ECE without naming one', async () => {
      ctx.via.seedLink(ADA);
      const reply = await followCommand.run(asAda({ options: { rso: ALL_ORGANIZATIONS } }), ctx.context);

      expect(reply.content).toContain('every organization');
      expect(await ctx.feed.follows(ADA)).toEqual({ all: true, rsoIds: [] });
    });

    it('asks for an organization when the command was run without one', async () => {
      ctx.via.seedLink(ADA);
      const reply = await followCommand.run(asAda({ options: {} }), ctx.context);
      expect(reply.content).toContain(FOLLOW_NOTHING_NAMED_MESSAGE);
    });

    it('refuses a name that was typed rather than chosen from the list', async () => {
      ctx.via.seedLink(ADA);
      const reply = await followCommand.run(asAda({ options: { rso: 'IEEE' } }), ctx.context);
      expect(reply.content).toContain('from the list');
      expect((await ctx.feed.follows(ADA)).rsoIds).toEqual([]);
    });

    it('says so when VIA has no organization with that identifier', async () => {
      ctx.via.seedLink(ADA);
      const reply = await followCommand.run(asAda({ options: { rso: '99' } }), ctx.context);
      expect(reply.content).toContain('does not have');
      expect((await ctx.feed.follows(ADA)).rsoIds).toEqual([]);
    });

    /**
     * Section 6.4 of the design: the calendar carries every event of the
     * organizations the person follows, and the bot updates the set whenever
     * the follows change.
     */
    it('sends the new set to the web platform, so that the calendar stays in step', async () => {
      ctx.via.seedLink(ADA);
      await ctx.via.createPersonalCalendar([], ADA);
      await followCommand.run(asAda({ options: { rso: '3' } }), ctx.context);
      for (const task of ctx.scheduled) await task();

      expect(ctx.via.personalCalendarOf(ADA)!.rsoIds).toEqual([3]);
    });

    it('says that a person who follows everything follows everything, rather than naming a set', async () => {
      ctx.via.seedLink(ADA);
      await ctx.via.createPersonalCalendar([], ADA);
      await followCommand.run(asAda({ options: { rso: ALL_ORGANIZATIONS } }), ctx.context);
      for (const task of ctx.scheduled) await task();

      expect(ctx.via.personalCalendarOf(ADA)!.rsoIds).toBe(null);
    });

    it('follows without failing when the person has no calendar yet', async () => {
      ctx.via.seedLink(ADA);
      await followCommand.run(asAda({ options: { rso: '3' } }), ctx.context);
      for (const task of ctx.scheduled) await task();
      expect((await ctx.feed.follows(ADA)).rsoIds).toEqual([3]);
    });

    it('offers every organization it can complete, and following all of them', async () => {
      const choices = await followCommand.autocomplete!(
        asAda({ kind: 'autocomplete', focusedOption: { name: 'rso', value: '' } }),
        ctx.context,
      );
      expect(choices[0]!.value).toBe(ALL_ORGANIZATIONS);
      expect(choices.map(choice => choice.value)).toContain('3');
    });

    it('completes an organization by what has been typed so far', async () => {
      const choices = await followCommand.autocomplete!(
        asAda({ kind: 'autocomplete', focusedOption: { name: 'rso', value: 'hk' } }),
        ctx.context,
      );
      expect(choices.map(choice => choice.name)).toEqual(['HKN']);
    });
  });

  describe('the follow button on the organization card', () => {
    it('follows the organization the card is for', async () => {
      ctx.via.seedLink(ADA);
      const reply = await rsoComponent.run(
        interaction({ kind: 'button', userId: ADA, customId: RSO_BUTTON.follow(3), commandName: null }),
        ctx.context,
      );

      expect(reply.content).toContain('IEEE');
      expect((await ctx.feed.follows(ADA)).rsoIds).toEqual([3]);
    });

    it('sends somebody who is not linked to the link command', async () => {
      const reply = await rsoComponent.run(
        interaction({ kind: 'button', userId: ADA, customId: RSO_BUTTON.follow(3), commandName: null }),
        ctx.context,
      );
      expect(reply.content).toBe(LINK_NEEDED_MESSAGE);
    });
  });

  describe('unfollowing', () => {
    it('stops following an organization and says so', async () => {
      ctx.via.seedLink(ADA);
      await ctx.feed.follow(ADA, 3);

      const reply = await unfollowCommand.run(
        asAda({ commandName: 'unfollow', options: { rso: '3' } }),
        ctx.context,
      );
      expect(reply.content).toContain('IEEE');
      expect((await ctx.feed.follows(ADA)).rsoIds).toEqual([]);
    });

    it('says so plainly when the person did not follow it', async () => {
      ctx.via.seedLink(ADA);
      const reply = await unfollowCommand.run(
        asAda({ commandName: 'unfollow', options: { rso: '3' } }),
        ctx.context,
      );
      expect(reply.content).toContain('nothing to stop');
    });

    it('stops following everything', async () => {
      ctx.via.seedLink(ADA);
      await ctx.feed.setFollowAll(ADA, true);

      const reply = await unfollowCommand.run(
        asAda({ commandName: 'unfollow', options: { rso: ALL_ORGANIZATIONS } }),
        ctx.context,
      );
      expect(reply.content).toContain('every organization');
      expect((await ctx.feed.follows(ADA)).all).toBe(false);
    });
  });

  describe('reading back what is followed', () => {
    it('says so in a sentence when nothing is followed', async () => {
      ctx.via.seedLink(ADA);
      const reply = await followingCommand.run(asAda({ commandName: 'following' }), ctx.context);
      expect(reply.content).toContain(NOTHING_FOLLOWED_MESSAGE);
    });

    it('lists the organizations by name', async () => {
      ctx.via.seedLink(ADA);
      await ctx.feed.follow(ADA, 3);
      await ctx.feed.follow(ADA, 7);

      const reply = await followingCommand.run(asAda({ commandName: 'following' }), ctx.context);
      expect(reply.content).toContain('IEEE');
      expect(reply.content).toContain('HKN');
    });

    it('says that a person who follows everything follows everything', async () => {
      ctx.via.seedLink(ADA);
      await ctx.feed.setFollowAll(ADA, true);
      const reply = await followingCommand.run(asAda({ commandName: 'following' }), ctx.context);
      expect(reply.content).toContain('every organization');
    });

    it('answers whether one named organization is followed', async () => {
      ctx.via.seedLink(ADA);
      await ctx.feed.follow(ADA, 3);
      const reply = await followingCommand.run(
        asAda({ commandName: 'following', options: { rso: '3' } }),
        ctx.context,
      );
      expect(reply.content).toContain('You follow IEEE.');
    });
  });

  describe('the settings panel', () => {
    it('opens on what the person has chosen, with the defaults filled in', async () => {
      ctx.via.seedLink(ADA);
      const reply = await feedSettingsCommand.run(asAda({ commandName: 'feed settings' }), ctx.context);

      expect(reply.content).toContain('Sunday');
      expect(reply.content).toContain('6 in the evening');
      expect(reply.content).toContain('an hour before an event');
      expect(reply.components!.length).toBeGreaterThan(0);
    });

    it('needs a VIA account, because the settings are about what VIA sends you', async () => {
      const reply = await feedSettingsCommand.run(asAda({ commandName: 'feed settings' }), ctx.context);
      expect(reply.content).toBe(LINK_NEEDED_MESSAGE);
    });

    it('changes the digest day', async () => {
      ctx.via.seedLink(ADA);
      const reply = await feedComponent.run(
        interaction({ kind: 'select', userId: ADA, commandName: null, customId: 'feed:day', values: ['3'] }),
        ctx.context,
      );
      expect((await ctx.feed.preferences(ADA)).digestDay).toBe(3);
      expect(reply.content).toContain('Wednesday');
    });

    it('changes the digest hour', async () => {
      ctx.via.seedLink(ADA);
      await feedComponent.run(
        interaction({ kind: 'select', userId: ADA, commandName: null, customId: 'feed:hour', values: ['9'] }),
        ctx.context,
      );
      expect((await ctx.feed.preferences(ADA)).digestHour).toBe(9);
    });

    it('changes the reminder lead time', async () => {
      ctx.via.seedLink(ADA);
      await feedComponent.run(
        interaction({ kind: 'select', userId: ADA, commandName: null, customId: 'feed:lead', values: ['120'] }),
        ctx.context,
      );
      expect((await ctx.feed.preferences(ADA)).reminderLeadMinutes).toBe(120);
    });

    it('turns the direct messages off and on again', async () => {
      ctx.via.seedLink(ADA);
      await feedComponent.run(
        interaction({ kind: 'button', userId: ADA, commandName: null, customId: 'feed:directmessages' }),
        ctx.context,
      );
      expect((await ctx.feed.preferences(ADA)).directMessageOptOut).toBe(true);

      await feedComponent.run(
        interaction({ kind: 'button', userId: ADA, commandName: null, customId: 'feed:directmessages' }),
        ctx.context,
      );
      expect((await ctx.feed.preferences(ADA)).directMessageOptOut).toBe(false);
    });

    it('turns the feedback messages off, which the sixth increment will read', async () => {
      ctx.via.seedLink(ADA);
      await feedComponent.run(
        interaction({ kind: 'button', userId: ADA, commandName: null, customId: 'feed:feedback' }),
        ctx.context,
      );
      expect((await ctx.feed.preferences(ADA)).feedbackOptOut).toBe(true);
    });
  });

  describe('the reminders a person asked for', () => {
    beforeEach(() => {
      ctx.via.clearEvents();
      ctx.via.seedEvent({
        eventId: 10,
        rsoId: 3,
        rsoName: 'IEEE',
        title: 'General meeting',
        startTime: '2026-09-10T18:00:00-05:00',
        endTime: '2026-09-10T19:00:00-05:00',
      });
    });

    it('records a reminder at the person lead time when the button is pressed', async () => {
      ctx.via.seedLink(ADA);
      const reply = await eventComponent.run(
        interaction({ kind: 'button', userId: ADA, commandName: null, customId: EVENT_BUTTON.remind(10) }),
        ctx.context,
      );

      expect(reply.content).toContain('General meeting');
      const held = await ctx.feed.listReminders(ADA);
      expect(held).toHaveLength(1);
      // An hour before six in the evening on campus.
      expect(held[0]!.remindAt).toBe('2026-09-10 17:00:00');
    });

    it('takes the reminder back when the button is pressed again', async () => {
      ctx.via.seedLink(ADA);
      const press = () => eventComponent.run(
        interaction({ kind: 'button', userId: ADA, commandName: null, customId: EVENT_BUTTON.remind(10) }),
        ctx.context,
      );
      await press();
      const reply = await press();

      expect(reply.content).toContain('no longer');
      expect(await ctx.feed.listReminders(ADA)).toEqual([]);
    });

    it('lists the reminders somebody has outstanding', async () => {
      ctx.via.seedLink(ADA);
      await ctx.feed.addReminder(ADA, 10, '2026-09-10 17:00:00');

      const reply = await feedRemindersCommand.run(asAda({ commandName: 'feed reminders' }), ctx.context);
      expect(reply.content).toContain('General meeting');
    });

    it('says so in a sentence when there are none', async () => {
      ctx.via.seedLink(ADA);
      const reply = await feedRemindersCommand.run(asAda({ commandName: 'feed reminders' }), ctx.context);
      expect(reply.content).toContain(NO_REMINDERS_MESSAGE);
    });

    /**
     * The list is where a person goes to take a reminder back, and telling
     * them to find the event and press a button on it is telling them to do
     * the bot's work. Each row carries the button that removes it.
     */
    it('carries a button that removes each reminder it lists', async () => {
      ctx.via.seedLink(ADA);
      ctx.via.seedEvent({
        eventId: 11,
        rsoId: 3,
        rsoName: 'IEEE',
        title: 'Tutoring',
        startTime: '2026-09-11T18:00:00-05:00',
        endTime: '2026-09-11T19:00:00-05:00',
      });
      await ctx.feed.addReminder(ADA, 10, '2026-09-10 17:00:00');
      await ctx.feed.addReminder(ADA, 11, '2026-09-11 17:00:00');

      const reply = await feedRemindersCommand.run(asAda({ commandName: 'feed reminders' }), ctx.context);
      const buttons = (reply.components ?? []).flatMap(row => row.components);
      expect(buttons.map(one => (one.kind === 'button' ? one.label : '')))
        .toEqual(['Remove 1', 'Remove 2']);
      expect(reply.content).toContain('1. ');
      expect(reply.content).toContain('2. ');
    });

    it('removes the reminder the button names, and lists what is left', async () => {
      ctx.via.seedLink(ADA);
      await ctx.feed.addReminder(ADA, 10, '2026-09-10 17:00:00');

      const reply = await feedComponent.run(
        interaction({ kind: 'button', userId: ADA, commandName: null, customId: FORGET_REMINDER(10) }),
        ctx.context,
      );
      expect(await ctx.feed.listReminders(ADA)).toEqual([]);
      expect(reply.content).toContain(NO_REMINDERS_MESSAGE);
    });

    it('says nothing about pressing Remind me again, because the button is here', async () => {
      ctx.via.seedLink(ADA);
      await ctx.feed.addReminder(ADA, 10, '2026-09-10 17:00:00');

      const reply = await feedRemindersCommand.run(asAda({ commandName: 'feed reminders' }), ctx.context);
      expect(reply.content).not.toContain('Press Remind me on any of them again');
    });
  });

  describe('the personal calendar', () => {
    it('answers with the address and asks the person to keep it private', async () => {
      ctx.via.seedLink(ADA);
      await ctx.feed.follow(ADA, 3);

      const reply = await calendarCommand.run(asAda({ commandName: 'calendar' }), ctx.context);
      expect(reply.content).toContain('/calendar/personal/');
      expect(reply.content).toContain('private');
      expect(ctx.via.personalCalendarOf(ADA)!.rsoIds).toEqual([3]);
    });

    it('rotates the address when it is asked for again, and says that the old one has stopped working', async () => {
      ctx.via.seedLink(ADA);
      const first = await calendarCommand.run(asAda({ commandName: 'calendar' }), ctx.context);
      const second = await calendarCommand.run(asAda({ commandName: 'calendar' }), ctx.context);
      expect(second.content).not.toBe(first.content);
    });

    it('needs a VIA account', async () => {
      const reply = await calendarCommand.run(asAda({ commandName: 'calendar' }), ctx.context);
      expect(reply.content).toBe(LINK_NEEDED_MESSAGE);
    });

    it('writes the answer as sentences a person can act on', () => {
      const content = calendarAnswer({ address: 'https://viaillinois.com/calendar/personal/abc.ics', rotatedAt: '' });
      expect(content).toContain('https://viaillinois.com/calendar/personal/abc.ics');
      expect(content).toContain('private');
    });
  });
});

/**
 * How long a lead time is, in the words the menu offers it in. A person who
 * chose "A day before" from the menu should read "a day" back, not the number
 * of minutes the bot happens to store it as.
 */
describe('how a lead time reads', () => {
  it('reads it back in the words the menu offered it in', () => {
    expect(describeLead(1440)).toBe('a day');
    expect(describeLead(60)).toBe('an hour');
    expect(describeLead(120)).toBe('two hours');
    expect(describeLead(15)).toBe('15 minutes');
  });

  it('falls back to hours for a lead time the menu does not offer', () => {
    expect(describeLead(180)).toBe('3 hours');
    expect(describeLead(45)).toBe('45 minutes');
  });

  it('offers every choice the menu carries in the menu own words', () => {
    for (const choice of LEAD_CHOICES) {
      expect(`${describeLead(choice.minutes)} before`.toLowerCase())
        .toBe(choice.label.toLowerCase());
    }
  });
});
