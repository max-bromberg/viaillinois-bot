import { describe, it, expect } from 'vitest';
import {
  scheduleCommand, schedulerComponent, schedulerAcceptComponent, schedulerNameComponent,
  SCHEDULER_BUTTON, POLL_HOURS,
} from '../../src/commands/scheduler.ts';
import {
  encodeProposal, encodeNaming, decodeProposal, encodeAsk, NAME_PREFIX,
} from '../../src/scheduler/proposal.ts';
import { notAnEditorMessage } from '../../src/commands/shared.ts';
import type { Interaction, Reply } from '../../src/discord/adapter.ts';
import type { CommandContext } from '../../src/commands/types.ts';
import { interaction, testContext, type TestContext } from './support.ts';
import { memorySchedulerPolls } from '../support/polls.ts';

/**
 * The scheduler, from the question to the created repeat.
 *
 * A board member asks which evenings work, reads the recommendations with
 * their scores and their reasons, opens a poll over the top few in a channel
 * their members read, and accepts one. The web platform weighs the evenings
 * and creates the repeat, so what is tested here is what the bot asks, what it
 * shows, and the one thing it promises about accepting: that it checks the
 * recommendation again first and creates nothing when what it finds is no
 * longer what was polled.
 */

const GUILD = '900000000000000001';
const CHANNEL = '900000000000000002';
const POLL_CHANNEL = '700000000000000001';
const ROSA = '204255221017214977';

function context(): TestContext {
  const started = testContext();
  started.via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'editor' }] });
  started.context.polls = memorySchedulerPolls();
  return started;
}

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

const ask = (overrides: Record<string, string> = {}) => board({
  kind: 'chatCommand',
  commandName: 'via schedule',
  options: { rso: '1', span: 'term', length: '60', earliest: '18', latest: '22', ...overrides },
});

/**
 * The handler whose prefix the identifier begins with, which is what the
 * dispatcher does. Accepting is answered by a handler of its own, because it
 * can answer with a form and Discord takes one only as the first thing said
 * about an interaction.
 */
function answer(one: Interaction, ctx: CommandContext): Promise<Reply> {
  const customId = one.customId ?? '';
  const handler = customId.startsWith(NAME_PREFIX) ? schedulerNameComponent
    : customId.startsWith(SCHEDULER_BUTTON.takePrefix) ? schedulerAcceptComponent
      : schedulerComponent;
  return handler.run(one, ctx);
}

/** The identifier of the button on an answer whose prefix a test names. */
function buttonWithPrefix(reply: Reply, prefix: string): string {
  for (const row of reply.components ?? []) {
    for (const component of row.components) {
      if (component.kind === 'button' && (component.customId ?? '').startsWith(prefix)) {
        return component.customId!;
      }
    }
  }
  throw new Error(`the answer carried no button beginning with ${prefix}`);
}

/** The identifier of the first accept button on a recommendation message. */
function firstAccept(reply: Reply): string {
  for (const row of reply.components ?? []) {
    for (const component of row.components) {
      if (component.kind === 'button' && (component.customId ?? '').startsWith(SCHEDULER_BUTTON.takePrefix)) {
        return component.customId!;
      }
    }
  }
  throw new Error('the recommendation carried no accept button');
}

