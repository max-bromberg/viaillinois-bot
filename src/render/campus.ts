import { campusDate, campusDateTime, campusTimeOfDay, toInstant } from './campusTime.ts';
import { groupByCampusDay, weekHeading } from './digest.ts';
import { placeOf, whenOf } from './eventCard.ts';
import type { Reply } from '../discord/adapter.ts';
import type { Building, Course, CourseSection, FreeRooms, Midterm } from '../via/client.ts';

/**
 * The exams and the campus lookups, written for a reader.
 *
 * Everything a student asks the bot that is not about an event is written
 * here: the exams of a course, the exams of the coming week in a server, the
 * direct messages about an exam, the free rooms of a building, the sections of
 * a course and what a building code stands for. They are one module because
 * they are one kind of answer, and because the same three rules run through
 * all of them.
 *
 * An answer with nothing in it is a sentence saying so. A room with no exam in
 * it, a course with no sections recorded and a building with no address are
 * all real answers, and an empty message reads as a bot that lost the answer
 * rather than as a campus with nothing on it.
 *
 * Times are the campus clock with Discord's relative timestamp beside them, as
 * everywhere else in the bot, because the campus clock is the hour to turn up
 * at and the relative timestamp is how far away that is.
 *
 * Every direct message ends with the way to stop that kind of message, which
 * sections 9 and 10 of the design require. A message posted in a channel
 * carries no such sentence, because what stops it is the server manager
 * switching the feature off.
 */

/** How a person stops the messages about the exams of their courses. */
export const EXAM_STOP_SENTENCE =
  'You receive this because you added this course with the courses command. Run the courses remove command to stop hearing about it, or run the feed settings command to stop the direct messages VIA sends you.';

/** What a week with no exams in it says, so that silence is never the answer. */
export const NO_EXAMS_THIS_WEEK = 'There are no exams in this week.';

/** What a course with no exams recorded says. */
export function noExamsFor(courseCode: string): string {
  return `VIA has no exams recorded for ${courseCode}, so there is nothing to show.`;
}

/** The exam as a person names it, which is the course and what the exam is called. */
export function examTitle(midterm: Midterm): string {
  return [midterm.courseCode, midterm.title].filter(Boolean).join(' ');
}

export interface MidtermLineOptions {
  /** Whether the line names the course, which a list across courses has to. */
  withCourse?: boolean;
}

/**
 * One exam on one line: what it is, when it is, and where. An exam whose time
 * nobody has confirmed says so on the line rather than in a footnote, because
 * somebody reading one line has to know that the date may move.
 */
export function midtermLine(midterm: Midterm, options: MidtermLineOptions = {}): string {
  const parts = [
    options.withCourse ? examTitle(midterm) : (midterm.title ?? midterm.courseCode),
    whenOf(midterm),
    placeOf(midterm),
  ];
  const line = parts.filter(Boolean).join(', ');
  return midterm.status === 'pending' ? `${line} (pending confirmation)` : line;
}

/** How many exams of a listing are still waiting on a confirmed time. */
function pendingCount(midterms: readonly Midterm[]): number {
  return midterms.filter(midterm => midterm.status === 'pending').length;
}

/**
 * The exams of one course, which is what the midterms command answers. Both
 * the confirmed and the pending exams are listed, because a student deciding
 * when to revise has to know that a date is not settled yet, and the sentence
 * at the end says how many of them are not.
 */
export function renderMidterms(courseCode: string, midterms: readonly Midterm[]): string {
  if (midterms.length === 0) return noExamsFor(courseCode);

  const lines = [
    `**The exams VIA has for ${courseCode}**`,
    '',
    ...midterms.map(midterm => `- ${midtermLine(midterm)}`),
  ];

  const pending = pendingCount(midterms);
  if (pending > 0) {
    lines.push('', pending === 1
      ? 'One of these times is still pending confirmation, so please check with the course before you plan around it.'
      : `${pending} of these times are still pending confirmation, so please check with the course before you plan around them.`);
  }
  return lines.join('\n');
}

/** What the exams message covers: a week and the exams that fall in it. */
export interface ExamWeekListing {
  /** The day the week begins on, as YYYY-MM-DD. */
  weekStart: string;
  midterms: readonly Midterm[];
}

/**
 * The exams of the coming week, posted in the channel a server bound. It is
 * grouped by day for the same reason the digest is: a column of twenty exams
 * is not a week anybody can read.
 */
export function renderExamsThisWeek(listing: ExamWeekListing): Reply {
  const groups = groupByCampusDay(listing.midterms);

  const body: string[] = [];
  if (groups.length === 0) {
    body.push(NO_EXAMS_THIS_WEEK);
  } else {
    for (const group of groups) {
      if (body.length > 0) body.push('');
      body.push(`**${group.label}**`);
      for (const midterm of group.events) body.push(`- ${midtermLine(midterm, { withCourse: true })}`);
    }
  }

  return {
    content: [
      `**The exams this week**, ${weekHeading(listing.weekStart)}`,
      '',
      ...body,
    ].join('\n'),
    components: [],
  };
}

