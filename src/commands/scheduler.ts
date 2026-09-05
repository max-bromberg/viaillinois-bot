import { featureById } from '../features/registry.ts';
import { campusDatePlus, campusStamp, campusToday, campusDateTime } from '../render/campusTime.ts';
import {
  describeCandidate, pollAnswerFor, proposalOf, renderRecommendations, describeWeeks,
  POLLED_CANDIDATES,
} from '../render/schedule.ts';
import {
  decodeAsk, decodeProposal, encodeNaming, encodeProposal,
  NAME_PREFIX, POLL_IN_PREFIX, POLL_PREFIX, TAKE_PREFIX,
  type Proposal, type ScheduleAsk,
} from '../scheduler/proposal.ts';
import type { PolledCandidate } from '../scheduler/polls.ts';
import { actOnVia, identifier, NOT_AN_RSO_MESSAGE } from './shared.ts';
import type { CommandContext, CommandHandler, ComponentHandler } from './types.ts';
import type { ScheduleCandidate, ScheduleRequest } from '../via/client.ts';
import type { AutocompleteChoice, Interaction, Reply } from '../discord/adapter.ts';

/**
 * The scheduler: recommend, poll, accept.
 *
 * The bot asks the same scheduler the dashboard asks, through the internal
 * service API, and shows what comes back. It weighs nothing itself, which
 * matters: a board that reads one answer on the website and another in Discord
 * would trust neither.
 *
 * The poll is Discord's own, because member availability is exactly what a
 * server is for and a row of buttons the bot counted itself would be a poll
 * with worse arithmetic. Discord sends no event when a poll ends, so the bot
 * writes down the hour the poll runs to and goes and reads the result then,
 * which is the job in src/jobs/schedulerPolls.ts.
 *
 * Accepting checks the recommendation again before anything is created. Rooms
 * are booked and exams are confirmed while a poll runs, so the evening that
 * won on Monday is not always the evening the scheduler would offer on
 * Wednesday, and a board that is about to fill a term with meetings deserves
 * to see the difference first.
 *
 * That check is why accepting is two steps. Discord takes a form only as the
 * first thing an application says about an interaction, which leaves three
 * seconds rather than fifteen minutes, and asking the scheduler again is a
 * call to the web platform. So the accept button is answered like any other
 * command, with what the check found and a button, and that button opens the
 * form with nothing at all behind it.
 */

const recommendFeature = featureById('scheduler.recommend');

/** How long a poll runs, which is long enough for a member to see it and answer. */
export const POLL_HOURS = 48;

/** What the options default to when a board member leaves them out. */
export const DEFAULT_MINUTES = 60;
export const DEFAULT_EARLIEST_HOUR = 17;
export const DEFAULT_LATEST_HOUR = 22;

export const GUILD_ONLY_MESSAGE =
  'The scheduler opens a poll in a channel, so it has to be run inside a server.';

export const NO_TITLE_MESSAGE =
  'A repeat needs a name, because that is what students read in the feed. Please try again and write one in the box.';

export const NOTHING_TO_ACCEPT_MESSAGE =
  'That recommendation is no longer one this bot can read. Please run the schedule command again and accept from the new answer.';

export const CANNOT_POST_MESSAGE =
  'The bot cannot post in this server right now, so no poll has been opened. Please try again in a few minutes.';

/** The identifiers the scheduler buttons carry. */
export const SCHEDULER_BUTTON = {
  poll: (ask: string) => `${POLL_PREFIX}${ask}`,
  pollIn: (ask: string) => `${POLL_IN_PREFIX}${ask}`,
  takePrefix: TAKE_PREFIX,
  namePrefix: NAME_PREFIX,
};

/** What the command options come to, with the defaults for anything left out. */
export function askOf(interaction: Interaction): ScheduleAsk | null {
  const rsoId = identifier(interaction.options.rso);
  if (rsoId === null) return null;
  const hour = (value: unknown, fallback: number) => {
    const read = identifier(value);
    return read === null || read > 23 ? fallback : read;
  };
  const minutes = identifier(interaction.options.length) ?? DEFAULT_MINUTES;

  return {
    rsoId,
    span: interaction.options.span === 'week' ? 'week' : 'term',
    minutes,
    earliestHour: hour(interaction.options.earliest, DEFAULT_EARLIEST_HOUR),
    latestHour: hour(interaction.options.latest, DEFAULT_LATEST_HOUR),
  };
}

/**
 * How far ahead the first meeting of a repeat is looked for, which is a week.
 * A weekly repeat begins on one of the seven days that come next, whichever
 * weekday it settles on, so a week is the whole of the question.
 */
export const SEARCH_DAYS = 7;

