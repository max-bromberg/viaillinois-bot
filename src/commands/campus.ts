import { HOUR_CHOICES, featureById } from '../features/registry.ts';
import { renderBuilding, renderCourseSections, renderFreeRooms } from '../render/campus.ts';
import {
  campusDatePlus, campusDayLong, campusDayPlus, campusStamp, campusToday,
} from '../render/campusTime.ts';
import { ViaError } from '../via/client.ts';
import { chosenCourse, completeCourses } from './midterms.ts';
import { answerFor } from './shared.ts';
import type { CommandContext, CommandHandler, ComponentHandler } from './types.ts';
import type { AutocompleteChoice, Interaction, Reply, ReplyRow } from '../discord/adapter.ts';

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

/**
 * How long a window means when nobody said, which is the next hour. Somebody
 * standing in a building looking for a room wants the hour in front of them.
 */
const DEFAULT_MINUTES = 60;

/** The day that means this moment rather than a date on the calendar. */
export const RIGHT_NOW = 'now';

/** The value the hour menu carries for a window that covers a whole day. */
export const WHOLE_DAY = 'all';

/** The value the length menu carries for a window that runs to midnight. */
export const REST_OF_DAY = '-';

/** How many days ahead the day option completes to, as a person types it. */
const DAYS_TYPED = 13;

/** How many days ahead the day menu offers, which is a week to look across. */
const DAYS_IN_MENU = 6;

/** How long a window can be asked to run for, from the hour it starts at. */
export const LENGTH_CHOICES: readonly { name: string; value: string }[] = [
  { name: 'For 30 minutes', value: '30' },
  { name: 'For an hour', value: '60' },
  { name: 'For two hours', value: '120' },
  { name: 'For three hours', value: '180' },
  { name: 'Until the end of the day', value: REST_OF_DAY },
];

export const NOT_A_BUILDING_MESSAGE =
  'Please name a building, either by choosing one from the list Discord offers as you type or by typing its code, such as ECEB.';

export const ROOMS_GONE_MESSAGE =
  'That room search was posted by a version of the bot that is no longer running. Please run the rooms command again.';

/**
 * What somebody reads when VIA has no record of the building they asked about.
 *
 * The codes the option completes from are the bot's own list, so the bot can
 * complete a code the web platform turns out to know nothing about. Telling
 * the person to choose from the list they just chose from would blame them for
 * something the bot did, so the answer names what was asked for and says where
 * the gap is.
 */
export function noSuchBuildingMessage(typed: string): string {
  return `VIA has no record of the building ${typed}. It may not be in the listing the bot reads.`;
}

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

/**
 * A search for a free room: where, which day, from which hour, and for how
 * long.
 *
 * This is what the command builds out of its options and what every menu on an
 * answer carries, so that pressing one of them moves one part of the window
 * and leaves the rest of it alone. A day of right now is a window that starts
 * at this moment, which is the commonest question by a distance: somebody is
 * standing in a building looking for somewhere to meet.
 */
export interface RoomSearch {
  building: string;
  /** The campus day as YYYY-MM-DD, or right now. */
  day: string;
  /** The hour the window starts at, or null for the start of the day. */
  from: number | null;
  /** How long the window runs in minutes, or null for the rest of the day. */
  minutes: number | null;
}

/**
 * A search with the combinations that cannot mean anything settled.
 *
 * A window that starts at this moment has no hour of its own, and a window
 * over a whole day has no length. Without this, choosing a day from the menu
 * while a thirty minute window was up would ask about the first half hour
 * after midnight.
 */
function settled(search: RoomSearch): RoomSearch {
  if (search.day === RIGHT_NOW) return { ...search, from: null };
  if (search.from === null) return { ...search, minutes: null };
  return search;
}

