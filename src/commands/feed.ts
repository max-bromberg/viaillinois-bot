import { featureById } from '../features/registry.ts';
import { WEEKDAY_NAMES, describeHour } from '../jobs/clock.ts';
import { campusStamp, toInstant } from '../render/campusTime.ts';
import { eventSummary } from '../render/eventCard.ts';
import { ViaError, type PersonalCalendar, type Rso, type ViaEvent } from '../via/client.ts';
import {
  LINK_BUTTON, NOT_AN_RSO_MESSAGE, NO_SUCH_RSO_MESSAGE, answerFor, identifier, requireLink,
} from './shared.ts';
import type { CommandContext, CommandHandler, ComponentHandler } from './types.ts';
import type { AutocompleteChoice, Interaction, Reply, ReplyRow } from '../discord/adapter.ts';
import type { FeedPreferences, Follows } from '../feed/store.ts';

/**
 * The personal feed: following, the settings panel, the reminders somebody
 * asked for, and the personal calendar.
 *
 * All of it needs a VIA account, because all of it is one person's own feed,
 * and all of it is answered only to the person who asked, because a card can
 * sit in a channel a whole server reads and one person's reminder is not the
 * channel's business.
 *
 * Two rules from section 6.4 of the design live here. Following everything is
 * one answer rather than a row per organization, so an organization created
 * tomorrow is followed too. And the set of organizations somebody follows is
 * sent to the web platform whenever it changes, so the calendar their phone
 * subscribes to stays current without anybody asking it to. That second call
 * happens after the person has been answered, because it is the web platform's
 * work rather than theirs to wait for, and a person who has no calendar yet is
 * not an error: there is simply nothing to update.
 */

const followFeature = featureById('feed.follow');
const digestFeature = featureById('feed.digest');
const remindersFeature = featureById('feed.reminders');
const calendarFeature = featureById('feed.calendar');

/** What the organization option carries when somebody means all of ECE. */
export const ALL_ORGANIZATIONS = 'all';

/** How the choice of following everything reads in the list Discord offers. */
export const ALL_ORGANIZATIONS_LABEL = 'Every organization in ECE';

export const FOLLOW_NOTHING_NAMED_MESSAGE =
  'Please choose an organization from the list Discord offers as you type, or choose every organization in ECE.';

export const NOTHING_FOLLOWED_MESSAGE =
  'You do not follow any organizations yet, so VIA has nothing of its own to send you.';

export const NO_REMINDERS_MESSAGE =
  'You have asked to be reminded of nothing so far. Press Remind me on any event and it will appear here.';

export const EVENT_GONE_MESSAGE =
  'VIA does not have that event any more, so there is nothing to be reminded of.';

/** How long a reminder can be asked for ahead of an event, in the words of the menu. */
export const LEAD_CHOICES: readonly { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 minutes before' },
  { minutes: 30, label: '30 minutes before' },
  { minutes: 60, label: 'An hour before' },
  { minutes: 120, label: 'Two hours before' },
  { minutes: 240, label: 'Four hours before' },
  { minutes: 1440, label: 'A day before' },
];

/** How long a reminder lead time is, in the words the settings panel writes. */
export function describeLead(minutes: number): string {
  return `${minutes} minutes`;
}

/** What somebody follows, in one sentence and a list. */
export function describeFollows(follows: Follows, rsos: readonly Rso[]): string {
  if (follows.all) {
    return 'You follow every organization in ECE, including any that appears after today.';
  }
  if (follows.rsoIds.length === 0) return NOTHING_FOLLOWED_MESSAGE;

  const names = follows.rsoIds.map(rsoId =>
    rsos.find(rso => rso.rsoId === rsoId)?.name ?? `Organization ${rsoId}`);
  return ['You follow:', ...names.map(name => `- ${name}`)].join('\n');
}

/** The answer the calendar command gives, which is an address and how to treat it. */
export function calendarAnswer(calendar: PersonalCalendar): string {
  return [
    'Here is your private VIA calendar address:',
    calendar.address,
    '',
    'Add it to your calendar application as a subscription, and every event of the organizations you follow will appear there and stay current on its own.',
    'Keep the address private, because anybody who has it can read the events you follow. Run this command again to replace it, which stops the old address working.',
  ].join('\n');
}

/**
 * The settings panel, over User_Preferences.
 *
 * It is one ephemeral message that is edited in place as somebody works
 * through it, as the setup panels are, because a person changing two settings
 * should end with one message rather than three.
 */
