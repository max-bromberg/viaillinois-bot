import { featureById } from '../features/registry.ts';
import { renderEventCard, renderRsoCard, EVENT_BUTTON, RSO_BUTTON } from '../render/eventCard.ts';
import { renderEventList, PAGE_SIZE } from '../render/eventList.ts';
import { campusDate, windowRange, type ListingWindow } from '../render/campusTime.ts';
import { ViaError, type EventQuery, type ViaEvent } from '../via/client.ts';
import { followRso, toggleReminder } from './feed.ts';
import { answerFor, identifier, requireLink, NOT_AN_RSO_MESSAGE, NO_SUCH_RSO_MESSAGE } from './shared.ts';
import type { CommandContext, CommandHandler, ComponentHandler } from './types.ts';
import type { AutocompleteChoice, Interaction, Reply } from '../discord/adapter.ts';

// The answers more than one command gives are written once in shared.ts and
// reached from here as well, because these are the names they were first
// published under.
export {
  answerFor, LINK_NEEDED_MESSAGE, NOT_AN_RSO_MESSAGE, NO_SUCH_RSO_MESSAGE, UNREACHABLE_MESSAGE,
} from './shared.ts';

/**
 * The three commands a student reads VIA with: what is coming up, one event,
 * and one organization.
 *
 * Two rules run through all of them. The first is that the web platform
 * decides what a person may see: every call carries the acting Discord user
 * identifier and nothing else, and whether an internal event comes back is
 * the web platform's answer from that person's memberships rather than a
 * check made here. The second is that a button which needs a VIA account says
 * so gently and offers the link command, because a button that fails silently
 * teaches people that the bot is broken.
 *
 * Interest is recorded on VIA the moment the button is pressed, because it is
 * what replaced the RSVPs the web platform removed and the count on the card
 * is the number a board reads. The reminder button and the follow button write
 * to the person's own feed, so both of them are answered by the feed module,
 * which is what the settings panel and the digest read.
 */

const listFeature = featureById('events.list');
const detailFeature = featureById('events.detail');
const rsoFeature = featureById('rsos.detail');

/** How many completions to offer, which is what Discord will show. */
const MAX_COMPLETIONS = 25;

/** How many events to look through when completing a title. */
const COMPLETION_POOL = 100;

export const NOT_AN_EVENT_MESSAGE =
  'Please choose an event from the list Discord offers as you type, rather than typing a title of your own.';

export const NO_SUCH_EVENT_MESSAGE =
  'VIA does not have an event by that name any more. It may have been deleted since Discord last completed it.';

export const EVENT_GONE_MESSAGE =
  'VIA does not have that event any more, so there is nothing to answer with. It was probably deleted after this message was posted.';

/** What somebody reads once their interest has been recorded on VIA. */
export function interestedMessage(title: string, interestCount: number): string {
  const others = interestCount === 1
    ? 'You are the first person to say so.'
    : `${interestCount} people are interested so far.`;
  return `You are marked as interested in ${title}. ${others}`;
}

/** What somebody reads once their interest has been taken back. */
export function noLongerInterestedMessage(title: string): string {
  return `You are no longer marked as interested in ${title}.`;
}

const WINDOWS: ListingWindow[] = ['today', 'thisweek', 'nextweek', 'thismonth'];

function windowOf(value: unknown): ListingWindow | null {
  const text = String(value ?? '');
  return (WINDOWS as string[]).includes(text) ? (text as ListingWindow) : null;
}

/**
 * What a listing was asked for, carried on the page buttons so that pressing
 * Next asks for the same listing one page further on. It is written into the
 * identifier rather than held in memory, because a person can press Next on a
 * message the bot posted before it was last restarted.
 */
export interface ListingRequest {
  rsoId: number | null;
  window: ListingWindow | null;
  includeInternal: boolean;
  offset: number;
}

export const EVENTS_PAGE_PREFIX = 'events:page';
export const EVENTS_OPEN_PREFIX = 'events:open';

/**
 * The button that opens one row of a listing.
 *
 * It carries the listing as well as the event, because the card it opens
 * replaces the listing in the same message and the way back has to be on the
 * card. A button posted by an older version of the bot carries the event
 * alone, which still opens the card and simply offers no way back.
 */
export function encodeOpen(eventId: number, request: ListingRequest): string {
  return [
    EVENTS_OPEN_PREFIX,
    String(eventId),
    request.rsoId === null ? 'any' : String(request.rsoId),
    request.window ?? 'any',
    request.includeInternal ? '1' : '0',
    String(request.offset),
  ].join(':');
}