/**
 * The question the scheduler is asked.
 *
 * A search over one week asks about a single evening, so it carries no repeat
 * and the date range is the week it is about.
 *
 * A search over the rest of the term asks about a weekly repeat and leaves the
 * end date out, which is how the web platform's own route says "to the end of
 * instruction", read from the academic calendar it already holds. The
 * dashboard sends that date itself, because it has read the semester; the bot
 * cannot, because the internal service API has no endpoint that answers when
 * the term ends. What the two surfaces send therefore differs in one field and
 * asks the same question: the route fills the end of the repeat in from the
 * calendar either way, and every week of the term is weighed from it. The date
 * range the bot sends is only where the first meeting is looked for, which is
 * the coming week whichever weekday the repeat settles on.
 */
export function requestFor(ask: ScheduleAsk, now: Date): ScheduleRequest {
  const start = campusToday(now);
  return {
    rsoId: ask.rsoId,
    durationMinutes: ask.minutes,
    dateRange: { start, end: campusDatePlus(SEARCH_DAYS, now) },
    timeConstraint: { startHour: ask.earliestHour, endHour: ask.latestHour },
    ...(ask.span === 'term'
      ? { recurrence: { intervalWeeks: 1, daysOfWeek: [] } }
      : {}),
  };
}

/** The name of an organization, for the heading and for the refusals. */
async function rsoNameOf(rsoId: number, context: CommandContext): Promise<string | null> {
  try {
    const rsos = await context.via.listRsos();
    return rsos.find(rso => rso.rsoId === rsoId)?.name ?? null;
  } catch {
    // A heading without the name is a worse answer, not a failed one.
    return null;
  }
}

/** Ask the scheduler, and turn every refusal into the sentence it reads as. */
async function recommend(
  ask: ScheduleAsk,
  interaction: Interaction,
  context: CommandContext,
): Promise<{ candidates: ScheduleCandidate[]; rsoName: string | null } | { refusal: Reply }> {
  const rsoName = await rsoNameOf(ask.rsoId, context);
  const outcome = await actOnVia(
    () => context.via.recommendSchedule(requestFor(ask, context.now()), interaction.userId),
    { rsoName },
  );
  if (!outcome.ok) return { refusal: outcome.reply };

  // The curated picks are one evening per hour of the day, which is what a
  // board choosing a weekly meeting is choosing between. The wider list is
  // behind them for the case where the curated ones are all taken.
  const candidates = outcome.value.curatedPicks.length > 0
    ? outcome.value.curatedPicks
    : outcome.value.allOptions;
  return { candidates, rsoName };
}

export const scheduleCommand: CommandHandler = {
  featureId: recommendFeature.id,
  name: `via ${recommendFeature.command!.name}`,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    if (!interaction.guildId) return { content: GUILD_ONLY_MESSAGE };

    const ask = askOf(interaction);
    if (!ask) return { content: NOT_AN_RSO_MESSAGE };

    const answer = await recommend(ask, interaction, context);
    if ('refusal' in answer) return answer.refusal;

    return renderRecommendations({
      rsoName: answer.rsoName ?? 'your organization',
      ask,
      candidates: answer.candidates,
    });
  },

  async autocomplete(interaction: Interaction, context: CommandContext): Promise<AutocompleteChoice[]> {
    if (interaction.focusedOption?.name !== 'rso') return [];
    const typed = (interaction.focusedOption.value ?? '').trim().toLowerCase();
    const rsos = await context.via.listRsos();
    return rsos
      .filter(rso => !typed || rso.name.toLowerCase().includes(typed))
      .slice(0, 25)
      .map(rso => ({ name: rso.name, value: String(rso.rsoId) }));
  },
};

/** The menu that asks which channel a poll should be posted in. */
function channelPanel(ask: string): Reply {
  return {
    content: 'Which channel should the poll go in? Choose the channel your members read, because the poll is what they answer.',
    components: [{
      kind: 'row',
      components: [{
        kind: 'select',
        selectKind: 'channel',
        customId: SCHEDULER_BUTTON.pollIn(ask),
        placeholder: 'Choose the channel for the poll',
      }],
    }],
  };
}

/** What a poll holds about each evening it offered. */
function polledCandidate(candidate: ScheduleCandidate, ask: ScheduleAsk): PolledCandidate {
  const proposal = proposalOf(candidate, ask);
  return {
    startTime: proposal.startTime,
    locationId: proposal.locationId,
    building: candidate.building,
    roomNumber: candidate.roomNumber,
    score: candidate.score,
    intervalWeeks: proposal.intervalWeeks,
    until: proposal.until,
    answer: pollAnswerFor(candidate),
  };
}