export function renderFeedSettings(preferences: FeedPreferences): Reply {
  const lines = [
    '**What VIA sends you**',
    '',
    `Weekly digest: ${WEEKDAY_NAMES[preferences.digestDay]} at ${describeHour(preferences.digestHour)}.`,
    `Reminders: ${describeLead(preferences.reminderLeadMinutes)} before an event you asked to be reminded of.`,
    `Direct messages: ${preferences.directMessageOptOut ? 'off' : 'on'}.`,
    `Feedback after an event: ${preferences.feedbackOptOut ? 'off' : 'on'}.`,
    '',
    'Turning direct messages off stops the digest and the reminders. Everything you follow is kept, so turning them on again brings both back.',
  ];

  const rows: ReplyRow[] = [
    {
      kind: 'row',
      components: [{
        kind: 'select',
        selectKind: 'string',
        customId: 'feed:day',
        placeholder: 'Choose the day your digest arrives on',
        options: WEEKDAY_NAMES.map((name, day) => ({
          label: name,
          value: String(day),
          selected: day === preferences.digestDay,
        })),
      }],
    },
    {
      kind: 'row',
      components: [{
        kind: 'select',
        selectKind: 'string',
        customId: 'feed:hour',
        placeholder: 'Choose the hour your digest arrives at',
        options: Array.from({ length: 24 }, (_unused, hour) => ({
          label: describeHour(hour),
          value: String(hour),
          selected: hour === preferences.digestHour,
        })),
      }],
    },
    {
      kind: 'row',
      components: [{
        kind: 'select',
        selectKind: 'string',
        customId: 'feed:lead',
        placeholder: 'Choose how far ahead your reminders arrive',
        options: LEAD_CHOICES.map(choice => ({
          label: choice.label,
          value: String(choice.minutes),
          selected: choice.minutes === preferences.reminderLeadMinutes,
        })),
      }],
    },
    {
      kind: 'row',
      components: [
        {
          kind: 'button',
          style: preferences.directMessageOptOut ? 'secondary' : 'primary',
          label: preferences.directMessageOptOut ? 'Turn direct messages on' : 'Turn direct messages off',
          customId: 'feed:directmessages',
        },
        {
          kind: 'button',
          style: preferences.feedbackOptOut ? 'secondary' : 'primary',
          label: preferences.feedbackOptOut ? 'Turn feedback messages on' : 'Turn feedback messages off',
          customId: 'feed:feedback',
        },
      ],
    },
  ];

  return { content: lines.join('\n'), components: rows };
}

/**
 * Tell the web platform which organizations the person's calendar carries.
 *
 * A person who has never asked for a calendar has nothing to update, which the
 * web platform says with a not found rather than a failure, and neither the
 * command nor the person needs to hear about it.
 */
export async function sendCalendarSet(context: CommandContext, discordUserId: string): Promise<void> {
  const follows = await context.feed.follows(discordUserId);
  try {
    await context.via.updatePersonalCalendarRsos(
      follows.all ? null : follows.rsoIds,
      discordUserId,
    );
  } catch (err) {
    if (err instanceof ViaError && err.code === 'not_found') return;
    console.error('updating a personal calendar failed:', (err as Error).message);
  }
}

/** What somebody follows, read back with the organization names filled in. */
async function followingAnswer(interaction: Interaction, context: CommandContext): Promise<string> {
  const [follows, rsos] = await Promise.all([
    context.feed.follows(interaction.userId),
    context.via.listRsos(),
  ]);
  return describeFollows(follows, rsos);
}

/** The organization an option names, or the reason it names none. */
async function chosenRso(
  raw: unknown,
  context: CommandContext,
): Promise<{ rso: Rso } | { refusal: string }> {
  const rsoId = identifier(raw);
  if (rsoId === null) return { refusal: NOT_AN_RSO_MESSAGE };
  const rsos = await context.via.listRsos();
  const rso = rsos.find(one => one.rsoId === rsoId);
  return rso ? { rso } : { refusal: NO_SUCH_RSO_MESSAGE };
}

/** Follow one organization, which is what the command and the card button both do. */
export async function followRso(
  interaction: Interaction,
  context: CommandContext,
  rsoId: number,
  rsoName: string,
): Promise<Reply> {
  const isNew = await context.feed.follow(interaction.userId, rsoId);
  context.schedule(() => sendCalendarSet(context, interaction.userId));

  if (!isNew) {
    return { content: `You already follow ${rsoName}, so nothing has changed.` };
  }
  return {
    content: `You now follow ${rsoName}. It will appear in your weekly digest, and you can stop at any time with the unfollow command.`,
  };
}

/**
 * The organizations the option completes to, with following everything first,
 * because somebody who wants that would otherwise have no name to type to find
 * it. All three names complete the same option from the same list.
 */
