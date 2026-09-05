import { describe, it, expect } from 'vitest';
import { eventsCommand, eventCommand, rsoCommand, eventsComponent, eventComponent, rsoComponent }
  from '../../src/commands/events.ts';
import { PAGE_SIZE } from '../../src/render/eventList.ts';
import type { Interaction, Reply } from '../../src/discord/adapter.ts';
import { interaction, testContext } from './support.ts';
import { ViaError } from '../../src/via/client.ts';

/**
 * The three reading commands.
 *
 * Everything here runs against the fake web platform client, so what is
 * asserted on is what a student would read. The rules that matter are the
 * ones a person would notice: the window a listing asks for, the page control
 * on a listing longer than a page, the fact that an unlinked person never
 * sees an internal event however they ask, and the two buttons that need a
 * link and say so gently rather than pretending to work.
 */

const ROSA = '204255221017214977';

function labelsOf(reply: Reply): string[] {
  return (reply.components ?? []).flatMap(row =>
    row.components.map(component => (component.kind === 'button' ? component.label : '')));
}

describe('the events command', () => {
  const ask = (options: Record<string, string | number | boolean> = {}) =>
    interaction({ commandName: 'events', options });

  it('lists what is coming up', async () => {
    const { context } = testContext();
    const reply = await eventsCommand.run(ask(), context);
    expect(reply.content).toContain('General meeting');
    expect(reply.content).toContain('Thu, Sep 10 at 6:00 PM');
  });

  it('answers only the person who asked', () => {
    expect(eventsCommand.ephemeral).toBe(true);
  });

  it('asks the web platform for the window the person chose', async () => {
    const { context, via } = testContext();
    via.seedEvent({ eventId: 40, title: 'Next month', startTime: '2026-10-20T18:00:00-05:00' });
    const reply = await eventsCommand.run(ask({ window: 'thismonth' }), context);
    expect(reply.content).toContain('General meeting');
    expect(reply.content).not.toContain('Next month');
  });

  it('lists only the organization the person named', async () => {
    const { context, via } = testContext();
    via.seedRso({ rsoId: 9, name: 'HKN' });
    via.seedEvent({ eventId: 41, rsoId: 9, rsoName: 'HKN', title: 'Tutoring' });
    const reply = await eventsCommand.run(ask({ rso: '9' }), context);
    expect(reply.content).toContain('Tutoring');
    expect(reply.content).not.toContain('General meeting');
  });

  it('says so in a sentence when the organization option is not an organization', async () => {
    const { context } = testContext();
    const reply = await eventsCommand.run(ask({ rso: 'IEEE' }), context);
    expect(reply.content).toContain('Please choose an organization from the list');
  });

  it('never shows an internal event to somebody who is not linked, even when they ask', async () => {
    const { context, via } = testContext();
    via.seedEvent({ eventId: 42, title: 'Board sync', isPrivate: true });
    const reply = await eventsCommand.run(ask({ internal: true }), context);
    expect(reply.content).not.toContain('Board sync');
  });

  it('shows an internal event to a linked member of that organization who asked for one', async () => {
    const { context, via } = testContext();
    via.seedEvent({ eventId: 42, title: 'Board sync', isPrivate: true });
    via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'member' }] });
    const reply = await eventsCommand.run(ask({ internal: true }), context);
    expect(reply.content).toContain('Board sync');
    expect(reply.content).toContain('internal');
  });

  it('pages a listing longer than one page, with a next button and no previous one', async () => {
    const { context, via } = testContext();
    for (let index = 0; index < PAGE_SIZE + 2; index++) {
      via.seedEvent({
        eventId: 200 + index,
        title: `Meeting ${index}`,
        startTime: `2026-09-${String(11 + index).padStart(2, '0')}T18:00:00-05:00`,
      });
    }
    const reply = await eventsCommand.run(ask(), context);
    expect(labelsOf(reply)).toContain('Next');
    const next = (reply.components ?? [])[1]!.components
      .find(c => c.kind === 'button' && c.label === 'Next');
    expect(next).toMatchObject({ disabled: false });
  });

  it('answers the next page when the next button is pressed', async () => {
    const { context, via } = testContext();
    for (let index = 0; index < PAGE_SIZE + 2; index++) {
      via.seedEvent({
        eventId: 200 + index,
        title: `Meeting ${index}`,
        startTime: `2026-09-${String(11 + index).padStart(2, '0')}T18:00:00-05:00`,
      });
    }
    const first = await eventsCommand.run(ask(), context);
    const next = (first.components ?? [])[1]!.components
      .find(c => c.kind === 'button' && c.label === 'Next');
    const customId = (next as { customId: string }).customId;

    const second = await eventsComponent.run(
      interaction({ kind: 'button', commandName: null, customId }),
      context,
    );
    expect(second.content).toContain('6 to 8 of 8');
  });

  it('keeps the window and the organization when the page changes', async () => {
    const { context, via } = testContext();
    via.seedRso({ rsoId: 9, name: 'HKN' });
    for (let index = 0; index < PAGE_SIZE + 1; index++) {
      via.seedEvent({
        eventId: 300 + index,
        rsoId: 9,
        rsoName: 'HKN',
        title: `Tutoring ${index}`,
        startTime: `2026-09-${String(11 + index).padStart(2, '0')}T18:00:00-05:00`,
      });
    }
    const first = await eventsCommand.run(ask({ rso: '9', window: 'thismonth' }), context);
    const next = (first.components ?? [])[1]!.components
      .find(c => c.kind === 'button' && c.label === 'Next') as { customId: string };
    const second = await eventsComponent.run(
      interaction({ kind: 'button', commandName: null, customId: next.customId }),
      context,
    );
    expect(second.content).toContain('Tutoring');
    expect(second.content).not.toContain('General meeting');
  });

  it('opens the card for the event whose row button was pressed', async () => {
    const { context } = testContext();
    const reply = await eventsComponent.run(
      interaction({ kind: 'button', commandName: null, customId: 'events:open:10' }),
      context,
    );
    expect(reply.content).toContain('General meeting');
    expect(labelsOf(reply)).toContain('Add to calendar');
  });

  it('completes organization names as a person types', async () => {
    const { context, via } = testContext();
    via.seedRso({ rsoId: 9, name: 'HKN' });
    const choices = await eventsCommand.autocomplete!(
      interaction({ kind: 'autocomplete', commandName: 'events', focusedOption: { name: 'rso', value: 'hk' } }),
      context,
    );
    expect(choices).toEqual([{ name: 'HKN', value: '9' }]);
  });

  it('completes nothing but organizations on the organization option', async () => {
    const { context } = testContext();
    const choices = await eventsCommand.autocomplete!(
      interaction({ kind: 'autocomplete', commandName: 'events', focusedOption: { name: 'window', value: 'to' } }),
      context,
    );
    expect(choices).toEqual([]);
  });

  it('offers every organization before a key is pressed', async () => {
    const { context, via } = testContext();
    via.seedRso({ rsoId: 9, name: 'HKN' });
    const choices = await eventsCommand.autocomplete!(
      interaction({ kind: 'autocomplete', commandName: 'events', focusedOption: { name: 'rso', value: '' } }),
      context,
    );
    expect(choices.map(choice => choice.name).sort()).toEqual(['HKN', 'IEEE']);
  });
});