/** An hour of a day as a datetime column writes it. */
function atHour(day: string, hour: number, minute: number = 0): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${day} ${pad(hour)}:${pad(minute)}:00`;
}

/** The last reading of a campus day, which is where a window to its end stops. */
const endOfDay = (day: string) => `${day} 23:59:59`;

/**
 * The window a search covers, in the wall clock readings the reading router
 * parses.
 *
 * A day the router cannot read is passed on as it was typed. The router
 * answers with a sentence saying how a date is written, which is a better
 * answer than one the bot could compose without knowing what the router
 * accepts.
 */
export function roomWindow(search: RoomSearch, now: Date): { from: string; to: string } {
  if (search.day === RIGHT_NOW) {
    const from = campusStamp(now);
    if (search.minutes === null) return { from, to: endOfDay(campusToday(now)) };
    return { from, to: campusStamp(new Date(now.getTime() + search.minutes * 60_000)) };
  }

  const hour = search.from ?? 0;
  const from = atHour(search.day, hour);
  // The whole of a day is a question about that day, so it ends when the day
  // does. A length is a question about that much time, so it runs on.
  if (search.minutes === null) return { from, to: endOfDay(search.day) };

  /*
   * A window that runs past midnight finishes on the following day rather than
   * at the last reading of this one.
   *
   * It used to stop there, so asking for three hours from eleven at night was
   * answered about fifty nine minutes, with nothing saying why, while the same
   * three hours asked for as right now ran on properly. The web platform reads
   * a window of up to seven days, so there was never anything to clamp against
   * and the two ways of asking now agree.
   */
  const ends = hour * 60 + search.minutes;
  const day = campusDayPlus(search.day, Math.floor(ends / (24 * 60)));
  const within = ends % (24 * 60);
  return { from, to: atHour(day, Math.floor(within / 60), within % 60) };
}

/**
 * The search a command was run with.
 *
 * A command with nothing but a building means right now. A day with no hours
 * means the whole of that day, and an hour with no day means an hour of today,
 * because both are what the words say. An hour named with no hour to finish at
 * runs to the end of the day, which is what it meant before there was a menu
 * to shorten it with.
 */
export function searchFrom(
  options: { building?: unknown; date?: unknown; from?: unknown; to?: unknown },
  now: Date,
): RoomSearch {
  const building = String(options.building ?? '').trim();
  const date = String(options.date ?? '').trim();
  const from = String(options.from ?? '').trim();
  const to = String(options.to ?? '').trim();

  if ((!date || date === RIGHT_NOW) && !from && !to) {
    return { building, day: RIGHT_NOW, from: null, minutes: DEFAULT_MINUTES };
  }

  const day = date && date !== RIGHT_NOW ? date : campusToday(now);
  const startsAt = from ? Number(from) : null;
  const finishesAt = to ? Number(to) : null;
  const minutes = finishesAt === null ? null : (finishesAt - (startsAt ?? 0)) * 60;
  return settled({ building, day, from: startsAt, minutes });
}

/**
 * The days the day option and the day menu offer: this moment, today, tomorrow
 * and the days after, each written the way somebody says it out loud.
 */
export function roomDays(now: Date, ahead: number): { name: string; value: string }[] {
  const days = [{ name: 'Right now, for the next hour', value: RIGHT_NOW }];
  for (let offset = 0; offset <= ahead; offset += 1) {
    const day = campusDatePlus(offset, now);
    const named = campusDayLong(day);
    const name = offset === 0 ? `Today (${named})`
      : offset === 1 ? `Tomorrow (${named})`
        : named;
    days.push({ name, value: day });
  }
  return days;
}

/** Every identifier the menus on a room answer carry. */
export const ROOMS_PREFIX = 'rooms:';

/**
 * A search written into a menu identifier, which Discord holds to a hundred
 * characters. The building goes last and keeps whatever it holds, because a
 * building name is the one part that could carry a colon of its own.
 */
export function encodeSearch(field: string, search: RoomSearch): string {
  return [
    ROOMS_PREFIX + field,
    search.day,
    search.from === null ? REST_OF_DAY : String(search.from),
    search.minutes === null ? REST_OF_DAY : String(search.minutes),
    search.building.slice(0, 60),
  ].join(':');
}

/**
 * The parts of a window a menu can move, which is what a menu identifier is
 * allowed to name. An identifier naming anything else is one this build did
 * not write, so it is refused rather than half read.
 */
const MENU_FIELDS = new Set(['day', 'hour', 'length']);

export function decodeSearch(customId: string): { field: string; search: RoomSearch } | null {
  const parts = customId.split(':');
  // The prefix carries a colon of its own, so the four fields of the search
  // are the four after it and the building is everything left.
  if (parts.length < 6 || `${parts[0]}:` !== ROOMS_PREFIX) return null;
  const [, field, day, from, minutes] = parts;
  const building = parts.slice(5).join(':');
  if (!field || !day || !building || !MENU_FIELDS.has(field)) return null;

  /*
   * A part left empty is not a zero. Number('') reads as the top of the
   * morning, so an identifier missing its hour would quietly answer about
   * midnight rather than about whatever was on the screen. Only the rest of
   * the day is written as something other than a number.
   */
  const number = (value: string | undefined) => {
    if (value === REST_OF_DAY) return null;
    if (!value) return NaN;
    return Number(value);
  };
  const startsAt = number(from);
  const runsFor = number(minutes);
  if (Number.isNaN(startsAt) || Number.isNaN(runsFor)) return null;
  return { field, search: { building, day, from: startsAt, minutes: runsFor } };
}

/** The day a search is reading, which for a window at this moment is today. */
function dayOf(search: RoomSearch, now: Date): string {
  return search.day === RIGHT_NOW ? campusToday(now) : search.day;
}

/**
 * The search a menu leaves behind, which is the one that was showing with the
 * one part the menu names replaced.
 *
 * Choosing an hour on a window that started at this moment moves it onto
 * today, because an hour is what was asked for and this moment is no longer
 * it, and the length it was running for is carried across, so that picking two
 * in the afternoon does not quietly ask about the rest of the day.
 */
export function withChoice(
  search: RoomSearch,
  field: string,
  chosen: string,
  now: Date,
): RoomSearch {
  if (field === 'day') return settled({ ...search, day: chosen });

  if (field === 'hour') {
    if (chosen === WHOLE_DAY) {
      return settled({ ...search, day: dayOf(search, now), from: null, minutes: null });
    }
    return settled({
      ...search,
      day: dayOf(search, now),
      from: Number(chosen),
      minutes: search.minutes ?? DEFAULT_MINUTES,
    });
  }

  if (field === 'length') {
    return settled({
      ...search,
      minutes: chosen === REST_OF_DAY ? null : Number(chosen),
    });
  }
  return search;
}

/**
 * The three menus under an answer: the day, the hour it starts at, and how
 * long it runs.
 *
 * Discord has no date box to offer, so this is as close to one as a slash
 * command gets. The window somebody is reading is on the screen, and every
 * part of it can be moved without running the command again. Each menu carries
 * the whole search in its identifier, so pressing one moves one part and
 * leaves the rest of it alone.
 */
export function roomMenus(search: RoomSearch, now: Date): ReplyRow[] {
  const menu = (field: string, placeholder: string, options: {
    label: string; value: string; selected: boolean;
  }[]): ReplyRow => ({
    kind: 'row',
    components: [{
      kind: 'select',
      selectKind: 'string',
      customId: encodeSearch(field, search),
      placeholder,
      options,
    }],
  });

  return [
    menu('day', 'Look on another day', roomDays(now, DAYS_IN_MENU).map(day => ({
      label: day.name,
      value: day.value,
      selected: day.value === search.day,
    }))),
    menu('hour', 'Start at another hour', [
      {
        label: 'The whole day',
        value: WHOLE_DAY,
        selected: search.day !== RIGHT_NOW && search.from === null,
      },
      ...HOUR_CHOICES.map(hour => ({
        label: `Starting at ${hour.name}`,
        value: hour.value,
        selected: search.day !== RIGHT_NOW && search.from === Number(hour.value),
      })),
    ]),
    menu('length', 'Need it for longer or for less', LENGTH_CHOICES.map(length => ({
      label: length.name,
      value: length.value,
      selected: length.value === REST_OF_DAY
        ? search.minutes === null
        : search.minutes === Number(length.value),
    }))),
  ];
}

/**
 * Ask the web platform and write the answer, with the menus under it either
 * way. A refusal keeps them too, because somebody whose window was refused is
 * exactly the person who needs to move it.
 */
async function answerRooms(search: RoomSearch, context: CommandContext): Promise<Reply> {
  const now = context.now();
  const menus = roomMenus(search, now);
  try {
    const free = await context.via.freeRooms({
      building: search.building,
      ...roomWindow(search, now),
    });
    return renderFreeRooms(free, menus);
  } catch (err) {
    return { ...campusAnswerFor(err), components: menus };
  }
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

/**
 * The days the day option completes to.
 *
 * Discord has no date box in a slash command, so the nearest thing to one is a
 * list of days a person picks from without having to know that a date is
 * written YYYY-MM-DD. What was typed narrows the list by the name as well as
 * by the date, so that somebody typing "tom" is offered tomorrow. A date
 * further out than the list goes is still accepted, because the option takes
 * whatever is typed and the reading router reads it.
 */
async function completeRoomDays(
  interaction: Interaction,
  context: CommandContext,
): Promise<AutocompleteChoice[]> {
  const typed = (interaction.focusedOption?.value ?? '').trim().toLowerCase();
  return roomDays(context.now(), DAYS_TYPED)
    .filter(day => !typed
      || day.name.toLowerCase().includes(typed)
      || day.value.startsWith(typed))
    .slice(0, MAX_COMPLETIONS);
}

export const roomsCommand: CommandHandler = {
  featureId: roomsFeature.id,
  name: roomsFeature.command!.name,
  // A campus lookup answers the channel in a server that invited the bot,
  // because the answer does not depend on who is asking.
  ephemeral: false,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const search = searchFrom(interaction.options, context.now());
    if (!search.building) return { content: NOT_A_BUILDING_MESSAGE };
    return answerRooms(search, context);
  },

  async autocomplete(interaction: Interaction, context: CommandContext) {
    if (interaction.focusedOption?.name === 'date') {
      return completeRoomDays(interaction, context);
    }
    return completeBuildings(interaction, context);
  },
};

/**
 * The three menus under a room answer.
 *
 * They rewrite the message they sit on rather than posting a second one,
 * because the window a channel is reading is the answer: a column of six
 * answers, each of them one hour apart, is not a thing anybody wants under a
 * question about a room.
 */
export const roomsComponent: ComponentHandler = {
  featureId: roomsFeature.id,
  prefix: ROOMS_PREFIX,
  updateInPlace: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const decoded = decodeSearch(interaction.customId ?? '');
    if (!decoded) return { content: ROOMS_GONE_MESSAGE };

    const chosen = interaction.values[0];
    if (chosen === undefined) return answerRooms(decoded.search, context);
    return answerRooms(
      withChoice(decoded.search, decoded.field, chosen, context.now()),
      context,
    );
  },
};

export const courseCommand: CommandHandler = {
  featureId: courseFeature.id,
  name: courseFeature.command!.name,
  // A campus lookup answers the channel in a server that invited the bot,
  // because the answer does not depend on who is asking.
  ephemeral: false,

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
  // A campus lookup answers the channel in a server that invited the bot,
  // because the answer does not depend on who is asking.
  ephemeral: false,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const typed = String(interaction.options.building ?? '').trim();
    if (!typed) return { content: NOT_A_BUILDING_MESSAGE };

    try {
      const building = await context.via.getBuilding(typed);
      if (!building) return { content: noSuchBuildingMessage(typed) };
      return { content: renderBuilding(building) };
    } catch (err) {
      return campusAnswerFor(err);
    }
  },

  autocomplete: completeBuildings,
};