async function completeOrganization(
  interaction: Interaction,
  context: CommandContext,
): Promise<AutocompleteChoice[]> {
  if (interaction.focusedOption?.name !== 'rso') return [];
  const typed = (interaction.focusedOption.value ?? '').trim().toLowerCase();

  const choices: AutocompleteChoice[] = [];
  if (!typed || ALL_ORGANIZATIONS_LABEL.toLowerCase().includes(typed)) {
    choices.push({ name: ALL_ORGANIZATIONS_LABEL, value: ALL_ORGANIZATIONS });
  }
  for (const rso of await context.via.listRsos()) {
    if (typed && !rso.name.toLowerCase().includes(typed)) continue;
    choices.push({ name: rso.name, value: String(rso.rsoId) });
  }
  return choices;
}

export const followCommand: CommandHandler = {
  featureId: followFeature.id,
  name: followFeature.command!.name,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const needsLink = await requireLink(interaction, context);
    if (needsLink) return needsLink;

    const raw = interaction.options.rso;
    try {
      if (raw === undefined) {
        return { content: `${FOLLOW_NOTHING_NAMED_MESSAGE}\n\n${await followingAnswer(interaction, context)}` };
      }

      if (String(raw) === ALL_ORGANIZATIONS) {
        await context.feed.setFollowAll(interaction.userId, true);
        context.schedule(() => sendCalendarSet(context, interaction.userId));
        return {
          content: 'You now follow every organization in ECE, including any that appears after today. Run the unfollow command to stop.',
        };
      }

      const chosen = await chosenRso(raw, context);
      if ('refusal' in chosen) return { content: chosen.refusal };
      return await followRso(interaction, context, chosen.rso.rsoId, chosen.rso.name);
    } catch (err) {
      return answerFor(err);
    }
  },

  autocomplete: completeOrganization,
};

export const unfollowCommand: CommandHandler = {
  featureId: followFeature.id,
  name: followFeature.command!.alternateNames![0]!.name,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const needsLink = await requireLink(interaction, context);
    if (needsLink) return needsLink;

    const raw = interaction.options.rso;
    try {
      if (raw === undefined) {
        return { content: `${FOLLOW_NOTHING_NAMED_MESSAGE}\n\n${await followingAnswer(interaction, context)}` };
      }

      if (String(raw) === ALL_ORGANIZATIONS) {
        await context.feed.setFollowAll(interaction.userId, false);
        context.schedule(() => sendCalendarSet(context, interaction.userId));
        return {
          content: 'You no longer follow every organization in ECE. The organizations you followed one by one are still followed.',
        };
      }

      const chosen = await chosenRso(raw, context);
      if ('refusal' in chosen) return { content: chosen.refusal };

      const removed = await context.feed.unfollow(interaction.userId, chosen.rso.rsoId);
      context.schedule(() => sendCalendarSet(context, interaction.userId));
      return {
        content: removed
          ? `You no longer follow ${chosen.rso.name}.`
          : `You do not follow ${chosen.rso.name}, so there was nothing to stop.`,
      };
    } catch (err) {
      return answerFor(err);
    }
  },

  autocomplete: completeOrganization,
};

export const followingCommand: CommandHandler = {
  featureId: followFeature.id,
  name: followFeature.command!.alternateNames![1]!.name,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const needsLink = await requireLink(interaction, context);
    if (needsLink) return needsLink;

    const raw = interaction.options.rso;
    try {
      if (raw !== undefined && String(raw) !== ALL_ORGANIZATIONS) {
        const chosen = await chosenRso(raw, context);
        if ('refusal' in chosen) return { content: chosen.refusal };
        const follows = await context.feed.follows(interaction.userId);
        const followed = follows.all || follows.rsoIds.includes(chosen.rso.rsoId);
        return {
          content: followed
            ? `You follow ${chosen.rso.name}.`
            : `You do not follow ${chosen.rso.name}. Run the follow command to start.`,
        };
      }
      return { content: await followingAnswer(interaction, context) };
    } catch (err) {
      return answerFor(err);
    }
  },

  autocomplete: completeOrganization,
};

export const feedSettingsCommand: CommandHandler = {
  featureId: digestFeature.id,
  name: `${digestFeature.command!.group} ${digestFeature.command!.name}`,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const needsLink = await requireLink(interaction, context);
    if (needsLink) return needsLink;
    return renderFeedSettings(await context.feed.preferences(interaction.userId));
  },
};

/** One number a menu carried, when it carried one the panel offers. */
function chosenNumber(values: readonly string[], allowed: (value: number) => boolean): number | null {
  const chosen = identifier(values[0]);
  return chosen !== null && allowed(chosen) ? chosen : null;
}

