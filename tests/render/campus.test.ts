import { describe, it, expect } from 'vitest';
import {
  EXAM_STOP_SENTENCE, NO_EXAMS_THIS_WEEK,
  midtermLine, noExamsFor, renderBuilding, renderCourseSections, renderExamReminder,
  renderExamsThisWeek, renderFreeRooms, renderMidtermNotice, renderMidterms, ROOMS_LEFT_OUT,
} from '../../src/render/campus.ts';
import { MAX_MESSAGE_LENGTH } from '../../src/render/digest.ts';
import type { Course, FreeRooms, Midterm } from '../../src/via/client.ts';

/**
 * The exams and the campus lookups, written for a reader.
 *
 * Two rules from the design are tested throughout. An answer with nothing in
 * it is a sentence saying so, because an empty message reads as a bot that
 * lost the answer. And every direct message ends with the way to stop that
 * kind of message, which sections 9 and 10 require.
 *
 * The dash characters are written as escapes here, because the language check
 * reads this file too and a test containing the character it forbids would
 * fail on its own source.
 */
const NO_DASHES = /^[^\u2013\u2014]*$/;

function midterm(overrides: Partial<Midterm> = {}): Midterm {
  return {
    midtermId: 20,
    courseCode: 'ECE 385',
    courseTitle: 'Digital Systems Laboratory',
    title: 'Midterm 1',
    startTime: '2026-10-01T19:00:00-05:00',
    endTime: '2026-10-01T21:00:00-05:00',
    status: 'confirmed',
    locationText: null,
    building: 'Everitt Laboratory',
    roomNumber: '151',
    ...overrides,
  };
}

function course(overrides: Partial<Course> = {}): Course {
  return {
    courseCode: 'ECE 385',
    title: 'Digital Systems Laboratory',
    sections: [{
      sectionId: 1,
      dayOfWeek: 'MW',
      startTime: '10:00:00',
      endTime: '11:20:00',
      semester: 'fall',
      sectionType: 'lecture',
      building: 'Electrical & Computer Eng Bldg',
      roomNumber: '1002',
    }],
    ...overrides,
  };
}

describe('the exams of one course', () => {
  it('names the course, the time and the room of each exam', () => {
    const content = renderMidterms('ECE 385', [midterm()]);

    expect(content).toContain('ECE 385');
    expect(content).toContain('Midterm 1');
    expect(content).toContain('Thu, Oct 1');
    expect(content).toContain('Everitt Laboratory 151');
    expect(content).toMatch(NO_DASHES);
  });

  it('says which of them is still pending confirmation', () => {
    const content = renderMidterms('ECE 385', [
      midterm(),
      midterm({ midtermId: 21, title: 'Midterm 2', status: 'pending', startTime: '2026-11-05T19:00:00-05:00' }),
    ]);

    expect(content).toContain('Midterm 2');
    expect(content).toContain('pending confirmation');
    expect(content).toMatch(NO_DASHES);
  });

  it('says nothing about confirmation when every exam is confirmed', () => {
    expect(renderMidterms('ECE 385', [midterm()])).not.toContain('pending');
  });

  it('answers an empty schedule with one sentence', () => {
    const content = renderMidterms('ECE 385', []);
    expect(content).toBe(noExamsFor('ECE 385'));
    expect(content.split('\n')).toHaveLength(1);
    expect(content).toMatch(NO_DASHES);
  });

  it('says where an exam is when VIA has no room for it', () => {
    const content = renderMidterms('ECE 385', [
      midterm({ building: null, roomNumber: null, locationText: null }),
    ]);
    expect(content).toContain('has not been announced');
  });

  it('writes one exam on one line, with the campus clock and the relative time', () => {
    const line = midtermLine(midterm());
    expect(line).toContain('7:00 PM');
    expect(line).toContain('<t:');
    expect(line).toMatch(NO_DASHES);
  });
});

describe('the exams of the coming week, in a server', () => {
  it('groups the week by day and names each exam with its course', () => {
    const reply = renderExamsThisWeek({
      weekStart: '2026-09-27',
      midterms: [
        midterm({ midtermId: 21, courseCode: 'ECE 391', startTime: '2026-10-02T19:00:00-05:00', title: 'Midterm 1' }),
        midterm(),
      ],
    });

    const lines = reply.content!.split('\n');
    expect(lines[0]).toContain('exams');
    expect(reply.content).toContain('Thu, Oct 1');
    expect(reply.content).toContain('Fri, Oct 2');
    expect(reply.content!.indexOf('ECE 385')).toBeLessThan(reply.content!.indexOf('ECE 391'));
    expect(reply.content).toMatch(NO_DASHES);
  });

  it('says in a sentence that a week has no exams in it', () => {
    const reply = renderExamsThisWeek({ weekStart: '2026-09-27', midterms: [] });
    expect(reply.content).toContain(NO_EXAMS_THIS_WEEK);
    expect(reply.content).toMatch(NO_DASHES);
  });
});

