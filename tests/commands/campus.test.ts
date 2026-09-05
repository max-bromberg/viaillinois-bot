import { describe, it, expect, beforeEach } from 'vitest';
import {
  roomsCommand, courseCommand, buildingCommand,
  NOT_A_BUILDING_MESSAGE, noSuchBuildingMessage,
} from '../../src/commands/campus.ts';
import { NO_SUCH_COURSE_MESSAGE } from '../../src/commands/midterms.ts';
import { interaction, testContext, type TestContext } from './support.ts';

/**
 * The three campus lookups: a free room, a course and a building code.
 *
 * All three are reads anybody can run, and all three are answered by the web
 * platform rather than worked out here. What these tests are about is the
 * window a person gives, which the bot turns into the wall clock readings the
 * reading router parses, and the refusals, which are shown as the sentence the
 * web platform wrote rather than swallowed.
 *
 * The clock in the test context reads half past nine in the morning on campus,
 * on Saturday the fifth of September.
 */
describe('finding a free room', () => {
  const ADA = '204255221017214977';
  let ctx: TestContext;

  beforeEach(() => {
    ctx = testContext();
  });

  const asAda = (overrides: Record<string, unknown> = {}) =>
    interaction({ userId: ADA, commandName: 'rooms', ...overrides });

  it('asks for the next hour when no window was given', async () => {
    const reply = await roomsCommand.run(asAda({ options: { building: 'ECEB' } }), ctx.context);

    expect(reply.content).toContain('Electrical & Computer Eng Bldg');
    expect(reply.content).toContain('1002');
    expect(reply.content).toContain('9:30 AM');
    expect(reply.content).toContain('10:30 AM');
  });

  it('asks for the hours of the day a person named', async () => {
    const reply = await roomsCommand.run(asAda({
      options: { building: 'ECEB', date: '2026-09-10', from: '18', to: '19' },
    }), ctx.context);

    expect(reply.content).toContain('Thu, Sep 10');
    expect(reply.content).toContain('6:00 PM');
    expect(reply.content).toContain('7:00 PM');
  });

  it('asks for the whole of a day named without hours', async () => {
    const reply = await roomsCommand.run(asAda({
      options: { building: 'ECEB', date: '2026-09-10' },
    }), ctx.context);
    expect(reply.content).toContain('Thu, Sep 10');
    expect(reply.content).toContain('11:59 PM');
  });

  it('takes hours without a date as hours of today', async () => {
    const reply = await roomsCommand.run(asAda({
      options: { building: 'ECEB', from: '18', to: '19' },
    }), ctx.context);
    expect(reply.content).toContain('Sat, Sep 5');
  });

  it('says in one sentence that every room is in use', async () => {
    ctx.via.occupyRoom(5);
    const reply = await roomsCommand.run(asAda({ options: { building: 'ECEB' } }), ctx.context);
    expect(reply.content!.split('\n')).toHaveLength(1);
    expect(reply.content).toContain('in use');
  });

  it('asks for a building when the command was run without one', async () => {
    const reply = await roomsCommand.run(asAda({ options: {} }), ctx.context);
    expect(reply.content).toBe(NOT_A_BUILDING_MESSAGE);
  });

  /**
   * The reading router refuses a date it cannot parse and a window longer than
   * seven days, and both refusals carry a sentence written for a person. The
   * bot shows that sentence rather than one of its own.
   */
  it('shows the sentence the web platform refused a window with', async () => {
    const reply = await roomsCommand.run(asAda({
      options: { building: 'ECEB', date: 'next tuesday', from: '18', to: '19' },
    }), ctx.context);
    expect(reply.content).toContain('YYYY-MM-DD');
  });

  it('shows the sentence the web platform refused a window over seven days with', async () => {
    // The command itself cannot build a window that long from one date, so the
    // refusal is exercised as the web platform answers it.
    const { ViaError } = await import('../../src/via/client.ts');
    ctx.via.failNextWith(new ViaError('A window can cover at most 7 days.', 400, 'invalid'));
    const reply = await roomsCommand.run(asAda({ options: { building: 'ECEB' } }), ctx.context);
    expect(reply.content).toBe('A window can cover at most 7 days.');
  });

  it('answers with a sentence when the web platform is not answering', async () => {
    const { ViaError } = await import('../../src/via/client.ts');
    ctx.via.failNextWith(new ViaError('VIA did not answer.', 0, 'unreachable'));
    const reply = await roomsCommand.run(asAda({ options: { building: 'ECEB' } }), ctx.context);
    expect(reply.content).toContain('not answering');
  });

  it('completes a building from the rooms VIA knows and from the codes it completes', async () => {
    const choices = await roomsCommand.autocomplete!(
      asAda({ kind: 'autocomplete', focusedOption: { name: 'building', value: 'ECEB' } }),
      ctx.context,
    );
    expect(choices.map(choice => choice.value)).toContain('Electrical & Computer Eng Bldg');
    expect(choices.map(choice => choice.value)).toContain('ECEB');
  });

  it('offers the building codes before anything has been typed', async () => {
    const choices = await roomsCommand.autocomplete!(
      asAda({ kind: 'autocomplete', focusedOption: { name: 'building', value: '' } }),
      ctx.context,
    );
    expect(choices.length).toBeGreaterThan(0);
    expect(choices.map(choice => choice.value)).toContain('ECEB');
  });
});

