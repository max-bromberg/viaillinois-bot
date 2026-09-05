import { describe, it, expect } from 'vitest';
import { ViaBusyError, ViaError } from '../../src/via/client.ts';
import {
  postponeCommand, cancelCommand, describeCommand, visibilityCommand, repostCommand,
  noteCommand, adminComponent, adminFormComponent, ADMIN_BUTTON, FORM_PREFIX,
  NOT_LINKED_TO_ACT_MESSAGE, notAnEditorMessage,
} from '../../src/commands/admin.ts';
import { renderEventCard } from '../../src/render/eventCard.ts';
import type { Interaction, Reply } from '../../src/discord/adapter.ts';
import type { CommandContext } from '../../src/commands/types.ts';
import { interaction, testContext, type TestContext } from './support.ts';

/**
 * The administrative actions of section 6.7 of the design.
 *
 * One rule runs through every one of them: the bot asks the web platform and
 * reads the refusal. A person who has no VIA account is offered the link
 * button, a person the web platform does not list as an editor of that
 * organization is told so in one sentence, a clash is named, and a busy web
 * platform names the wait. Nothing here decides for itself who may act, and
 * these tests are written against the refusals rather than against a rule the
 * bot could get wrong on its own.
 */

const GUILD = '900000000000000001';
const CHANNEL = '900000000000000002';
const ROSA = '204255221017214977';
const EVENT = 10;

function board(overrides: Partial<Interaction> = {}): Interaction {
  return interaction({
    commandName: null,
    kind: 'button',
    guildId: GUILD,
    channelId: CHANNEL,
    userId: ROSA,
    ...overrides,
  });
}

const press = (customId: string, overrides: Partial<Interaction> = {}) =>
  board({ customId, ...overrides });

const submit = (customId: string, fields: Record<string, string>) =>
  board({ kind: 'modal', customId, fields });

/**
 * The handler whose prefix the identifier begins with, which is exactly what
 * the dispatcher does. The three actions that open a form are answered by a
 * handler of their own, because Discord takes a form only as the first thing
 * said about an interaction.
 */
function answer(one: Interaction, context: CommandContext): Promise<Reply> {
  const handler = (one.customId ?? '').startsWith(FORM_PREFIX) ? adminFormComponent : adminComponent;
  return handler.run(one, context);
}

/** A board member of the organization the recorded event belongs to. */
function withEditor(): TestContext {
  const started = testContext();
  started.via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'editor' }] });
  return started;
}

/**
 * Each administrative action, run to the point where the web platform is
 * asked. Every one of them goes through the same refusals, so they are
 * written out once here and the four outcomes are asserted over all of them.
 */
const ACTIONS: Array<{ name: string; run: (context: CommandContext) => Promise<Reply> }> = [
  {
    name: 'postpone',
    run: context => answer(
      submit(ADMIN_BUTTON.postpone(EVENT), {
        start: '2026-09-17 18:00',
        end: '2026-09-17 19:00',
        reason: 'The room flooded.',
      }),
      context,
    ),
  },
  {
    name: 'cancel',
    run: context => answer(press(ADMIN_BUTTON.confirmCancel(EVENT)), context),
  },
  {
    name: 'describe',
    run: context => answer(
      submit(ADMIN_BUTTON.describe(EVENT), { description: 'Bring two laptops.' }),
      context,
    ),
  },
  {
    name: 'visibility',
    run: context => answer(press(ADMIN_BUTTON.visibility(EVENT)), context),
  },
  {
    name: 'note',
    run: context => answer(
      submit(ADMIN_BUTTON.note(EVENT), { note: 'Use the north entrance.' }),
      context,
    ),
  },
  {
    name: 'repost',
    run: context => answer(press(ADMIN_BUTTON.repost(EVENT)), context),
  },
];