describe('asking which evenings work', () => {
  it('asks the web platform for the organization, the length and the window the options named', async () => {
    const { context: ctx, via } = context();
    await scheduleCommand.run(ask(), ctx);

    expect(via.scheduleRequests).toHaveLength(1);
    const request = via.scheduleRequests[0]!;
    expect(request.rsoId).toBe(1);
    expect(request.durationMinutes).toBe(60);
    expect(request.timeConstraint).toEqual({ startHour: 18, endHour: 22 });
    expect(request.recurrence!.intervalWeeks).toBe(1);
  });

  it('asks about one week without a repeat when that is the span', async () => {
    const { context: ctx, via } = context();
    await scheduleCommand.run(ask({ span: 'week' }), ctx);
    expect(via.scheduleRequests[0]!.recurrence ?? null).toBe(null);
    expect(via.scheduleRequests[0]!.dateRange.end).toBe('2026-09-12');
  });

  /**
   * The dashboard sends the end of instruction it read from the academic
   * calendar, and the bot cannot: the internal service API has no endpoint
   * that answers when the term ends. What it sends instead is a repeat with
   * no end on it, which is how the same route the dashboard calls says "to the
   * end of instruction" and reads the date from the calendar itself. The two
   * surfaces therefore search the same weeks, and the window the bot sends is
   * only where the first meeting of the repeat is looked for.
   */
  it('leaves the end of the repeat to the web platform for a search over the term', async () => {
    const { context: ctx, via } = context();
    await scheduleCommand.run(ask({ span: 'term' }), ctx);

    const request = via.scheduleRequests[0]!;
    expect(request.recurrence).toEqual({ intervalWeeks: 1, daysOfWeek: [] });
    expect('until' in (request.recurrence as Record<string, unknown>)).toBe(false);
    expect(request.dateRange.start).toBe('2026-09-05');
  });

  it('shows each evening with its score, its clear weeks and its reasons', async () => {
    const { context: ctx } = context();
    const reply = await scheduleCommand.run(ask(), ctx);

    expect(reply.content).toContain('IEEE');
    expect(reply.content).toContain('91');
    expect(reply.content).toContain('12 of 13');
    expect(reply.content).toContain('This room is free for 12 of 13 weeks');
    expect(reply.content).toContain('Electrical & Computer Eng Bldg 1002');
  });

  it('offers a poll and an accept button for each evening', async () => {
    const { context: ctx } = context();
    const reply = await scheduleCommand.run(ask(), ctx);
    const ids = JSON.stringify(reply.components);
    expect(ids).toContain(SCHEDULER_BUTTON.poll(encodeAsk({
      rsoId: 1, span: 'term', minutes: 60, earliestHour: 18, latestHour: 22,
    })));
    expect(ids).toContain(SCHEDULER_BUTTON.takePrefix);
  });

  it('refuses somebody the web platform does not list as an editor', async () => {
    const { context: ctx, via } = testContext();
    via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'member' }] });
    const reply = await scheduleCommand.run(ask(), ctx);
    expect(reply.content).toBe(notAnEditorMessage('IEEE'));
  });

  it('says so plainly when the scheduler found nothing at all', async () => {
    const { context: ctx, via } = context();
    via.seedRecommendations({ curatedPicks: [], allOptions: [] });
    const reply = await scheduleCommand.run(ask(), ctx);
    expect(reply.content).toContain('nothing');
  });

  it('has to be run in a server, because a poll is posted in one', async () => {
    const { context: ctx } = context();
    const reply = await scheduleCommand.run(ask({}), ctx);
    expect(reply.content).not.toContain('inside a server');

    const outside = await scheduleCommand.run(
      board({ kind: 'chatCommand', commandName: 'via schedule', guildId: null, context: 'botDm', options: { rso: '1' } }),
      ctx,
    );
    expect(outside.content).toContain('inside a server');
  });
});

