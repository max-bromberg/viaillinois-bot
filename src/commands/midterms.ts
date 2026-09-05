import { featureById } from '../features/registry.ts';
import { renderMidterms } from '../render/campus.ts';
import { answerFor, requireLink } from './shared.ts';
import type { CommandContext, CommandHandler } from './types.ts';
import type { AutocompleteChoice, Interaction, Reply } from '../discord/adapter.ts';
import type { Course } from '../via/client.ts';

/**
 * The exam lookup and the courses somebody added.
 *
 * They are one module because they are one question asked twice: which course,
 * and what does VIA know about its exams. The lookup is a read anybody can
 * run, because an exam schedule is the same for everybody. The courses are a
 * person's own feed, so they need a VIA account, and they are what the exam
 * reminder job and the midterm notices are drawn from.
 *
 * A course is named by the code the web platform stores, such as ECE 385,
 * rather than by an identifier, because that is what the courses endpoint is
 * keyed by and what a student would type anyway. A code that was typed rather
 * than chosen from the completions still works, as long as VIA has a course
 * with it, which is the difference between a course and an organization: an
 * organization is chosen from a list of a few dozen and a course code is
 * something people know by heart.
 */

const lookupFeature = featureById('midterms.lookup');
const coursesFeature = featureById('feed.courses');

/** How many completions to offer, which is what Discord will show. */
const MAX_COMPLETIONS = 25;

export const NOT_A_COURSE_MESSAGE =
  'Please name a course, either by choosing one from the list Discord offers as you type or by typing its code, such as ECE 385.';

export const NO_SUCH_COURSE_MESSAGE =
  'VIA does not have a course with that code. The courses come from the university timetable, so please choose one from the list Discord offers as you type.';

export const NO_COURSES_MESSAGE =
  'You have not added any courses yet, so VIA has no exams to write to you about. Run the courses add command to add one.';

/** A course code as the web platform stores it, from whatever was typed. */
export function courseCode(raw: unknown): string {
  return String(raw ?? '').trim().replace(/\s+/g, ' ');
}

/** Whether two course codes name the same course, whatever case they were typed in. */
function sameCourse(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * The course an option names, or the reason it names none. The search is the
 * cached one, so a command and the autocomplete behind it are one call to the
 * web platform rather than two.
 */
export async function chosenCourse(
  raw: unknown,
  context: CommandContext,
  options: { sections?: boolean } = {},
): Promise<{ course: Course } | { refusal: string }> {
  const typed = courseCode(raw);
  if (!typed) return { refusal: NOT_A_COURSE_MESSAGE };

  const found = await context.via.searchCourses(typed, options);
  const course = found.find(one => sameCourse(one.courseCode, typed));
  return course ? { course } : { refusal: NO_SUCH_COURSE_MESSAGE };
}

/** The courses whose code or title matches what a person has typed so far. */
export async function completeCourses(
  interaction: Interaction,
  context: CommandContext,
): Promise<AutocompleteChoice[]> {
  if (interaction.focusedOption?.name !== 'course') return [];
  const typed = (interaction.focusedOption.value ?? '').trim();
  if (!typed) return [];

  const courses = await context.via.searchCourses(typed);
  return courses.slice(0, MAX_COMPLETIONS).map(course => ({
    name: [course.courseCode, course.title].filter(Boolean).join(', '),
    value: course.courseCode,
  }));
}

export const midtermsCommand: CommandHandler = {
  featureId: lookupFeature.id,
  name: lookupFeature.command!.name,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    try {
      const chosen = await chosenCourse(interaction.options.course, context);
      if ('refusal' in chosen) return { content: chosen.refusal };

      const midterms = await context.via.listMidterms({ course: chosen.course.courseCode });
      return { content: renderMidterms(chosen.course.courseCode, midterms) };
    } catch (err) {
      return answerFor(err);
    }
  },

  autocomplete: completeCourses,
};

/** The courses somebody added, read back as a list they can act on. */
async function coursesAnswer(interaction: Interaction, context: CommandContext): Promise<string> {
  const held = await context.feed.courses(interaction.userId);
  if (held.length === 0) return NO_COURSES_MESSAGE;
  return [
    'The courses you added:',
    ...held.map(code => `- ${code}`),
    '',
    'VIA writes to you before each confirmed exam of these courses, and when one of those exams changes.',
  ].join('\n');
}

export const coursesAddCommand: CommandHandler = {
  featureId: coursesFeature.id,
  name: `${coursesFeature.command!.group} ${coursesFeature.command!.name}`,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const needsLink = await requireLink(interaction, context);
    if (needsLink) return needsLink;

    try {
      // A person who ran the command with nothing named is asking what they
      // have, which is a better answer than a refusal on its own.
      if (courseCode(interaction.options.course) === '') {
        return { content: `${NOT_A_COURSE_MESSAGE}\n\n${await coursesAnswer(interaction, context)}` };
      }

      const chosen = await chosenCourse(interaction.options.course, context);
      if ('refusal' in chosen) return { content: chosen.refusal };

      const code = chosen.course.courseCode;
      const isNew = await context.feed.addCourse(interaction.userId, code);
      if (!isNew) return { content: `You have already added ${code}, so nothing has changed.` };

      return {
        content: `You have added ${code}. VIA will write to you before each of its confirmed exams, and when one of them changes.`,
      };
    } catch (err) {
      return answerFor(err);
    }
  },

  autocomplete: completeCourses,
};

export const coursesRemoveCommand: CommandHandler = {
  featureId: coursesFeature.id,
  name: `${coursesFeature.command!.group} ${coursesFeature.command!.alternateNames![0]!.name}`,
  ephemeral: true,

  /**
   * Removing is answered from the rows the person has rather than from the
   * catalogue, because a course the timetable no longer carries is still a row
   * they are entitled to take back.
   */
  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const needsLink = await requireLink(interaction, context);
    if (needsLink) return needsLink;

    const typed = courseCode(interaction.options.course);
    if (!typed) {
      return { content: `${NOT_A_COURSE_MESSAGE}\n\n${await coursesAnswer(interaction, context)}` };
    }

    const held = await context.feed.courses(interaction.userId);
    const code = held.find(one => sameCourse(one, typed));
    if (!code) {
      return { content: `You do not have ${typed} in your courses, so there was nothing to remove.` };
    }

    await context.feed.removeCourse(interaction.userId, code);
    return { content: `You have removed ${code}. VIA will not write to you about its exams any more.` };
  },

  /** What a person can remove is what they added, so that is what is offered. */
  async autocomplete(interaction: Interaction, context: CommandContext): Promise<AutocompleteChoice[]> {
    if (interaction.focusedOption?.name !== 'course') return [];
    const typed = (interaction.focusedOption.value ?? '').trim().toLowerCase();
    const held = await context.feed.courses(interaction.userId);
    return held
      .filter(code => !typed || code.toLowerCase().includes(typed))
      .slice(0, MAX_COMPLETIONS)
      .map(code => ({ name: code, value: code }));
  },
};

export const coursesListCommand: CommandHandler = {
  featureId: coursesFeature.id,
  name: `${coursesFeature.command!.group} ${coursesFeature.command!.alternateNames![1]!.name}`,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const needsLink = await requireLink(interaction, context);
    if (needsLink) return needsLink;
    return { content: await coursesAnswer(interaction, context) };
  },
};