describe('the editor check every administrative action goes through', () => {
  for (const action of ACTIONS) {
    it(`offers the link button to somebody with no VIA account, for ${action.name}`, async () => {
      const { context } = testContext();
      const reply = await action.run(context);
      expect(reply.content).toBe(NOT_LINKED_TO_ACT_MESSAGE);
      expect(JSON.stringify(reply.components)).toContain('identity:link');
    });

    it(`says the web platform does not list the account as an editor, for ${action.name}`, async () => {
      const { context, via } = testContext();
      via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'member' }] });
      const reply = await action.run(context);
      expect(reply.content).toBe(notAnEditorMessage('IEEE'));
    });

    it(`names the clash when the web platform answers with a conflict, for ${action.name}`, async () => {
      const { context, via } = withEditor();
      via.failNextWith(new ViaError('That room is already booked at that time.', 409, 'conflict'));
      const reply = await action.run(context);
      expect(reply.content).toContain('That room is already booked at that time.');
      expect(reply.content).toContain('Nothing has been changed.');
    });

    it(`names the wait when the web platform is busy, for ${action.name}`, async () => {
      const { context, via } = withEditor();
      via.failNextWith(new ViaBusyError('VIA is busy.', 30));
      const reply = await action.run(context);
      expect(reply.content).toContain('Please try again in 30 seconds.');
    });
  }
});

describe('moving an event to a new time', () => {
  it('opens a form filled in with the times the event runs at now', async () => {
    const { context } = withEditor();
    const reply = await answer(press(ADMIN_BUTTON.postpone(EVENT)), context);

    expect(reply.modal!.customId).toBe(ADMIN_BUTTON.postpone(EVENT));
    const values = Object.fromEntries(reply.modal!.fields.map(field => [field.customId, field.value]));
    expect(values.start).toBe('2026-09-10 18:00');
    expect(values.end).toBe('2026-09-10 19:00');
    expect(values.reason).toBeUndefined();
  });

  it('opens the same form from the command as from the button', async () => {
    const { context } = withEditor();
    const reply = await postponeCommand.run(
      board({ kind: 'chatCommand', commandName: 'via postpone', options: { event: String(EVENT) } }),
      context,
    );
    expect(reply.modal!.customId).toBe(ADMIN_BUTTON.postpone(EVENT));
  });

  it('moves the event when the form is sent back, and says where it moved to', async () => {
    const { context, via } = withEditor();
    const reply = await answer(
      submit(ADMIN_BUTTON.postpone(EVENT), {
        start: '2026-09-17 18:00',
        end: '2026-09-17 19:00',
        reason: 'The room flooded.',
      }),
      context,
    );

    expect((await via.getEvent(EVENT))!.startTime).toBe('2026-09-17 18:00:00');
    expect(via.postponements).toEqual([{ eventId: EVENT, reason: 'The room flooded.' }]);
    expect(reply.content).toContain('General meeting');
    expect(reply.content).toContain('Sep 17');
  });

  it('refuses a time it cannot read without asking the web platform to read it', async () => {
    const { context, via } = withEditor();
    const reply = await answer(
      submit(ADMIN_BUTTON.postpone(EVENT), { start: 'next Thursday', end: 'an hour later' }),
      context,
    );
    expect(reply.content).toContain('YYYY-MM-DD');
    expect(via.calls).not.toContain('postponeEvent');
  });

  it('passes on the sentence the web platform wrote about an end before a start', async () => {
    const { context } = withEditor();
    const reply = await answer(
      submit(ADMIN_BUTTON.postpone(EVENT), { start: '2026-09-17 19:00', end: '2026-09-17 18:00' }),
      context,
    );
    expect(reply.content).toContain('after the start time');
  });
});

describe('cancelling an event', () => {
  it('asks for a confirmation first, and cancels nothing yet', async () => {
    const { context, via } = withEditor();
    const reply = await answer(press(ADMIN_BUTTON.cancel(EVENT)), context);

    expect(reply.content).toContain('General meeting');
    expect(JSON.stringify(reply.components)).toContain(ADMIN_BUTTON.confirmCancel(EVENT));
    expect((await via.getEvent(EVENT))!.cancelledAt).toBe(null);
  });

  it('cancels the event once the confirmation is pressed', async () => {
    const { context, via } = withEditor();
    const reply = await answer(press(ADMIN_BUTTON.confirmCancel(EVENT)), context);
    expect((await via.getEvent(EVENT))!.cancelledAt).not.toBe(null);
    expect(reply.content).toContain('cancelled');
  });
});