/** Open the poll in the channel that was chosen, and write it down. */
async function openPoll(
  askText: string,
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  const ask = decodeAsk(askText);
  if (!ask) return { content: NOTHING_TO_ACCEPT_MESSAGE };
  if (!interaction.guildId) return { content: GUILD_ONLY_MESSAGE };

  const channelId = interaction.values[0];
  if (!channelId) return { content: CANNOT_POST_MESSAGE };

  const answer = await recommend(ask, interaction, context);
  if ('refusal' in answer) return answer.refusal;

  const offered = answer.candidates.slice(0, POLLED_CANDIDATES);
  if (offered.length === 0) {
    return { content: 'VIA has nothing to put in a poll for those hours, so no poll has been opened.' };
  }
  if (!context.postPoll || !context.polls) return { content: CANNOT_POST_MESSAGE };

  const messageId = await context.postPoll(channelId, {
    content: `${answer.rsoName ?? 'Your organization'} is choosing when to meet. The poll closes in ${POLL_HOURS} hours.`,
    question: 'Which of these works for you?',
    answers: offered.map(pollAnswerFor),
    durationHours: POLL_HOURS,
    allowMultiselect: true,
  });

  const closesAt = campusStamp(new Date(context.now().getTime() + POLL_HOURS * 3_600_000));
  await context.polls.open({
    guildId: interaction.guildId,
    channelId,
    messageId,
    rsoId: ask.rsoId,
    openedBy: interaction.userId,
    ask,
    candidates: offered.map(candidate => polledCandidate(candidate, ask)),
    closesAt,
  });

  return {
    content: [
      `The poll is open in <#${channelId}>, over ${offered.length} of the evenings VIA recommended.`,
      '',
      `It closes in ${POLL_HOURS} hours, and the bot will post the result there with a button that creates the repeat.`,
    ].join('\n'),
  };
}

/** Whether the evening the button carries is still the evening the scheduler offers. */
export function matching(
  proposal: Proposal,
  candidates: readonly ScheduleCandidate[],
): ScheduleCandidate | null {
  return candidates.find(candidate => {
    const now = proposalOf(candidate, proposal.ask);
    return now.startTime === proposal.startTime && now.locationId === proposal.locationId;
  }) ?? null;
}

/** The form that asks what the repeat is called, which is the last thing missing. */
function titleModal(customId: string, when: string): Reply {
  return {
    content: '',
    modal: {
      customId,
      title: 'Name this repeat',
      fields: [
        {
          customId: 'title',
          label: 'What students see in the feed',
          placeholder: when.slice(0, 100),
          required: true,
          maxLength: 100,
        },
        {
          customId: 'description',
          label: 'What it is about, which can be left empty',
          style: 'paragraph',
          required: false,
          maxLength: 1000,
        },
      ],
    },
  };
}

/** The button that opens the form asking what the repeat is called. */
function nameButton(proposal: Proposal): Reply['components'] {
  return [{
    kind: 'row',
    components: [{
      kind: 'button',
      style: 'primary',
      label: 'Name this repeat',
      customId: encodeNaming(proposal),
    }],
  }];
}

/**
 * Check the recommendation again and, when it still stands, offer the button
 * that asks what the repeat is called. When it does not, say what has changed
 * and offer the evening as it now stands, because a board about to fill a term
 * with meetings should read that before it happens rather than afterwards.
 */
async function take(
  proposal: Proposal,
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  const answer = await recommend(proposal.ask, interaction, context);
  if ('refusal' in answer) return answer.refusal;

  const still = matching(proposal, answer.candidates);
  // The same evening, weighed the same way, is the recommendation that was
  // shown, so there is nothing to read before going ahead. The score is
  // compared rounded, because that is how the button carries it.
  if (still && Math.round(still.score) === proposal.score) {
    const weeks = describeWeeks(still);
    return {
      content: [
        `VIA still recommends ${describeCandidate(still)}, scoring ${still.score}.`,
        ...(weeks ? [weeks] : []),
        '',
        'Name the repeat to create it. Nothing is created until you have.',
      ].join('\n'),
      components: nameButton(proposal),
    };
  }

  const best = still ?? answer.candidates[0];
  if (!best) {
    return {
      content: [
        'That evening is no longer one VIA recommends, and it has nothing else to offer for those hours either. Nothing has been created.',
        '',
        'Run the schedule command again with a wider window of the day, or a shorter meeting.',
      ].join('\n'),
    };
  }

  const weeks = describeWeeks(best);
  return {
    content: [
      'What VIA recommends has changed since that poll was opened, so nothing has been created yet.',
      '',
      `VIA now recommends ${describeCandidate(best)}, scoring ${best.score}.`,
      ...(weeks ? [weeks] : []),
      ...best.reasons.map(reason => reason),
      '',
      'Accept that one to go ahead with it, or run the schedule command again to see the whole answer.',
    ].join('\n'),
    components: [{
      kind: 'row',
      components: [{
        kind: 'button',
        style: 'primary',
        label: 'Accept it as it now stands',
        customId: encodeProposal(proposalOf(best, proposal.ask)),
      }],
    }],
  };
}