/** The direct message somebody receives before an exam of a course they added. */
export function renderExamReminder(midterm: Midterm): string {
  return [
    `**${examTitle(midterm)}** is coming up.`,
    '',
    `When: ${whenOf(midterm)}`,
    `Where: ${placeOf(midterm)}`,
    '',
    EXAM_STOP_SENTENCE,
  ].join('\n');
}

/**
 * The direct message somebody receives when an exam of a course they added is
 * confirmed, changed or cancelled. It is one or two sentences, because a
 * notice a person did not ask to read has to say what happened and stop.
 */
export function renderMidtermNotice(kind: string, midterm: Midterm): string {
  const title = examTitle(midterm);
  const when = whenOf(midterm);

  const sentences = kind === 'midterm.cancelled'
    ? [`**${title}** has been cancelled, so there is nothing to turn up to on ${campusDate(midterm.startTime)}.`]
    : kind === 'midterm.updated'
      ? [`**${title}** has changed.`, `It is now on ${when}, in ${placeOf(midterm)}.`]
      : [`**${title}** has been confirmed for ${when}.`, `It is in ${placeOf(midterm)}.`];

  return [sentences.join(' '), '', EXAM_STOP_SENTENCE].join('\n');
}

/** The window a free room search covered, as a person reads it. */
function windowOf(free: FreeRooms): string {
  const from = campusDateTime(free.from);
  const to = campusDate(free.to) === campusDate(free.from)
    ? campusTimeOfDay(free.to)
    : campusDateTime(free.to);
  return to ? `${from} to ${to}` : from;
}

/** What one free room offers, which is its number, its size and its equipment. */
function roomLine(room: FreeRooms['locations'][number]): string {
  const parts = [room.roomNumber ?? `Room ${room.locationId}`];
  if (room.maxCapacity !== null) parts.push(`up to ${room.maxCapacity} people`);
  if (room.hasAvEquipment) parts.push('with audio visual equipment');
  return parts.join(', ');
}

/**
 * The rooms of a building with nothing in them for a window. The building is
 * named as the web platform canonicalized it, so somebody who typed a code
 * sees which building they actually asked about.
 */
export function renderFreeRooms(free: FreeRooms): string {
  const window = windowOf(free);
  if (free.locations.length === 0) {
    return `Every room VIA knows in ${free.building} is in use ${window}.`;
  }

  return [
    `**The rooms free in ${free.building}**, ${window}`,
    '',
    ...free.locations.map(room => `- ${roomLine(room)}`),
  ].join('\n');
}

/** The letters the timetable writes a weekday as, and the days they stand for. */
const DAY_NAMES: Record<string, string> = {
  U: 'Sunday',
  M: 'Monday',
  T: 'Tuesday',
  W: 'Wednesday',
  R: 'Thursday',
  F: 'Friday',
  S: 'Saturday',
};

/**
 * The days a section meets on, written out. The timetable writes them as one
 * letter each, which is not something to show a student, and a letter the
 * timetable used that VIA does not know is shown as it was recorded rather
 * than dropped.
 */
export function describeDays(letters: string | null): string {
  const days = [...(letters ?? '')].map(letter => DAY_NAMES[letter] ?? letter);
  if (days.length === 0) return '';
  if (days.length === 1) return days[0]!;
  return `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}`;
}

/**
 * A time of day the timetable recorded, as a person reads it. A section time
 * is a time with no date on it, so it is read against a day whose only purpose
 * is to make it a reading the campus clock can format.
 */
export function sectionTime(value: string | null): string {
  if (!value) return '';
  const instant = toInstant(`2026-01-01 ${value}`);
  return instant ? campusTimeOfDay(instant) : value;
}

/** One section on one line: the days, the hours, the room and what kind it is. */
function sectionLine(section: CourseSection): string {
  const hours = [sectionTime(section.startTime), sectionTime(section.endTime)]
    .filter(Boolean)
    .join(' to ');
  const room = [section.building, section.roomNumber].filter(Boolean).join(' ');
  const kind = [section.sectionType, section.semester].filter(Boolean).join(', ');

  const parts = [describeDays(section.dayOfWeek), hours, room].filter(Boolean);
  const line = parts.join(', ');
  return kind ? `${line} (${kind})` : line;
}

/** The sections of one course, which is what the course command answers. */
export function renderCourseSections(course: Course): string {
  if (course.sections.length === 0) {
    return `VIA has no sections recorded for ${course.courseCode}, so there is nothing to show.`;
  }

  return [
    `**${course.courseCode}**${course.title ? `, ${course.title}` : ''}`,
    '',
    ...course.sections.map(section => `- ${sectionLine(section)}`),
  ].join('\n');
}

/**
 * What a building code stands for. An address VIA does not have is said in a
 * sentence rather than guessed at, because a street number remembered wrongly
 * sends a student to the wrong door.
 */
export function renderBuilding(building: Building): string {
  return [
    `**${building.code}** is ${building.name}.`,
    building.address
      ? building.address
      : 'VIA has no address recorded for it yet, so please look the building up on the university map.',
  ].join('\n');
}