describe('changing what an event says', () => {
  it('opens a form filled in with the description the event carries now', async () => {
    const { context } = withEditor();
    const reply = await answer(press(ADMIN_BUTTON.describe(EVENT)), context);
    const values = Object.fromEntries(reply.modal!.fields.map(field => [field.customId, field.value]));
    expect(values.description).toBe('Bring a laptop.');
  });

  it('writes the new description', async () => {
    const { context, via } = withEditor();
    await answer(
      submit(ADMIN_BUTTON.describe(EVENT), { description: 'Bring two laptops.' }),
      context,
    );
    expect((await via.getEvent(EVENT))!.description).toBe('Bring two laptops.');
  });

  it('clears the description when the box is sent back empty', async () => {
    const { context, via } = withEditor();
    await answer(submit(ADMIN_BUTTON.describe(EVENT), { description: '   ' }), context);
    expect((await via.getEvent(EVENT))!.description).toBe(null);
  });
});

describe('switching an event between public and internal', () => {
  it('marks a public event internal, and says so', async () => {
    const { context, via } = withEditor();
    const reply = await answer(press(ADMIN_BUTTON.visibility(EVENT)), context);
    expect((await via.getEvent(EVENT, ROSA))!.isPrivate).toBe(true);
    expect(reply.content).toContain('internal');
  });

  it('marks an internal event public again', async () => {
    const { context, via } = withEditor();
    via.seedEvent({ eventId: EVENT, isPrivate: true });
    const reply = await answer(press(ADMIN_BUTTON.visibility(EVENT)), context);
    expect((await via.getEvent(EVENT, ROSA))!.isPrivate).toBe(false);
    expect(reply.content).toContain('everybody');
  });
});

describe('the note about where an event is', () => {
  it('opens a form filled in with the note the event carries now', async () => {
    const { context } = withEditor();
    const reply = await answer(press(ADMIN_BUTTON.note(EVENT)), context);
    const values = Object.fromEntries(reply.modal!.fields.map(field => [field.customId, field.value]));
    expect(values.note).toBe('Use the north entrance.');
  });

  it('pins the note the board wrote', async () => {
    const { context, via } = withEditor();
    await answer(submit(ADMIN_BUTTON.note(EVENT), { note: 'Meet in the lobby.' }), context);
    expect((await via.getEvent(EVENT))!.locationNote).toBe('Meet in the lobby.');
  });

  it('takes the note away when the box is sent back empty', async () => {
    const { context, via } = withEditor();
    await answer(submit(ADMIN_BUTTON.note(EVENT), { note: '' }), context);
    expect((await via.getEvent(EVENT))!.locationNote).toBe(null);
  });
});

describe('posting an announcement again', () => {
  it('posts the card in the announcements channel when the server bound one', async () => {
    const { context, guilds, posted } = withEditor();
    await guilds.createInstallation(GUILD, ROSA);
    await guilds.bindChannel(GUILD, 'announcements', '700000000000000001');

    const reply = await answer(press(ADMIN_BUTTON.repost(EVENT)), context);

    expect(posted).toHaveLength(1);
    expect(posted[0]!.channelId).toBe('700000000000000001');
    expect(posted[0]!.reply.content).toContain('General meeting');
    expect(reply.content).toContain('<#700000000000000001>');
  });

  it('posts in the channel the command was run in when no announcements channel is bound', async () => {
    const { context, guilds, posted } = withEditor();
    await guilds.createInstallation(GUILD, ROSA);
    await answer(press(ADMIN_BUTTON.repost(EVENT)), context);
    expect(posted[0]!.channelId).toBe(CHANNEL);
  });

  it('writes down the new announcement, so that a later change edits this one', async () => {
    const recorded: Array<{ guildId: string; eventId: number; messageId: string }> = [];
    const { context, guilds } = withEditor();
    await guilds.createInstallation(GUILD, ROSA);

    await answer(press(ADMIN_BUTTON.repost(EVENT)), {
      ...context,
      mirrors: {
        recordAnnouncement: async (guildId, eventId, post) => {
          recorded.push({ guildId, eventId, messageId: post.messageId });
        },
      },
    });

    expect(recorded).toEqual([{ guildId: GUILD, eventId: EVENT, messageId: '800000000000000001' }]);
  });

  it('posts nothing at all for somebody the web platform does not list as an editor', async () => {
    const { context, via, posted } = testContext();
    via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'member' }] });
    await answer(press(ADMIN_BUTTON.repost(EVENT)), context);
    expect(posted).toEqual([]);
  });

  it('reaches the same posting from the command', async () => {
    const { context, guilds, posted } = withEditor();
    await guilds.createInstallation(GUILD, ROSA);
    await repostCommand.run(
      board({ kind: 'chatCommand', commandName: 'via repost', options: { event: String(EVENT) } }),
      context,
    );
    expect(posted).toHaveLength(1);
  });
});