describe('opening a poll over the evenings', () => {
  const askText = encodeAsk({ rsoId: 1, span: 'term', minutes: 60, earliestHour: 18, latestHour: 22 });

  it('asks which channel the poll should go in', async () => {
    const { context: ctx } = context();
    const reply = await answer(board({ customId: SCHEDULER_BUTTON.poll(askText) }), ctx);

    const select = (reply.components ?? [])
      .flatMap(row => row.components)
      .find(component => component.kind === 'select');
    expect(select).toBeDefined();
    expect((select as { selectKind: string }).selectKind).toBe('channel');
  });

  it('posts one of Discord own polls over the top evenings in the channel that was chosen', async () => {
    const { context: ctx, pollsPosted: posted } = context();
    const reply = await answer(
      board({ kind: 'select', customId: SCHEDULER_BUTTON.pollIn(askText), values: [POLL_CHANNEL] }),
      ctx,
    );

    expect(posted).toHaveLength(1);
    expect(posted[0]!.channelId).toBe(POLL_CHANNEL);
    expect(posted[0]!.poll.answers.length).toBeGreaterThan(1);
    expect(posted[0]!.poll.answers[0]).toContain('Wednesdays at 6:00 PM');
    for (const answer of posted[0]!.poll.answers) {
      // Discord refuses a poll whose answers are longer than this.
      expect(answer.length).toBeLessThanOrEqual(55);
    }
    expect(posted[0]!.poll.durationHours).toBe(POLL_HOURS);
    expect(reply.content).toContain(`<#${POLL_CHANNEL}>`);
  });

  it('writes the poll down, with what was asked and what each answer stands for', async () => {
    const { context: ctx } = context();
    await answer(
      board({ kind: 'select', customId: SCHEDULER_BUTTON.pollIn(askText), values: [POLL_CHANNEL] }),
      ctx,
    );

    const written = await ctx.polls!.get(1);
    expect(written!.guildId).toBe(GUILD);
    expect(written!.channelId).toBe(POLL_CHANNEL);
    expect(written!.messageId).toBe('800000000000000001');
    expect(written!.rsoId).toBe(1);
    expect(written!.candidates.length).toBeGreaterThan(1);
    expect(written!.closedAt).toBe(null);
  });

  it('refuses to open a poll for somebody the web platform does not list as an editor', async () => {
    const { context: ctx, via, pollsPosted: posted } = testContext();
    ctx.polls = memorySchedulerPolls();
    via.seedLink(ROSA, { memberships: [{ rsoId: 1, rsoName: 'IEEE', role: 'member' }] });
    const reply = await answer(
      board({ kind: 'select', customId: SCHEDULER_BUTTON.pollIn(askText), values: [POLL_CHANNEL] }),
      ctx,
    );
    expect(reply.content).toBe(notAnEditorMessage('IEEE'));
    expect(posted).toEqual([]);
  });
});

