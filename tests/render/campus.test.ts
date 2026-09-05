import { describe, it, expect } from 'vitest';
import {
  EXAM_STOP_SENTENCE, NO_EXAMS_THIS_WEEK,
  midtermLine, noExamsFor, renderBuilding, renderCourseSections, renderExamReminder,
  renderExamsThisWeek, renderFreeRooms, renderMidtermNotice, renderMidterms,
} from '../../src/render/campus.ts';
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

  it('names the building, the window and each room with what is in it', () => {
    const content = renderFreeRooms(free());
    expect(content).toContain('Electrical & Computer Eng Bldg');
    expect(content).toContain('1002');
    expect(content).toContain('40');
    expect(content).toContain('6:00 PM');
    expect(content).toMatch(NO_DASHES);
  });

  it('answers a building with nothing free in one sentence', () => {
    const content = renderFreeRooms(free({ locations: [] }));
    expect(content.split('\n')).toHaveLength(1);
    expect(content).toContain('Electrical & Computer Eng Bldg');
    expect(content).toMatch(NO_DASHES);
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