export function decodeOpen(customId: string): { eventId: number; request: ListingRequest | null } | null {
  const parts = customId.split(':');
  // The prefix carries a colon of its own, so the event is the third part.
  if (parts.length < 3 || `${parts[0]}:${parts[1]}` !== EVENTS_OPEN_PREFIX) return null;
  const eventId = identifier(parts[2]);
  if (eventId === null) return null;
  if (parts.length !== 7) return { eventId, request: null };

  const [, , , rso, window, internal, page] = parts;
  const offset = identifier(page);
  if (offset === null) return { eventId, request: null };
  return {
    eventId,
    request: {
      rsoId: rso === 'any' ? null : identifier(rso),
      window: windowOf(window),
      includeInternal: internal === '1',
      offset,
    },
  };
}

export function encodeListing(request: ListingRequest): string {
  return [
    EVENTS_PAGE_PREFIX,
    request.rsoId === null ? 'any' : String(request.rsoId),
    request.window ?? 'any',
    request.includeInternal ? '1' : '0',
    String(request.offset),
  ].join(':');
}

export function decodeListing(customId: string): ListingRequest | null {
  // The prefix carries a colon of its own, so the four fields are the last
  // four parts of six rather than the last four of five.
  const parts = customId.split(':');
  if (parts.length !== 6 || `${parts[0]}:${parts[1]}` !== EVENTS_PAGE_PREFIX) return null;
  const [, , rso, window, internal, page] = parts;
  const offset = identifier(page);
  if (offset === null) return null;
  return {
    rsoId: rso === 'any' ? null : identifier(rso),
    window: windowOf(window),
    includeInternal: internal === '1',
    offset,
  };
}

/** The heading a listing carries, which says what was asked for. */
function headingFor(request: ListingRequest, rsoName: string | null): string {
  const where = rsoName ? `Coming up for ${rsoName}` : 'Coming up across ECE';
  const when: Record<ListingWindow, string> = {
    today: 'today',
    thisweek: 'this week',
    nextweek: 'next week',
    thismonth: 'this month',
  };
  return request.window ? `${where}, ${when[request.window]}.` : `${where}.`;
}

/** Run one listing and render it, whether it came from the command or from a page button. */
async function listing(
  request: ListingRequest,
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  const range = windowRange(request.window, context.now());
  const query: EventQuery = {
    ...(request.rsoId === null ? {} : { rsoIds: [request.rsoId] }),
    ...range,
    includeInternal: request.includeInternal,
    limit: PAGE_SIZE,
    offset: request.offset,
    actingDiscordUserId: interaction.userId,
  };

  let page;
  let rsoName: string | null = null;
  try {
    page = await context.via.listEvents(query);
    if (request.rsoId !== null) {
      const rsos = await context.via.listRsos();
      rsoName = rsos.find(rso => rso.rsoId === request.rsoId)?.name ?? null;
    }
  } catch (err) {
    return answerFor(err);
  }

  const hasPrevious = request.offset > 0;
  const hasNext = request.offset + page.events.length < page.total;

  return renderEventList({
    events: page.events,
    total: page.total,
    offset: request.offset,
    heading: headingFor(request, rsoName),
    previousId: hasPrevious
      ? encodeListing({ ...request, offset: Math.max(0, request.offset - PAGE_SIZE) })
      : null,
    nextId: hasNext ? encodeListing({ ...request, offset: request.offset + PAGE_SIZE }) : null,
    openId: (event: ViaEvent) => encodeOpen(event.eventId, request),
  });
}

/** The organizations whose names match what a person has typed so far. */
async function completeRsos(interaction: Interaction, context: CommandContext): Promise<AutocompleteChoice[]> {
  const typed = (interaction.focusedOption?.value ?? '').trim().toLowerCase();
  const rsos = await context.via.listRsos();
  return rsos
    .filter(rso => !typed || rso.name.toLowerCase().includes(typed))
    .slice(0, MAX_COMPLETIONS)
    .map(rso => ({ name: rso.name, value: String(rso.rsoId) }));
}

export const eventsCommand: CommandHandler = {
  featureId: listFeature.id,
  name: listFeature.command!.name,
  // A reading command answers the channel in a server that invited the bot,
  // because the question it answers is the channel's too. In a server that
  // did not invite it, the dispatcher answers only the person who asked.
  ephemeral: false,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const rsoOption = interaction.options.rso;
    // Discord sends whatever was typed when the person ignored the completions,
    // and an organization identifier when they took one.
    if (rsoOption !== undefined && identifier(rsoOption) === null) {
      return { content: NOT_AN_RSO_MESSAGE };
    }

    return listing({
      rsoId: rsoOption === undefined ? null : identifier(rsoOption),
      window: windowOf(interaction.options.window),
      includeInternal: interaction.options.internal === true,
      offset: 0,
    }, interaction, context);
  },

  async autocomplete(interaction: Interaction, context: CommandContext): Promise<AutocompleteChoice[]> {
    if (interaction.focusedOption?.name !== 'rso') return [];
    return completeRsos(interaction, context);
  },
};