describe('accepting a recommendation', () => {
  async function recommended(): Promise<{ started: TestContext; accept: string }> {
    const started = context();
    const reply = await scheduleCommand.run(ask(), started.context);
    return { started, accept: firstAccept(reply) };
  }

  /**
   * Accepting is two steps rather than one.
   *
   * Discord takes a form only as the first thing an application says about an
   * interaction, which leaves three seconds rather than fifteen minutes. Asking
   * the scheduler again is a call to the web platform and does not belong
   * inside that window, so accepting is answered like any other command, with
   * what it found and a button, and the button opens the form with nothing
   * behind it.
   */
  it('answers with what it found and a button, rather than with a form', async () => {
    const { started, accept } = await recommended();
    const reply = await answer(board({ customId: accept }), started.context);

    expect(started.via.calls.filter(call => call === 'recommendSchedule')).toHaveLength(2);
    expect(reply.modal).toBeUndefined();
    expect(reply.content).toContain('Wednesdays at 6:00 PM');
    expect(buttonWithPrefix(reply, NAME_PREFIX)).toBeTruthy();
  });

  it('is answered like any other command, so the check has the longer window', () => {
    expect(schedulerAcceptComponent.opensModal ?? false).toBe(false);
  });

  it('opens the form from the button, with no call to the web platform behind it', async () => {
    const { started, accept } = await recommended();
    const named = buttonWithPrefix(
      await answer(board({ customId: accept }), started.context),
      NAME_PREFIX,
    );
    const before = started.via.calls.length;

    const reply = await answer(board({ customId: named }), started.context);
    expect(reply.modal!.customId).toBe(named);
    expect(reply.modal!.fields.map(field => field.customId)).toContain('title');
    expect(started.via.calls.length).toBe(before);
    expect(schedulerNameComponent.opensModal).toBe(true);
  });

  it('creates the repeat when the form comes back, and says what was created', async () => {
    const { started, accept } = await recommended();
    const named = buttonWithPrefix(
      await answer(board({ customId: accept }), started.context),
      NAME_PREFIX,
    );
    const reply = await answer(
      board({ kind: 'modal', customId: named, fields: { title: 'Weekly meeting' } }),
      started.context,
    );

    const created = started.via.seriesRequests;
    expect(created).toHaveLength(1);
    expect(created[0]!.rsoId).toBe(1);
    expect(created[0]!.title).toBe('Weekly meeting');
    expect(created[0]!.startTime).toBe('2026-09-16 18:00:00');
    expect(created[0]!.endTime).toBe('2026-09-16 19:00:00');
    expect(created[0]!.locationId).toBe(5);
    expect(created[0]!.recurrence.intervalWeeks).toBe(1);
    expect([...created[0]!.recurrence.daysOfWeek]).toEqual(['Wed']);
    expect(created[0]!.recurrence.endsOn).toBe('2026-12-09');

    expect(reply.content).toContain('Weekly meeting');
    expect(reply.content).toContain('meetings');
  });

  it('refuses a repeat with no name rather than creating one nobody can read', async () => {
    const { started, accept } = await recommended();
    const reply = await answer(
      board({ kind: 'modal', customId: NAME_PREFIX + accept.slice(SCHEDULER_BUTTON.takePrefix.length), fields: { title: '   ' } }),
      started.context,
    );
    expect(reply.content).toContain('name');
    expect(started.via.seriesRequests).toEqual([]);
  });

  /**
   * Rooms and exams move while a poll runs, so what was polled a day ago is
   * not always what the scheduler would say now. The bot shows the difference
   * and creates nothing until somebody has read it.
   */
  it('shows what has changed since the poll, and creates nothing yet', async () => {
    const { started, accept } = await recommended();
    started.via.seedRecommendations({
      curatedPicks: [{
        startTime: '2026-09-16 18:00:00',
        endTime: '2026-09-16 19:00:00',
        locationId: 5,
        building: 'Electrical & Computer Eng Bldg',
        roomNumber: '1002',
        maxCapacity: 40,
        score: 55,
        reasons: ['This room is free for 8 of 13 weeks'],
        intervalWeeks: 1,
        daysOfWeek: ['Wed'],
        weeksTotal: 13,
        weeksClear: 8,
        conflicts: ['2026-10-21', '2026-10-28'],
        until: '2026-12-09',
      }],
      allOptions: [],
    });

    const reply = await answer(board({ customId: accept }), started.context);

    expect(reply.modal).toBeUndefined();
    expect(reply.content).toContain('changed');
    expect(reply.content).toContain('8 of 13');
    expect(started.via.seriesRequests).toEqual([]);
    expect(JSON.stringify(reply.components)).toContain(SCHEDULER_BUTTON.takePrefix);
  });

  it('says so when the evening that was polled is no longer offered at all', async () => {
    const { started, accept } = await recommended();
    started.via.seedRecommendations({ curatedPicks: [], allOptions: [] });

    const reply = await answer(board({ customId: accept }), started.context);
    expect(reply.content).toContain('no longer');
    expect(started.via.seriesRequests).toEqual([]);
  });

  it('goes ahead once the evening as it now stands is the one accepted', async () => {
    const { started, accept } = await recommended();
    const proposal = decodeProposal(accept)!;
    expect(proposal.startTime).toBe('2026-09-16T18:00');

    const reply = await answer(board({ customId: accept }), started.context);
    expect(buttonWithPrefix(reply, NAME_PREFIX)).toBeTruthy();
  });

  /**
   * The scheduler scores an evening as a number of its own, and nothing says
   * it is whole. A button carries the score rounded, and the check compares
   * the rounded score, because a score written into an identifier one way and
   * read back another is an Accept button that never works.
   */
  it('accepts an evening the scheduler scored with a fraction', async () => {
    const started = context();
    started.via.seedRecommendations({
      curatedPicks: [{
        startTime: '2026-09-16 18:00:00',
        endTime: '2026-09-16 19:00:00',
        locationId: 5,
        building: 'Electrical & Computer Eng Bldg',
        roomNumber: '1002',
        maxCapacity: 40,
        score: 87.5,
        reasons: ['This room is free for 13 of 13 weeks'],
        intervalWeeks: 1,
        daysOfWeek: ['Wed'],
        weeksTotal: 13,
        weeksClear: 13,
        conflicts: [],
        until: '2026-12-09',
      }],
      allOptions: [],
    });

    const accept = firstAccept(await scheduleCommand.run(ask(), started.context));
    expect(decodeProposal(accept)!.score).toBe(88);

    const reply = await answer(board({ customId: accept }), started.context);
    expect(reply.content).not.toContain('changed');
    expect(buttonWithPrefix(reply, NAME_PREFIX)).toBeTruthy();
  });

  it('passes on the refusal when the web platform will not create the repeat', async () => {
    const { started, accept } = await recommended();
    const named = buttonWithPrefix(
      await answer(board({ customId: accept }), started.context),
      NAME_PREFIX,
    );
    started.via.failNextWith(
      Object.assign(new Error('Location is already booked for every date in this repeat'), {
        name: 'ViaError',
      }),
    );
    const reply = await answer(
      board({ kind: 'modal', customId: named, fields: { title: 'Weekly meeting' } }),
      started.context,
    ).catch(() => ({ content: 'threw' }));
    expect(reply.content).not.toContain('meetings on');
  });
});

