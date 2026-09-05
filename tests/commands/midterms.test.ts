import { describe, it, expect, beforeEach } from 'vitest';
import {
  midtermsCommand, coursesAddCommand, coursesRemoveCommand, coursesListCommand,
  NOT_A_COURSE_MESSAGE, NO_COURSES_MESSAGE, NO_SUCH_COURSE_MESSAGE,
} from '../../src/commands/midterms.ts';
import { LINK_NEEDED_MESSAGE } from '../../src/commands/shared.ts';
import { noExamsFor } from '../../src/render/campus.ts';
import { interaction, testContext, type TestContext } from './support.ts';

/**
 * The exam lookup and the courses somebody added.
 *
 * The lookup is a read anybody can run, because an exam schedule is the same
 * for everybody. The courses are a person's own feed, so they need a VIA
 * account and they are answered only to the person who asked. Both find a
 * course the same way: the code Discord completed, which is what the web
 * platform stores.
 */
describe('the exams of a course', () => {
  const ADA = '204255221017214977';
  let ctx: TestContext;

  beforeEach(() => {
    ctx = testContext();
    ctx.via.clearMidterms();
    ctx.via.clearCourses();
    ctx.via.seedCourse({ courseCode: 'ECE 385', title: 'Digital Systems Laboratory' });
    ctx.via.seedCourse({ courseCode: 'ECE 391', title: 'Computer Systems Engineering', sections: [] });
    ctx.via.seedMidterm({ midtermId: 20, courseCode: 'ECE 385', title: 'Midterm 1' });
  });

  const asAda = (overrides: Record<string, unknown> = {}) =>
    interaction({ userId: ADA, commandName: 'midterms', ...overrides });

  it('answers with the exams of the course that was chosen', async () => {
    const reply = await midtermsCommand.run(asAda({ options: { course: 'ECE 385' } }), ctx.context);
    expect(reply.content).toContain('ECE 385');
    expect(reply.content).toContain('Midterm 1');
    expect(reply.content).toContain('Everitt Laboratory 151');
  });

  it('needs no VIA account, because an exam schedule is the same for everybody', async () => {
    const reply = await midtermsCommand.run(asAda({ options: { course: 'ECE 385' } }), ctx.context);
    expect(reply.content).not.toBe(LINK_NEEDED_MESSAGE);
  });

  it('says in one sentence that a course has no exams recorded', async () => {
    const reply = await midtermsCommand.run(asAda({ options: { course: 'ECE 391' } }), ctx.context);
    expect(reply.content).toBe(noExamsFor('ECE 391'));
  });

  it('asks for a course when the command was run without one', async () => {
    const reply = await midtermsCommand.run(asAda({ options: {} }), ctx.context);
    expect(reply.content).toBe(NOT_A_COURSE_MESSAGE);
  });

  it('says so when VIA has no course by that code', async () => {
    const reply = await midtermsCommand.run(asAda({ options: { course: 'RHET 105' } }), ctx.context);
    expect(reply.content).toBe(NO_SUCH_COURSE_MESSAGE);
  });

  it('answers with a sentence when the web platform is not answering', async () => {
    const { ViaError } = await import('../../src/via/client.ts');
    ctx.via.failNextWith(new ViaError('VIA did not answer.', 0, 'unreachable'));
    const reply = await midtermsCommand.run(asAda({ options: { course: 'ECE 385' } }), ctx.context);
    expect(reply.content).toContain('not answering');
  });

  it('completes a course by its code and by its title', async () => {
    const choices = await midtermsCommand.autocomplete!(
      asAda({ kind: 'autocomplete', focusedOption: { name: 'course', value: 'digital' } }),
      ctx.context,
    );
    expect(choices).toEqual([{ name: 'ECE 385, Digital Systems Laboratory', value: 'ECE 385' }]);
  });

  it('completes nothing for an option it does not answer', async () => {
    const choices = await midtermsCommand.autocomplete!(
      asAda({ kind: 'autocomplete', focusedOption: { name: 'building', value: 'ec' } }),
      ctx.context,
    );
    expect(choices).toEqual([]);
  });
});