/**
 * The buttons a listing carries: the page control and the button on each row
 * that opens the card. Both edit the listing in place, so a student paging
 * through a week does not leave five messages behind.
 */
export const eventsComponent: ComponentHandler = {
  featureId: listFeature.id,
  prefix: 'events:',
  updateInPlace: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const customId = interaction.customId ?? '';

    if (customId.startsWith(`${EVENTS_OPEN_PREFIX}:`)) {
      const opened = decodeOpen(customId);
      if (!opened) return { content: EVENT_GONE_MESSAGE };
      let event;
      try {
        event = await context.via.getEvent(opened.eventId, interaction.userId);
      } catch (err) {
        return answerFor(err);
      }
      if (!event) return { content: EVENT_GONE_MESSAGE };
      return renderEventCard(event, {
        websiteUrl: context.websiteUrl,
        // The card is answered privately to whoever pressed the row button, so
        // it carries the way into the board actions, exactly as the card an
        // announcement opens does.
        manageable: true,
        backTo: opened.request ? encodeListing(opened.request) : null,
      });
    }

    const request = decodeListing(customId);
    if (!request) return { content: EVENT_GONE_MESSAGE };
    return listing(request, interaction, context);
  },
};

export const eventCommand: CommandHandler = {
  featureId: detailFeature.id,
  name: detailFeature.command!.name,
  // A reading command answers the channel in a server that invited the bot,
  // because the question it answers is the channel's too. In a server that
  // did not invite it, the dispatcher answers only the person who asked.
  ephemeral: false,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const eventId = identifier(interaction.options.event);
    if (eventId === null) return { content: NOT_AN_EVENT_MESSAGE };

    let event;
    try {
      event = await context.via.getEvent(eventId, interaction.userId);
    } catch (err) {
      return answerFor(err);
    }
    if (!event) return { content: NO_SUCH_EVENT_MESSAGE };
    // The card carries the way into the board actions, which opens it again
    // for whoever presses it with the actions the web platform allows them.
    return renderEventCard(event, { websiteUrl: context.websiteUrl, manageable: true });
  },

  /**
   * Events are completed by title and by organization name, because a student
   * looking for a meeting knows one or the other, and the answer names the
   * organization and the day so that two meetings with the same title are told
   * apart.
   *
   * The completions are drawn from the listing that does not ask for internal
   * events, which is the one the client caches. An internal listing is
   * answered differently for every person, so it cannot be cached and would
   * mean a call to the web platform on every keystroke of every autocomplete.
   * An internal event is therefore not completed by title, and a member of the
   * organization reaches it through the events command with the internal
   * option, whose row button opens the same card.
   */
  async autocomplete(interaction: Interaction, context: CommandContext): Promise<AutocompleteChoice[]> {
    if (interaction.focusedOption?.name !== 'event') return [];
    const typed = (interaction.focusedOption.value ?? '').trim().toLowerCase();

    const page = await context.via.listEvents({ limit: COMPLETION_POOL });

    return page.events
      .filter(event => !typed
        || event.title.toLowerCase().includes(typed)
        || (event.rsoName ?? '').toLowerCase().includes(typed))
      .slice(0, MAX_COMPLETIONS)
      .map(event => ({
        name: [event.title, event.rsoName, campusDate(event.startTime)].filter(Boolean).join(', '),
        value: String(event.eventId),
      }));
  },
};

/**
 * The buttons on the event card. Each answers the person who pressed it and
 * nobody else, because a card can sit in a channel a whole server reads and
 * one person's reminder is not the channel's business.
 */