describe('the event command', () => {
  const ask = (event: string) => interaction({ commandName: 'event', options: { event } });

  it('answers the card for the event the person chose', async () => {
    const { context } = testContext();
    const reply = await eventCommand.run(ask('10'), context);
    expect(reply.content).toContain('General meeting');
    expect(reply.content).toContain('Electrical & Computer Eng Bldg 1002');
  });

  it('says so in a sentence for an event that is not there', async () => {
    const { context } = testContext();
    const reply = await eventCommand.run(ask('999'), context);
    expect(reply.content).toContain('VIA does not have an event by that name');
  });

  it('says so in a sentence when the option is not an event at all', async () => {
    const { context } = testContext();
    const reply = await eventCommand.run(ask('general meeting'), context);
    expect(reply.content).toContain('Please choose an event from the list');
  });

  it('completes events by title and by organization name', async () => {
    const { context, via } = testContext();
    via.seedRso({ rsoId: 9, name: 'HKN' });
    via.seedEvent({ eventId: 50, rsoId: 9, rsoName: 'HKN', title: 'Tutoring' });

    const byTitle = await eventCommand.autocomplete!(
      interaction({ kind: 'autocomplete', commandName: 'event', focusedOption: { name: 'event', value: 'tutor' } }),
      context,
    );
    expect(byTitle.map(choice => choice.value)).toEqual(['50']);

    const byRso = await eventCommand.autocomplete!(
      interaction({ kind: 'autocomplete', commandName: 'event', focusedOption: { name: 'event', value: 'ieee' } }),
      context,
    );
    expect(byRso.map(choice => choice.value)).toEqual(['10']);
  });

  it('names the organization and the day in each completion, so two meetings are told apart', async () => {
    const { context } = testContext();
    const choices = await eventCommand.autocomplete!(
      interaction({ kind: 'autocomplete', commandName: 'event', focusedOption: { name: 'event', value: '' } }),
      context,
    );
    expect(choices[0]!.name).toContain('General meeting');
    expect(choices[0]!.name).toContain('IEEE');
    expect(choices[0]!.name).toContain('Sep 10');
  });

  /**
   * The completions come from the listing that does not ask for internal
   * events, because that listing is the same for everybody and is therefore
   * the one the client caches. An autocomplete fires on every keystroke, and a
   * listing that cannot be cached would mean a call to the web platform for
   * each one.
   */
  it('completes no internal event, for a member of that organization or anybody else', async () => {
    const { context, via } = testContext();
    via.seedEvent({ eventId: 51, title: 'Board sync', isPrivate: true });
    via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'board' }] });
    const choices = await eventCommand.autocomplete!(
      interaction({ kind: 'autocomplete', commandName: 'event', focusedOption: { name: 'event', value: 'board' } }),
      context,
    );
    expect(choices).toEqual([]);
  });

  it('still opens an internal event by identifier for a member of that organization', async () => {
    const { context, via } = testContext();
    via.seedEvent({ eventId: 51, title: 'Board sync', isPrivate: true });
    via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'board' }] });
    const reply = await eventCommand.run(ask('51'), context);
    expect(reply.content).toContain('Board sync');
  });
});

