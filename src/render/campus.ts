import { campusDate, campusDateTime, campusTimeOfDay, toInstant } from './campusTime.ts';
import { fitToMessage, groupByCampusDay, weekHeading } from './digest.ts';
import { placeOf, whenOf } from './eventCard.ts';
import type { Reply, ReplyRow } from '../discord/adapter.ts';
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
export const NO_EXAMS_THIS_WEEK = 'There are no exams this week.';

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

  const pending = pendingCount(midterms);
  const tail = pending === 0 ? [] : ['', pending === 1
    ? 'One of these times is still pending confirmation, so please check with the course before you plan around it.'
    : `${pending} of these times are still pending confirmation, so please check with the course before you plan around them.`];

  // Each exam is a line of its own, so a course with more exams than one
  // message will hold loses whole exams from the end rather than half a line.
  return fitToMessage({
    head: [`**The exams VIA has for ${courseCode}**`, ''],
    days: midterms.map(midterm => [`- ${midtermLine(midterm)}`]),
    tail,
  });
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
  const days = groups.length === 0
    ? [[NO_EXAMS_THIS_WEEK]]
    : groups.map(group => [
      `**${group.label}**`,
      ...group.events.map(midterm => `- ${midtermLine(midterm, { withCourse: true })}`),
    ]);

  return {
    content: fitToMessage({
      head: [`**The exams this week**, ${weekHeading(listing.weekStart)}`, ''],
      days,
    }),
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

/**
 * The floors, in the order a person walks up them. A room number on this
 * campus begins with the floor it is on, so the first character of the number
 * is the whole of what is read here.
 */
const FLOOR_NAMES: readonly string[] = [
  'First floor', 'Second floor', 'Third floor', 'Fourth floor', 'Fifth floor',
  'Sixth floor', 'Seventh floor', 'Eighth floor', 'Ninth floor',
];

/** The basement, which a room number writes as a leading B or a leading zero. */
const BASEMENT = 'Basement';

/**
 * What a listing too long for one message says about the floors it had to drop.
 * The digest's own sentence about the rest of the week says nothing true about
 * a building.
 */
export const ROOMS_LEFT_OUT =
  'Some floors are left out, because Discord will not carry a longer message. Please ask about a shorter window to see them all.';

/** Rooms whose numbers say nothing about where in the building they are. */
const ELSEWHERE = 'Elsewhere in the building';

/**
 * Which floor a room number names, and where that floor sorts.
 *
 * A number VIA holds that says nothing about a floor is not guessed at. Those
 * rooms are gathered at the end under a heading that says so, because a room
 * put on the wrong floor sends somebody up two flights for nothing.
 */
export function floorOf(roomNumber: string | null): { label: string; order: number } {
  const first = (roomNumber ?? '').trim().charAt(0).toUpperCase();
  if (first === 'B' || first === '0') return { label: BASEMENT, order: -1 };
  const digit = Number(first);
  if (Number.isInteger(digit) && digit >= 1 && digit <= FLOOR_NAMES.length) {
    return { label: FLOOR_NAMES[digit - 1]!, order: digit };
  }
  return { label: ELSEWHERE, order: FLOOR_NAMES.length + 1 };
}

/** What a room is called, which is its number, or its identifier where VIA has no number. */
function roomName(room: FreeRooms['locations'][number]): string {
  return room.roomNumber ?? `Room ${room.locationId}`;
}

/**
 * The free rooms gathered by floor, each floor's rooms in the order their
 * numbers run, and the floors in the order somebody walks up them.
 */
function byFloor(locations: FreeRooms['locations']): { label: string; rooms: string[] }[] {
  const floors = new Map<string, { label: string; order: number; rooms: string[] }>();
  for (const room of locations) {
    const floor = floorOf(room.roomNumber);
    const held = floors.get(floor.label) ?? { ...floor, rooms: [] };
    held.rooms.push(roomName(room));
    floors.set(floor.label, held);
  }

  return [...floors.values()]
    .sort((a, b) => a.order - b.order)
    .map(floor => ({
      label: floor.label,
      rooms: [...floor.rooms].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
    }));
}

/**
 * The rooms of a building with nothing in them for a window.
 *
 * A building with an empty hour in it has dozens of free rooms, and a column
 * of dozens of lines is not an answer anybody reads. The rooms of a floor go
 * on one line instead, so the answer is as tall as the building rather than as
 * tall as the room list, and somebody who wants the second floor reads one
 * line.
 *
 * The rooms with a projector in them are named once at the end. A note beside
 * every room number would drown the numbers themselves, and which rooms have
 * one is what somebody with a presentation is reading for.
 *
 * The building is named as the web platform canonicalized it, so somebody who
 * typed a code sees which building they actually asked about. How many people
 * a room holds is not shown, here or anywhere: the number VIA holds is not one
 * anybody measured, and it reads the same for very nearly every room.
 */
export function renderFreeRooms(free: FreeRooms, components: ReplyRow[] = []): Reply {
  const window = windowOf(free);
  if (free.locations.length === 0) {
    return {
      content: `Every room VIA knows in ${free.building} is in use ${window}.`,
      components,
    };
  }

  const count = free.locations.length;
  const equipped = free.locations.filter(room => room.hasAvEquipment).map(roomName);
  const tail = equipped.length === 0 ? [] : ['', equipped.length === 1
    ? `${equipped[0]} has audio visual equipment.`
    : `These rooms have audio visual equipment: ${equipped.join(', ')}.`];

  // Every floor is one line, and the floors are one group rather than one
  // group each, so that they read as a building rather than as a column with a
  // blank line between every pair of them. A building with more free rooms
  // than a message will hold then loses whole floors from the top down.
  return {
    content: fitToMessage({
      head: [
        `**Rooms free in ${free.building}**`,
        `${window}. ${count === 1 ? 'One room is free.' : `${count} rooms are free.`}`,
        '',
      ],
      days: [byFloor(free.locations).map(floor => `**${floor.label}**  ${floor.rooms.join(', ')}`)],
      tail,
      cutNote: ROOMS_LEFT_OUT,
    }),
    components,
  };
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