describe('what an accept button carries', () => {
  it('reads back exactly what was written into it', () => {
    const proposal = {
      ask: { rsoId: 1, span: 'term' as const, minutes: 60, earliestHour: 18, latestHour: 22 },
      startTime: '2026-09-16T18:00',
      locationId: 5,
      intervalWeeks: 1,
      until: '2026-12-09',
      score: 91,
    };
    const encoded = encodeProposal(proposal);
    expect(encoded.length).toBeLessThanOrEqual(100);
    expect(decodeProposal(encoded)).toEqual(proposal);
  });

  it('writes a score with a fraction in it as the nearest whole number', () => {
    const proposal = {
      ask: { rsoId: 1, span: 'term' as const, minutes: 60, earliestHour: 18, latestHour: 22 },
      startTime: '2026-09-16T18:00',
      locationId: 5,
      intervalWeeks: 1,
      until: '2026-12-09',
      score: 87.5,
    };
    expect(decodeProposal(encodeProposal(proposal))!.score).toBe(88);
  });

  it('reads back an identifier written for the button that opens the form', () => {
    const proposal = {
      ask: { rsoId: 1, span: 'term' as const, minutes: 60, earliestHour: 18, latestHour: 22 },
      startTime: '2026-09-16T18:00',
      locationId: 5,
      intervalWeeks: 1,
      until: '2026-12-09',
      score: 91,
    };
    const encoded = encodeNaming(proposal);
    expect(encoded.startsWith(NAME_PREFIX)).toBe(true);
    expect(encoded.length).toBeLessThanOrEqual(100);
    expect(decodeProposal(encoded)).toEqual(proposal);
  });

  it('reads back a search over one week, which repeats nothing', () => {
    const proposal = {
      ask: { rsoId: 9, span: 'week' as const, minutes: 90, earliestHour: 8, latestHour: 20 },
      startTime: '2026-09-16T18:30',
      locationId: null,
      intervalWeeks: 0,
      until: '',
      score: 84,
    };
    expect(decodeProposal(encodeProposal(proposal))).toEqual(proposal);
  });

  it('answers with nothing for an identifier it did not write', () => {
    expect(decodeProposal('sched:take:nonsense')).toBe(null);
    expect(decodeProposal('something:else')).toBe(null);
  });
});