describe('the direct messages about an exam', () => {
  it('reminds a person of an exam and says how to stop the reminders', () => {
    const content = renderExamReminder(midterm());
    expect(content).toContain('ECE 385');
    expect(content).toContain('Everitt Laboratory 151');
    expect(content.endsWith(EXAM_STOP_SENTENCE)).toBe(true);
    expect(content).toMatch(NO_DASHES);
  });

  it('says that an exam has been confirmed, with its time and room', () => {
    const content = renderMidtermNotice('midterm.confirmed', midterm());
    expect(content).toContain('confirmed');
    expect(content).toContain('ECE 385');
    expect(content).toContain('Thu, Oct 1');
    expect(content.endsWith(EXAM_STOP_SENTENCE)).toBe(true);
    expect(content).toMatch(NO_DASHES);
  });

  it('says that an exam has changed, and where it is now', () => {
    const content = renderMidtermNotice('midterm.updated', midterm({ roomNumber: '245' }));
    expect(content).toContain('changed');
    expect(content).toContain('Everitt Laboratory 245');
    expect(content).toMatch(NO_DASHES);
  });

  it('says that an exam has been cancelled, without a room to turn up to', () => {
    const content = renderMidtermNotice('midterm.cancelled', midterm({ status: 'cancelled' }));
    expect(content).toContain('cancelled');
    expect(content).toContain('ECE 385');
    expect(content.endsWith(EXAM_STOP_SENTENCE)).toBe(true);
    expect(content).toMatch(NO_DASHES);
  });
});

describe('the free rooms of a building', () => {
  const free = (overrides: Partial<FreeRooms> = {}): FreeRooms => ({
    building: 'Electrical & Computer Eng Bldg',
    from: '2026-09-10 18:00:00',
    to: '2026-09-10 19:00:00',
    locations: [{
      locationId: 5,
      building: 'Electrical & Computer Eng Bldg',
      roomNumber: '1002',
      maxCapacity: 40,
      hasAvEquipment: true,
    }],
    ...overrides,
  });

  /** Enough rooms across enough floors that the grouping has something to do. */
  const manyRooms = (): FreeRooms => free({
    locations: [
      room(5, '1002', true), room(6, '1013', false), room(7, '2013', false),
      room(8, '2015', true), room(9, '3017', false), room(10, 'B02', false),
    ],
  });

  function room(locationId: number, roomNumber: string, av: boolean) {
    return {
      locationId,
      building: 'Electrical & Computer Eng Bldg',
      roomNumber,
      maxCapacity: 40,
      hasAvEquipment: av,
    };
  }

  it('names the building, the window and every room that is free', () => {
    const content = renderFreeRooms(free()).content;
    expect(content).toContain('Electrical & Computer Eng Bldg');
    expect(content).toContain('1002');
    expect(content).toContain('6:00 PM');
    expect(content).toMatch(NO_DASHES);
  });

  /**
   * The number in the locations table is not one anybody measured. It reads the
   * same for very nearly every room on campus, so it is shown nowhere.
   */
  it('never says how many people a room holds', () => {
    const content = renderFreeRooms(free()).content;
    expect(content).not.toContain('40');
    expect(content).not.toContain('people');
  });

  /**
   * A big building has dozens of free rooms in an empty hour, and a column of
   * dozens of lines is not an answer anybody reads. The rooms of a floor go on
   * one line, in the order their numbers run.
   */
  it('groups the rooms by the floor they are on', () => {
    const content = renderFreeRooms(manyRooms()).content;
    expect(content).toContain('First floor');
    expect(content).toContain('Second floor');
    expect(content).toContain('Third floor');
    expect(content).toContain('Basement');

    const first = content.split('\n').find(line => line.includes('First floor'));
    expect(first).toContain('1002');
    expect(first).toContain('1013');
    expect(first).not.toContain('2013');
  });

  it('says how many rooms are free', () => {
    expect(renderFreeRooms(manyRooms()).content).toContain('6 rooms');
  });

  /**
   * Which rooms have a projector matters to somebody choosing one, and a note
   * beside every room number would drown the numbers themselves, so the rooms
   * that have it are named once at the end.
   */
  it('names the rooms with audio visual equipment in one sentence at the end', () => {
    const content = renderFreeRooms(manyRooms()).content;
    const sentence = content.split('\n').find(line => line.includes('audio visual'));
    expect(sentence).toBeDefined();
    expect(sentence).toContain('1002');
    expect(sentence).toContain('2015');
    expect(sentence).not.toContain('1013');
  });

  it('leaves that sentence out where no free room has any', () => {
    const content = renderFreeRooms(free({
      locations: [room(6, '1013', false)],
    })).content;
    expect(content).not.toContain('audio visual');
  });

  it('answers a building with nothing free in one sentence', () => {
    const content = renderFreeRooms(free({ locations: [] })).content;
    expect(content.split('\n')).toHaveLength(1);
    expect(content).toContain('Electrical & Computer Eng Bldg');
    expect(content).toMatch(NO_DASHES);
  });

  /**
   * A floor is one line, so the floors of a building read as a building when
   * they are written under each other. The blank line a digest puts between
   * one day and the next would turn six lines into eleven.
   */
  it('writes the floors under each other rather than spacing them apart', () => {
    const lines = renderFreeRooms(manyRooms()).content.split('\n');
    const floors = lines.filter(line => line.includes(' floor') || line.includes('Basement'));
    const first = lines.indexOf(floors[0]!);
    expect(lines.slice(first, first + floors.length)).toEqual(floors);
  });

  /**
   * A building with more free rooms than one message will hold loses floors
   * from the listing, and what it says about that has to be about a building.
   * The digest's own sentence is about the rest of the week.
   */
  it('says what was left out in words about a building, not about a week', () => {
    const many = free({
      locations: Array.from({ length: 400 }, (_, index) => room(
        index + 1,
        `${(index % 9) + 1}${String(index).padStart(3, '0')}`,
        false,
      )),
    });
    const content = renderFreeRooms(many).content;
    expect(content.length).toBeLessThanOrEqual(2000);
    expect(content).not.toContain('rest of the week');
    expect(content).toContain(ROOMS_LEFT_OUT);
  });

  it('carries whatever menus it was given, and none where it was given none', () => {
    const rows = [{
      kind: 'row' as const,
      components: [{
        kind: 'select' as const, selectKind: 'string' as const,
        customId: 'rooms:day:now:-:-:ECEB', options: [{ label: 'Right now', value: 'now' }],
      }],
    }];
    expect(renderFreeRooms(free(), rows).components).toEqual(rows);
    expect(renderFreeRooms(free()).components).toEqual([]);
  });
});