export const feedComponent: ComponentHandler = {
  featureId: digestFeature.id,
  prefix: 'feed:',
  updateInPlace: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const needsLink = await requireLink(interaction, context);
    if (needsLink) return needsLink;

    const customId = interaction.customId ?? '';
    const held = await context.feed.preferences(interaction.userId);

    if (customId === 'feed:day') {
      const day = chosenNumber(interaction.values, value => value >= 0 && value <= 6);
      if (day === null) return renderFeedSettings(held);
      return renderFeedSettings(await context.feed.savePreferences(interaction.userId, { digestDay: day }));
    }

    if (customId === 'feed:hour') {
      const hour = chosenNumber(interaction.values, value => value >= 0 && value <= 23);
      if (hour === null) return renderFeedSettings(held);
      return renderFeedSettings(await context.feed.savePreferences(interaction.userId, { digestHour: hour }));
    }

    if (customId === 'feed:lead') {
      const minutes = chosenNumber(
        interaction.values,
        value => LEAD_CHOICES.some(choice => choice.minutes === value),
      );
      if (minutes === null) return renderFeedSettings(held);
      return renderFeedSettings(
        await context.feed.savePreferences(interaction.userId, { reminderLeadMinutes: minutes }),
      );
    }

    if (customId === 'feed:directmessages') {
      return renderFeedSettings(await context.feed.savePreferences(interaction.userId, {
        directMessageOptOut: !held.directMessageOptOut,
      }));
    }

    if (customId === 'feed:feedback') {
      return renderFeedSettings(await context.feed.savePreferences(interaction.userId, {
        feedbackOptOut: !held.feedbackOptOut,
      }));
    }

    return renderFeedSettings(held);
  },
};

/**
 * Ask for a reminder, or take one back, which is what the Remind me button on
 * the event card does. The lead time is the person's own, so the same button
 * means an hour ahead for one person and a day ahead for another.
 */
export async function toggleReminder(
  interaction: Interaction,
  context: CommandContext,
  event: ViaEvent,
): Promise<Reply> {
  const held = await context.feed.listReminders(interaction.userId);
  if (held.some(row => row.eventId === event.eventId)) {
    await context.feed.removeReminderFor(interaction.userId, event.eventId);
    return { content: `You will no longer be reminded about ${event.title}.` };
  }

  const start = toInstant(event.startTime);
  if (!start) return { content: EVENT_GONE_MESSAGE };

  const preferences = await context.feed.preferences(interaction.userId);
  const remindAt = new Date(start.getTime() - preferences.reminderLeadMinutes * 60_000);
  await context.feed.addReminder(interaction.userId, event.eventId, campusStamp(remindAt));

  if (preferences.directMessageOptOut) {
    return {
      content: `You will be reminded about ${event.title} ${describeLead(preferences.reminderLeadMinutes)} before it starts, but your direct messages are turned off, so run the feed settings command to turn them on.`,
    };
  }
  return {
    content: `You will be reminded about ${event.title} by direct message ${describeLead(preferences.reminderLeadMinutes)} before it starts.`,
  };
}

export const feedRemindersCommand: CommandHandler = {
  featureId: remindersFeature.id,
  name: `${remindersFeature.command!.group} ${remindersFeature.command!.name}`,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const needsLink = await requireLink(interaction, context);
    if (needsLink) return needsLink;

    const held = await context.feed.listReminders(interaction.userId);
    if (held.length === 0) return { content: NO_REMINDERS_MESSAGE };

    const lines = ['**The events you asked to be reminded of**', ''];
    for (const row of held) {
      let event: ViaEvent | null = null;
      try {
        event = await context.via.getEvent(row.eventId, interaction.userId);
      } catch (err) {
        return answerFor(err);
      }
      // An event VIA no longer has is a reminder about nothing, which the
      // reminder job clears when it comes due.
      if (!event) continue;
      lines.push(`- ${eventSummary(event, { withRso: true })}`);
    }

    if (lines.length === 2) return { content: NO_REMINDERS_MESSAGE };
    lines.push('', 'Press Remind me on any of them again to take the reminder back.');
    return { content: lines.join('\n') };
  },
};

export const calendarCommand: CommandHandler = {
  featureId: calendarFeature.id,
  name: calendarFeature.command!.name,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const needsLink = await requireLink(interaction, context);
    if (needsLink) return needsLink;

    const follows = await context.feed.follows(interaction.userId);
    let calendar: PersonalCalendar;
    try {
      calendar = await context.via.createPersonalCalendar(
        follows.all ? null : follows.rsoIds,
        interaction.userId,
      );
    } catch (err) {
      if (err instanceof ViaError && err.code === 'not_linked') {
        return { content: 'VIA does not know this Discord account, so there is no calendar to give you. Please link this Discord account and try again.', components: LINK_BUTTON };
      }
      return answerFor(err);
    }
    return { content: calendarAnswer(calendar) };
  },
};