/** The weekday a date falls on, in the codes the series planner reads. */
const WEEKDAY_CODES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekdayCodeOf(date: string): string {
  return WEEKDAY_CODES[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? 'Mon';
}

/** The end of the meeting a proposal begins, as campus wall clock. */
function endOf(startTime: string, minutes: number): string {
  const at = new Date(`${startTime}:00Z`);
  const ended = new Date(at.getTime() + minutes * 60_000);
  return `${ended.toISOString().slice(0, 10)} ${ended.toISOString().slice(11, 19)}`;
}

/** Create the repeat, once the form has come back with a name for it. */
async function create(
  proposal: Proposal,
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  const title = (interaction.fields.title ?? '').trim();
  if (!title) return { content: NO_TITLE_MESSAGE };

  const description = (interaction.fields.description ?? '').trim();
  const date = proposal.startTime.slice(0, 10);
  const startTime = `${date} ${proposal.startTime.slice(11)}:00`;
  const rsoName = await rsoNameOf(proposal.ask.rsoId, context);

  const outcome = await actOnVia(() => context.via.createEventSeries({
    rsoId: proposal.ask.rsoId,
    title,
    ...(description ? { description } : {}),
    startTime,
    endTime: endOf(proposal.startTime, proposal.ask.minutes),
    ...(proposal.locationId === null ? {} : { locationId: proposal.locationId }),
    recurrence: {
      intervalWeeks: Math.max(1, proposal.intervalWeeks),
      daysOfWeek: [weekdayCodeOf(date)],
      ...(proposal.until ? { endsOn: proposal.until } : {}),
    },
  }, interaction.userId), { rsoName });
  if (!outcome.ok) return outcome.reply;

  const created = outcome.value;
  const lines = [
    `**${title}** is on VIA, as ${created.created} ${created.created === 1 ? 'meeting' : 'meetings'} beginning on ${campusDateTime(startTime)}.`,
  ];
  if (created.skipped.length > 0) {
    lines.push('', `VIA left out ${created.skipped.length} of the dates, because the room is taken then: ${created.skipped.join(', ')}.`);
  }
  lines.push('', 'Every server that follows this organization will announce it, and you can change any of it on viaillinois.com.');
  return { content: lines.join('\n') };
}

/**
 * The accept button, which checks the recommendation again.
 *
 * It is answered like any other command, acknowledged first and answered
 * after, because the check is a call to the web platform and Discord's three
 * second window for a form is not where a call to the web platform belongs.
 */
export const schedulerAcceptComponent: ComponentHandler = {
  featureId: recommendFeature.id,
  prefix: TAKE_PREFIX,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const proposal = decodeProposal(interaction.customId ?? '');
    if (!proposal) return { content: NOTHING_TO_ACCEPT_MESSAGE };
    return take(proposal, interaction, context);
  },
};

/**
 * The button that asks what the repeat is called, and the form that comes
 * back from it.
 *
 * The button opens the form with nothing behind it, which is what makes it
 * safe inside the three seconds Discord allows for one. The form that comes
 * back is a new interaction, so creating the repeat is acknowledged and
 * answered like anything else.
 */
export const schedulerNameComponent: ComponentHandler = {
  featureId: recommendFeature.id,
  prefix: NAME_PREFIX,
  ephemeral: true,
  opensModal: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const proposal = decodeProposal(interaction.customId ?? '');
    if (!proposal) return { content: NOTHING_TO_ACCEPT_MESSAGE };
    if (interaction.kind === 'modal') return create(proposal, interaction, context);

    return titleModal(
      encodeNaming(proposal),
      `${campusDateTime(`${proposal.startTime.replace('T', ' ')}:00`)}`,
    );
  },
};

/** The poll button and the channel menu, both of which answer with a message. */
export const schedulerComponent: ComponentHandler = {
  featureId: recommendFeature.id,
  prefix: 'sched:',
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const customId = interaction.customId ?? '';

    if (customId.startsWith(POLL_IN_PREFIX)) {
      return openPoll(customId.slice(POLL_IN_PREFIX.length), interaction, context);
    }

    if (customId.startsWith(POLL_PREFIX)) {
      return channelPanel(customId.slice(POLL_PREFIX.length));
    }

    return { content: NOTHING_TO_ACCEPT_MESSAGE };
  },
};