describe('the buttons on the event card', () => {
  const press = (customId: string, overrides: Partial<Interaction> = {}) =>
    interaction({ kind: 'button', commandName: null, customId, ...overrides });

  it('asks somebody who is not linked to link before setting a reminder', async () => {
    const { context } = testContext();
    const reply = await eventComponent.run(press('event:remind:10'), context);
    expect(reply.content).toContain('link');
    expect(labelsOf(reply)).toContain('Link my account');
  });

  it('asks somebody who is not linked to link before marking interest', async () => {
    const { context } = testContext();
    const reply = await eventComponent.run(press('event:interested:10'), context);
    expect(labelsOf(reply)).toContain('Link my account');
  });

  /**
   * Interest is what replaces the RSVPs the web platform removed, so the
   * button records it on VIA rather than in the bot, and the answer says how
   * many people are interested now, which is the one thing the person who
   * pressed it wants to know.
   */
  it('records interest on VIA for a linked person, as the person acting', async () => {
    const { context, via } = testContext();
    via.seedLink(ROSA);
    via.seedEvent({ eventId: 10, title: 'General meeting', interestCount: 3 });

    const reply = await eventComponent.run(press('event:interested:10'), context);
    expect(via.interests).toEqual([
      { eventId: 10, interested: true, actingDiscordUserId: ROSA },
    ]);
    expect(reply.content).toContain('General meeting');
    expect(reply.content).toContain('4');
  });

  it('counts one person once, however many times they press it', async () => {
    const { context, via } = testContext();
    via.seedLink(ROSA);
    via.seedEvent({ eventId: 10, interestCount: 3 });

    await eventComponent.run(press('event:interested:10'), context);
    const reply = await eventComponent.run(press('event:interested:10'), context);
    expect(reply.content).toContain('4');
  });

  it('says so in a sentence when the event has gone since the card was posted', async () => {
    const { context, via } = testContext();
    via.seedLink(ROSA);
    via.clearEvents();
    const reply = await eventComponent.run(press('event:interested:10'), context);
    expect(reply.content).toContain('VIA does not have that event any more');
  });

  it('says VIA is not answering rather than failing when the call is refused', async () => {
    const { context, via } = testContext();
    via.seedLink(ROSA);
    via.seedEvent({ eventId: 10 });
    via.failNextWith(new ViaError('The database is down.', 500, 'invalid'));

    const reply = await eventComponent.run(press('event:interested:10'), context);
    expect(reply.content).toContain('VIA is not answering right now');
  });

  it('answers the calendar file as an attachment, for anybody at all', async () => {
    const { context } = testContext();
    const reply = await eventComponent.run(press('event:calendar:10'), context);
    expect(reply.files).toHaveLength(1);
    expect(reply.files![0]!.name).toBe('via-event-10.ics');
    expect(reply.files![0]!.content).toContain('BEGIN:VCALENDAR');
    expect(reply.files![0]!.contentType).toBe('text/calendar');
  });

  it('says so in a sentence when the event a button names has gone', async () => {
    const { context } = testContext();
    const reply = await eventComponent.run(press('event:calendar:999'), context);
    expect(reply.content).toContain('VIA does not have that event any more');
  });
});

describe('the organization command', () => {
  it('answers the card for the organization the person chose', async () => {
    const { context } = testContext();
    const reply = await rsoCommand.run(interaction({ commandName: 'rso', options: { rso: '1' } }), context);
    expect(reply.content).toContain('IEEE');
    expect(reply.content).toContain('General meeting');
    expect(labelsOf(reply)).toContain('Follow');
  });

  it('says so in a sentence for an organization that is not there', async () => {
    const { context } = testContext();
    const reply = await rsoCommand.run(interaction({ commandName: 'rso', options: { rso: '999' } }), context);
    expect(reply.content).toContain('VIA does not have an organization by that name');
  });

  it('completes organization names as a person types', async () => {
    const { context, via } = testContext();
    via.seedRso({ rsoId: 9, name: 'HKN' });
    const choices = await rsoCommand.autocomplete!(
      interaction({ kind: 'autocomplete', commandName: 'rso', focusedOption: { name: 'rso', value: 'ie' } }),
      context,
    );
    expect(choices).toEqual([{ name: 'IEEE', value: '1' }]);
  });

  it('asks somebody who is not linked to link before following', async () => {
    const { context } = testContext();
    const reply = await rsoComponent.run(
      interaction({ kind: 'button', commandName: null, customId: 'rso:follow:1' }),
      context,
    );
    expect(labelsOf(reply)).toContain('Link my account');
  });
});