describe('looking a course up', () => {
  const ADA = '204255221017214977';
  let ctx: TestContext;

  beforeEach(() => {
    ctx = testContext();
    ctx.via.clearCourses();
    ctx.via.seedCourse({ courseCode: 'ECE 385', title: 'Digital Systems Laboratory' });
  });

  const asAda = (overrides: Record<string, unknown> = {}) =>
    interaction({ userId: ADA, commandName: 'course', ...overrides });

  it('answers with the sections of the course, their hours and their rooms', async () => {
    const reply = await courseCommand.run(asAda({ options: { course: 'ECE 385' } }), ctx.context);
    expect(reply.content).toContain('Digital Systems Laboratory');
    expect(reply.content).toContain('Monday and Wednesday');
    expect(reply.content).toContain('Electrical & Computer Eng Bldg 1002');
  });

  it('says so when VIA has no course by that code', async () => {
    const reply = await courseCommand.run(asAda({ options: { course: 'RHET 105' } }), ctx.context);
    expect(reply.content).toBe(NO_SUCH_COURSE_MESSAGE);
  });

  it('completes a course by its code and by its title', async () => {
    const choices = await courseCommand.autocomplete!(
      asAda({ kind: 'autocomplete', focusedOption: { name: 'course', value: '385' } }),
      ctx.context,
    );
    expect(choices.map(choice => choice.value)).toEqual(['ECE 385']);
  });
});

describe('looking a building up', () => {
  const ADA = '204255221017214977';
  let ctx: TestContext;

  beforeEach(() => {
    ctx = testContext();
  });

  const asAda = (overrides: Record<string, unknown> = {}) =>
    interaction({ userId: ADA, commandName: 'building', ...overrides });

  it('says what the code stands for, and that no address is recorded', async () => {
    const reply = await buildingCommand.run(asAda({ options: { building: 'eceb' } }), ctx.context);
    expect(reply.content).toContain('Electrical & Computer Eng Bldg');
    expect(reply.content).toContain('no address');
  });

  it('gives the address when the university listing records one', async () => {
    ctx.via.seedBuilding({ code: 'ECEB', name: 'Electrical & Computer Eng Bldg', address: '306 N Wright St' });
    const reply = await buildingCommand.run(asAda({ options: { building: 'ECEB' } }), ctx.context);
    expect(reply.content).toContain('306 N Wright St');
  });

  /**
   * The codes the option completes from are the bot's own list, so the bot
   * can complete a code the web platform turns out to have no record of. The
   * answer says that VIA has no record of it rather than telling the person to
   * choose from the list they just chose from.
   */
  it('says VIA has no record of the code, naming what was asked for', async () => {
    const reply = await buildingCommand.run(asAda({ options: { building: 'ZZZ' } }), ctx.context);
    expect(reply.content).toBe(noSuchBuildingMessage('ZZZ'));
    expect(reply.content).toContain('ZZZ');
    expect(reply.content).not.toContain('Please choose');
  });

  it('asks for a building when the command was run without one', async () => {
    const reply = await buildingCommand.run(asAda({ options: {} }), ctx.context);
    expect(reply.content).toBe(NOT_A_BUILDING_MESSAGE);
  });
});
