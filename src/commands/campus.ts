import { featureById } from '../features/registry.ts';
import { renderBuilding, renderCourseSections, renderFreeRooms } from '../render/campus.ts';
import { campusStamp, campusToday } from '../render/campusTime.ts';
import { ViaError } from '../via/client.ts';
import { chosenCourse, completeCourses } from './midterms.ts';
import { answerFor } from './shared.ts';
import type { CommandContext, CommandHandler } from './types.ts';
import type { AutocompleteChoice, Interaction, Reply } from '../discord/adapter.ts';

/**
 * The three campus lookups: a free room, a course and a building code.
 *
 * None of them needs a VIA account, because none of the answers depends on who
 * is asking. All three are answered by the web platform: the free rooms come
 * from the same conflict detection the dashboard uses, the sections come from
 * the courses poller, and the building codes come from the web platform's own
 * table. Nothing here works any of that out for itself.
 *
 * What this module does is turn a window a person can type into the wall clock
 * readings the reading router parses, and turn the router's refusals into the
 * sentence the person reads. Those refusals are written for a person already,
 * so they are shown as they arrived rather than replaced with a sentence of
 * the bot's own that would say less.
 */

const roomsFeature = featureById('campus.rooms');
const courseFeature = featureById('campus.course');
const buildingFeature = featureById('campus.building');

/** How many completions to offer, which is what Discord will show. */
const MAX_COMPLETIONS = 25;

/** How long a window with no hours in it covers, which is the next hour. */
const NEXT_HOUR_MS = 60 * 60 * 1000;

export const NOT_A_BUILDING_MESSAGE =
  'Please name a building, either by choosing one from the list Discord offers as you type or by typing its code, such as ECEB.';

export const NO_SUCH_BUILDING_MESSAGE =
  'VIA does not know that building code, so there is nothing to show. Please choose a building from the list Discord offers as you type.';

/**
 * The building codes the bot completes from.
 *
 * The web platform's building code table is the authority on what a code
 * stands for, and the bot asks it rather than holding a second copy of the
 * names. These are the codes themselves, which is what somebody types, and
 * they are offered before anything has been typed so that the option is not an
 * empty box. Everything after that comes from the rooms VIA knows, and the
 * name a code stands for comes back with the answer.
 */
export const KNOWN_BUILDING_CODES: readonly string[] = [
  'ECEB', 'CIF', 'CSL', 'DCL', 'SC', 'MEB', 'TB', 'AH', 'TH', 'EH', 'NHB', 'LH', 'GH',
  'MSEB', 'BUR', 'IH', 'FLB', 'DKH', 'LIS', 'CB', 'RAL', 'MRL', 'NCEL', 'MNTL', 'NCSA',
  'BH', 'HH', 'KH', 'SB',
];

/** Turn whatever went wrong into the sentence the person reads. */
export function campusAnswerFor(err: unknown): Reply {
  // A refusal of a window or a date is the web platform explaining what it
  // could not read, in words already written for a person.
  if (err instanceof ViaError && err.code === 'invalid') return { content: err.message };
  return answerFor(err);
}

/** An hour of the day as a datetime column writes it, from the option's value. */
function atHour(day: string, hour: string): string {
  return `${day} ${hour.padStart(2, '0')}:00:00`;
}

/**
 * The window a person asked about, in the wall clock readings the reading
 * router parses.
 *
 * A command run with nothing but a building means now, which is the commonest
 * question by a distance: somebody is standing in a building looking for a
 * room. A day with no hours means the whole of that day, and an hour with no
 * day means an hour of today, because both are what the words say.
 *
 * A date the router cannot read is passed on as it was typed. The router
 * answers with a sentence saying how a date is written, which is a better
 * answer than one the bot could compose without knowing what the router
 * accepts.
 */
export function roomWindow(
  options: { date?: unknown; from?: unknown; to?: unknown },
  now: Date,
): { from: string; to: string } {
  const date = String(options.date ?? '').trim();
  const from = String(options.from ?? '').trim();
  const to = String(options.to ?? '').trim();

  if (!date && !from && !to) {
    return { from: campusStamp(now), to: campusStamp(new Date(now.getTime() + NEXT_HOUR_MS)) };
  }

  const day = date || campusToday(now);
  return {
    from: from ? atHour(day, from) : `${day} 00:00:00`,
    to: to ? atHour(day, to) : `${day} 23:59:59`,
  };
}

/**
 * The buildings the option completes to: the rooms VIA knows whose building
 * matches what has been typed, and the codes themselves, so that somebody who
 * has typed nothing still has a list to choose from.
 */
async function completeBuildings(
  interaction: Interaction,
  context: CommandContext,
): Promise<AutocompleteChoice[]> {
  if (interaction.focusedOption?.name !== 'building') return [];
  const typed = (interaction.focusedOption.value ?? '').trim();

  const codes = KNOWN_BUILDING_CODES
    .filter(code => !typed || code.toLowerCase().startsWith(typed.toLowerCase()))
    .map(code => ({ name: code, value: code }));

  const buildings = typed
    ? [...new Set((await context.via.searchLocations(typed)).map(room => room.building))]
      .map(building => ({ name: building, value: building }))
    : [];

  return [...buildings, ...codes].slice(0, MAX_COMPLETIONS);
}

export const roomsCommand: CommandHandler = {
  featureId: roomsFeature.id,
  name: roomsFeature.command!.name,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const building = String(interaction.options.building ?? '').trim();
    if (!building) return { content: NOT_A_BUILDING_MESSAGE };

    const window = roomWindow(interaction.options, context.now());
    try {
      const free = await context.via.freeRooms({ building, ...window });
      return { content: renderFreeRooms(free) };
    } catch (err) {
      return campusAnswerFor(err);
    }
  },

  autocomplete: completeBuildings,
};

export const courseCommand: CommandHandler = {
  featureId: courseFeature.id,
  name: courseFeature.command!.name,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    try {
      const chosen = await chosenCourse(interaction.options.course, context, { sections: true });
      if ('refusal' in chosen) return { content: chosen.refusal };
      return { content: renderCourseSections(chosen.course) };
    } catch (err) {
      return campusAnswerFor(err);
    }
  },

  autocomplete: completeCourses,
};

export const buildingCommand: CommandHandler = {
  featureId: buildingFeature.id,
  name: buildingFeature.command!.name,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const typed = String(interaction.options.building ?? '').trim();
    if (!typed) return { content: NOT_A_BUILDING_MESSAGE };

    try {
      const building = await context.via.getBuilding(typed);
      if (!building) return { content: NO_SUCH_BUILDING_MESSAGE };
      return { content: renderBuilding(building) };
    } catch (err) {
      return campusAnswerFor(err);
    }
  },

  autocomplete: completeBuildings,
};