export const eventComponent: ComponentHandler = {
  featureId: detailFeature.id,
  prefix: 'event:',
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const customId = interaction.customId ?? '';
    const eventId = identifier(customId.split(':')[2]);
    if (eventId === null) return { content: EVENT_GONE_MESSAGE };

    if (customId === EVENT_BUTTON.calendar(eventId)) {
      let event;
      let calendar;
      try {
        event = await context.via.getEvent(eventId, interaction.userId);
        if (!event) return { content: EVENT_GONE_MESSAGE };
        calendar = await context.via.getEventCalendar(eventId);
      } catch (err) {
        if (err instanceof ViaError && err.code === 'not_found') return { content: EVENT_GONE_MESSAGE };
        return answerFor(err);
      }
      return {
        content: `Here is ${event.title} as a calendar file. Open it to add the event to your own calendar.`,
        files: [{
          name: `via-event-${eventId}.ics`,
          content: calendar,
          contentType: 'text/calendar',
        }],
      };
    }

    if (customId === EVENT_BUTTON.interested(eventId)) {
      const needsLink = await requireLink(interaction, context);
      if (needsLink) return needsLink;

      /**
       * Pressing the button a second time takes the mark back, exactly as the
       * Remind me button beside it does. Whether there is one to take back is
       * read from the marks the bot wrote down, because the web platform holds
       * interest by NetID and by a salted hash and answers with a count rather
       * than with whether this person is in it.
       */
      const marked = Boolean(await context.interestMarks?.hasMark(eventId, interaction.userId));

      let event;
      let answer;
      try {
        event = await context.via.getEvent(eventId, interaction.userId);
        if (!event) return { content: EVENT_GONE_MESSAGE };
        // The web platform records the interest against the NetID the acting
        // header names, and answers with the count after it, which is what
        // the person who pressed the button wants to know.
        answer = await context.via.setInterest(eventId, {
          interested: !marked,
          actingDiscordUserId: interaction.userId,
        });
      } catch (err) {
        if (err instanceof ViaError && err.code === 'not_found') return { content: EVENT_GONE_MESSAGE };
        return answerFor(err);
      }

      // The mark is written down as well, by Discord account, because the
      // feedback request the morning after has to reach this person and the
      // web platform holds their interest by NetID. It is written only once
      // the web platform has taken the signal, so the two cannot disagree, and
      // a mark that cannot be written costs a feedback request rather than the
      // answer to what the person actually pressed.
      try {
        if (marked) await context.interestMarks?.unmark(eventId, interaction.userId);
        else await context.interestMarks?.mark(eventId, interaction.userId);
      } catch (err) {
        console.error(
          `writing down the interest of ${interaction.userId} in event ${eventId} failed:`,
          (err as Error).message,
        );
      }

      return {
        content: marked
          ? noLongerInterestedMessage(event.title)
          : interestedMessage(event.title, answer.interestCount),
      };
    }

    if (customId === EVENT_BUTTON.remind(eventId)) {
      const needsLink = await requireLink(interaction, context);
      if (needsLink) return needsLink;

      let event;
      try {
        event = await context.via.getEvent(eventId, interaction.userId);
      } catch (err) {
        if (err instanceof ViaError && err.code === 'not_found') return { content: EVENT_GONE_MESSAGE };
        return answerFor(err);
      }
      if (!event) return { content: EVENT_GONE_MESSAGE };
      return toggleReminder(interaction, context, event);
    }

    return { content: EVENT_GONE_MESSAGE };
  },
};

export const rsoCommand: CommandHandler = {
  featureId: rsoFeature.id,
  name: rsoFeature.command!.name,
  // A reading command answers the channel in a server that invited the bot,
  // because the question it answers is the channel's too. In a server that
  // did not invite it, the dispatcher answers only the person who asked.
  ephemeral: false,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const rsoId = identifier(interaction.options.rso);
    if (rsoId === null) return { content: NOT_AN_RSO_MESSAGE };

    let answer;
    try {
      answer = await context.via.getRso(rsoId, interaction.userId);
    } catch (err) {
      return answerFor(err);
    }
    if (!answer) return { content: NO_SUCH_RSO_MESSAGE };
    return renderRsoCard(answer, { websiteUrl: context.websiteUrl });
  },

  async autocomplete(interaction: Interaction, context: CommandContext): Promise<AutocompleteChoice[]> {
    if (interaction.focusedOption?.name !== 'rso') return [];
    return completeRsos(interaction, context);
  },
};

/** The follow button on the organization card. */
export const rsoComponent: ComponentHandler = {
  featureId: rsoFeature.id,
  prefix: 'rso:',
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const customId = interaction.customId ?? '';
    const rsoId = identifier(customId.split(':')[2]);
    if (rsoId === null || customId !== RSO_BUTTON.follow(rsoId)) {
      return { content: NO_SUCH_RSO_MESSAGE };
    }

    const needsLink = await requireLink(interaction, context);
    if (needsLink) return needsLink;

    let rsos;
    try {
      rsos = await context.via.listRsos();
    } catch (err) {
      return answerFor(err);
    }
    const rso = rsos.find(one => one.rsoId === rsoId);
    if (!rso) return { content: NO_SUCH_RSO_MESSAGE };
    return followRso(interaction, context, rso.rsoId, rso.name);
  },
};