describe('the sections of one course', () => {
  it('names the course and each section with its days, its hours and its room', () => {
    const content = renderCourseSections(course());
    expect(content).toContain('ECE 385');
    expect(content).toContain('Digital Systems Laboratory');
    expect(content).toContain('Monday and Wednesday');
    expect(content).toContain('10:00 AM');
    expect(content).toContain('Electrical & Computer Eng Bldg 1002');
    expect(content).toContain('lecture');
    expect(content).toMatch(NO_DASHES);
  });

  it('answers a course with no sections recorded in one sentence', () => {
    const content = renderCourseSections(course({ sections: [] }));
    expect(content.split('\n')).toHaveLength(1);
    expect(content).toContain('ECE 385');
    expect(content).toMatch(NO_DASHES);
  });
});

describe('one building', () => {
  it('names the code, the full name and the address when there is one', () => {
    const content = renderBuilding({ code: 'ECEB', name: 'Electrical & Computer Eng Bldg', address: '306 N Wright St' });
    expect(content).toContain('ECEB');
    expect(content).toContain('Electrical & Computer Eng Bldg');
    expect(content).toContain('306 N Wright St');
    expect(content).toMatch(NO_DASHES);
  });

  it('says in a sentence that no address is recorded, rather than guessing at one', () => {
    const content = renderBuilding({ code: 'ECEB', name: 'Electrical & Computer Eng Bldg', address: null });
    expect(content).toContain('Electrical & Computer Eng Bldg');
    expect(content).toContain('no address');
    expect(content).toMatch(NO_DASHES);
  });
});

/**
 * A week of exams has to fit in one message for the same reason a week of
 * events does: Discord refuses anything longer outright, so a busy week with
 * nothing done about it is a message nobody receives.
 */
describe('fitting the exams into one message', () => {
  const busyWeek = () => Array.from({ length: 120 }, (_unused, index) => midterm({
    midtermId: index,
    courseCode: `ECE ${300 + index}`,
    title: `Midterm ${index} of a course with a fairly long name`,
    startTime: `2026-09-0${(index % 3) + 7}T18:00:00-05:00`,
    endTime: `2026-09-0${(index % 3) + 7}T19:00:00-05:00`,
  }));

  it('keeps the exams a server posts inside what Discord will carry', () => {
    const reply = renderExamsThisWeek({ weekStart: '2026-09-06', midterms: busyWeek() });
    expect(reply.content.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(reply.content).toContain('The exams this week');
  });

  it('keeps the exams of one course inside what Discord will carry', () => {
    const message = renderMidterms('ECE 385', busyWeek());
    expect(message.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
  });
});