describe('the administrative buttons on a card', () => {
  it('are on the card a linked person opened, and on nobody else', () => {
    const event = {
      eventId: EVENT,
      rsoId: 1,
      rsoName: 'IEEE',
      title: 'General meeting',
      description: null,
      startTime: '2026-09-10T18:00:00-05:00',
      endTime: '2026-09-10T19:00:00-05:00',
      isPrivate: false,
      cancelledAt: null,
      locationId: 5,
      building: 'Electrical & Computer Eng Bldg',
      roomNumber: '1002',
      locationText: null,
      locationNote: null,
      seriesId: null,
      seriesFrequency: null,
      seriesIntervalWeeks: null,
      seriesDaysOfWeek: null,
      seriesEndsOn: null,
      interestCount: 0,
    };

    const forAnybody = renderEventCard(event, { websiteUrl: 'https://viaillinois.com' });
    expect(JSON.stringify(forAnybody.components)).not.toContain('admin:');

    const forALinkedPerson = renderEventCard(event, {
      websiteUrl: 'https://viaillinois.com',
      linked: true,
    });
    const ids = JSON.stringify(forALinkedPerson.components);
    for (const customId of [
      ADMIN_BUTTON.postpone(EVENT), ADMIN_BUTTON.cancel(EVENT), ADMIN_BUTTON.describe(EVENT),
      ADMIN_BUTTON.visibility(EVENT), ADMIN_BUTTON.note(EVENT), ADMIN_BUTTON.repost(EVENT),
    ]) {
      expect(ids).toContain(customId);
    }
    // Discord takes five buttons in a row and five rows in a message.
    expect(forALinkedPerson.components!.length).toBeLessThanOrEqual(5);
    for (const row of forALinkedPerson.components!) {
      expect(row.components.length).toBeLessThanOrEqual(5);
    }
  });

  /**
   * An announcement is read by a whole channel, and Discord has no way to show
   * one person a button and another person nothing. So the announcement
   * carries one button that opens the card, and the card that opens is the
   * private answer to whoever pressed it.
   */
  it('are reached from an announcement through the button that opens the card', async () => {
    const { context } = withEditor();
    const reply = await answer(press(ADMIN_BUTTON.manage(EVENT)), context);
    expect(reply.content).toContain('General meeting');
    expect(JSON.stringify(reply.components)).toContain(ADMIN_BUTTON.postpone(EVENT));
  });

  it('offer the link button to somebody with no VIA account who pressed the manage button', async () => {
    const { context } = testContext();
    const reply = await answer(press(ADMIN_BUTTON.manage(EVENT)), context);
    expect(reply.content).toBe(NOT_LINKED_TO_ACT_MESSAGE);
  });
});

describe('an event that VIA no longer has', () => {
  it('says so rather than opening a form over nothing', async () => {
    const { context, via } = withEditor();
    via.clearEvents();
    const reply = await answer(press(ADMIN_BUTTON.postpone(EVENT)), context);
    expect(reply.content).toContain('does not have that event');
    expect(reply.modal).toBeUndefined();
  });
});

describe('the commands the actions are also reached by', () => {
  it('names the same event the option named', async () => {
    const { context } = withEditor();
    const commands = [
      { command: cancelCommand, name: 'via cancel' },
      { command: describeCommand, name: 'via describe' },
      { command: visibilityCommand, name: 'via visibility' },
      { command: noteCommand, name: 'via note' },
    ];
    for (const { command, name } of commands) {
      const reply = await command.run(
        board({ kind: 'chatCommand', commandName: name, options: { event: String(EVENT) } }),
        context,
      );
      expect(reply.content.length + JSON.stringify(reply.modal ?? {}).length).toBeGreaterThan(0);
    }
  });

  it('refuses an event that was typed rather than chosen from the list', async () => {
    const { context } = withEditor();
    const reply = await cancelCommand.run(
      board({ kind: 'chatCommand', commandName: 'via cancel', options: { event: 'the meeting' } }),
      context,
    );
    expect(reply.content).toContain('choose an event');
  });
});