describe('the courses somebody added', () => {
  const ADA = '204255221017214977';
  let ctx: TestContext;

  beforeEach(() => {
    ctx = testContext();
    ctx.via.clearCourses();
    ctx.via.seedCourse({ courseCode: 'ECE 385', title: 'Digital Systems Laboratory' });
    ctx.via.seedCourse({ courseCode: 'ECE 391', title: 'Computer Systems Engineering', sections: [] });
  });

  const asAda = (overrides: Record<string, unknown> = {}) =>
    interaction({ userId: ADA, commandName: 'courses add', ...overrides });

  it('answers somebody who has no VIA account with the link button', async () => {
    const reply = await coursesAddCommand.run(asAda({ options: { course: 'ECE 385' } }), ctx.context);
    expect(reply.content).toBe(LINK_NEEDED_MESSAGE);
    expect(reply.components![0]!.components[0]).toMatchObject({ customId: 'identity:link' });
  });

  it('adds a course and says what it will do about it', async () => {
    ctx.via.seedLink(ADA);
    const reply = await coursesAddCommand.run(asAda({ options: { course: 'ECE 385' } }), ctx.context);

    expect(reply.content).toContain('ECE 385');
    expect(await ctx.feed.courses(ADA)).toEqual(['ECE 385']);
  });

  it('says so plainly when the course was already added', async () => {
    ctx.via.seedLink(ADA);
    await coursesAddCommand.run(asAda({ options: { course: 'ECE 385' } }), ctx.context);
    const reply = await coursesAddCommand.run(asAda({ options: { course: 'ECE 385' } }), ctx.context);
    expect(reply.content).toContain('already');
  });

  it('refuses a course VIA does not have, rather than reminding nobody about nothing', async () => {
    ctx.via.seedLink(ADA);
    const reply = await coursesAddCommand.run(asAda({ options: { course: 'RHET 105' } }), ctx.context);
    expect(reply.content).toBe(NO_SUCH_COURSE_MESSAGE);
    expect(await ctx.feed.courses(ADA)).toEqual([]);
  });

  it('reads the courses back when the command was run without one', async () => {
    ctx.via.seedLink(ADA);
    await ctx.feed.addCourse(ADA, 'ECE 385');
    const reply = await coursesAddCommand.run(asAda({ options: {} }), ctx.context);
    expect(reply.content).toContain('ECE 385');
  });

  it('removes a course somebody added', async () => {
    ctx.via.seedLink(ADA);
    await ctx.feed.addCourse(ADA, 'ECE 385');

    const reply = await coursesRemoveCommand.run(asAda({ options: { course: 'ECE 385' } }), ctx.context);
    expect(reply.content).toContain('ECE 385');
    expect(await ctx.feed.courses(ADA)).toEqual([]);
  });

  it('says there was nothing to remove when the course was never added', async () => {
    ctx.via.seedLink(ADA);
    const reply = await coursesRemoveCommand.run(asAda({ options: { course: 'ECE 385' } }), ctx.context);
    expect(reply.content).toContain('do not');
  });

  /**
   * A course the catalogue no longer carries is still a row the person can
   * take back, so removing one is answered from what they added rather than
   * from what VIA has.
   */
  it('removes a course the catalogue no longer carries', async () => {
    ctx.via.seedLink(ADA);
    await ctx.feed.addCourse(ADA, 'ECE 999');
    const reply = await coursesRemoveCommand.run(asAda({ options: { course: 'ECE 999' } }), ctx.context);
    expect(reply.content).toContain('ECE 999');
    expect(await ctx.feed.courses(ADA)).toEqual([]);
  });

  it('reads back the courses somebody added, and says so when there are none', async () => {
    ctx.via.seedLink(ADA);
    expect((await coursesListCommand.run(asAda({ options: {} }), ctx.context)).content)
      .toBe(NO_COURSES_MESSAGE);

    await ctx.feed.addCourse(ADA, 'ECE 385');
    await ctx.feed.addCourse(ADA, 'ECE 391');
    const reply = await coursesListCommand.run(asAda({ options: {} }), ctx.context);
    expect(reply.content).toContain('ECE 385');
    expect(reply.content).toContain('ECE 391');
  });

  it('completes a course from the catalogue when one is being added', async () => {
    ctx.via.seedLink(ADA);
    const choices = await coursesAddCommand.autocomplete!(
      asAda({ kind: 'autocomplete', focusedOption: { name: 'course', value: 'ECE 3' } }),
      ctx.context,
    );
    expect(choices.map(choice => choice.value)).toEqual(['ECE 385', 'ECE 391']);
  });

  /**
   * Removing completes from what the person added rather than from the
   * catalogue, because the answer to which course to remove is the list of
   * courses they have.
   */
  it('completes a course from what the person added when one is being removed', async () => {
    ctx.via.seedLink(ADA);
    await ctx.feed.addCourse(ADA, 'ECE 385');
    const choices = await coursesRemoveCommand.autocomplete!(
      asAda({ kind: 'autocomplete', focusedOption: { name: 'course', value: '' } }),
      ctx.context,
    );
    expect(choices).toEqual([{ name: 'ECE 385', value: 'ECE 385' }]);
  });
});
