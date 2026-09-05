import { featureById } from '../features/registry.ts';
import { renderEventCard } from '../render/eventCard.ts';
import { campusDateTime, campusWallClock } from '../render/campusTime.ts';
import { ViaError, type LinkedAccount, type ViaEvent } from '../via/client.ts';
import {
  actOnVia, identifier, NOTHING_TO_ACT_ON_MESSAGE, NOT_LINKED_TO_ACT_MESSAGE,
  notAnEditorMessage, LINK_BUTTON,
} from './shared.ts';
import type { CommandContext, CommandHandler, ComponentHandler } from './types.ts';
import type { AutocompleteChoice, Interaction, Reply, ReplyRow } from '../discord/adapter.ts';

export { NOT_LINKED_TO_ACT_MESSAGE, notAnEditorMessage } from './shared.ts';

/**
 * The administrative actions of section 6.7 of the design.
 *
 * Six things a board does about one event, from wherever they happen to be
 * reading about it: move it, cancel it, change what it says, switch it between
 * public and internal, pin a note about where it is, and post its announcement
 * again. Each is a command for somebody who prefers typing and a button on the
 * card for somebody who is already looking at one.
 *
 * Not one of them decides whether the person may do it. Every call carries the
 * acting Discord account and nothing else, the web platform resolves that to a
 * NetID through its own link table and applies exactly the rules the dashboard
 * applies, and the bot turns the refusal it gets back into one sentence. That
 * is the whole of the authorization in this module, and it is why a rule
 * changed on the web platform reaches Discord the moment it deploys.
 *
 * Re posting is the one action that changes nothing on VIA, and it is also the
 * one the web platform has no endpoint to be asked about. It is also the one
 * that asks something of the server as well as of the person, because it posts
 * a message. Both are described where it is implemented, below.
 */

const postponeFeature = featureById('admin.postpone');
const cancelFeature = featureById('admin.cancel');
const describeFeature = featureById('admin.describe');
const visibilityFeature = featureById('admin.visibility');
const repostFeature = featureById('admin.repost');
const noteFeature = featureById('admin.locationnote');

/** How wide the two boxes a board types into are, as the web platform bounds them. */
export const MAX_REASON_LENGTH = 500;
export const MAX_NOTE_LENGTH = 500;
export const MAX_DESCRIPTION_LENGTH = 2000;

export const NOT_AN_EVENT_MESSAGE =
  'Please choose an event from the list Discord offers as you type, rather than typing a title of your own.';

export const TIME_NOT_READ_MESSAGE =
  'Please write each time as YYYY-MM-DD HH:MM, such as 2026-09-17 18:00, so that VIA reads the same moment you meant.';

export const GUILD_ONLY_MESSAGE =
  "This acts on one of your organization's events in a server, so it has to be run inside a server.";

/**
 * The identifiers the administrative buttons carry. Every one of them ends in
 * the event it is about, so a button pressed on a message the bot posted last
 * term still says what it is for.
 */
export const ADMIN_BUTTON = {
  manage: (eventId: number) => `admin:manage:${eventId}`,
  // The three that open a form carry a prefix of their own, because a button
  // that opens one is answered before the interaction is acknowledged and
  // everything else is answered after. Keeping them apart means the actions
  // that call the web platform twice still have Discord's longer window.
  postpone: (eventId: number) => `${FORM_PREFIX}postpone:${eventId}`,
  describe: (eventId: number) => `${FORM_PREFIX}describe:${eventId}`,
  note: (eventId: number) => `${FORM_PREFIX}note:${eventId}`,
  cancel: (eventId: number) => `admin:cancel:${eventId}`,
  confirmCancel: (eventId: number) => `admin:cancelyes:${eventId}`,
  visibility: (eventId: number) => `admin:visibility:${eventId}`,
  repost: (eventId: number) => `admin:repost:${eventId}`,
};

/** The start of every identifier that opens one of the three forms. */
export const FORM_PREFIX = 'admin:form:';

/** The event an action is about, or the sentence that says there is none. */
async function eventFor(
  eventId: number,
  interaction: Interaction,
  context: CommandContext,
): Promise<{ event: ViaEvent } | { refusal: Reply }> {
  // The read goes through the same helper the action itself does, so that a
  // web platform that is busy or refusing says the same thing here as it does
  // one call later.
  const outcome = await actOnVia(() => context.via.getEvent(eventId, interaction.userId));
  if (!outcome.ok) return { refusal: outcome.reply };
  if (!outcome.value) return { refusal: { content: NOTHING_TO_ACT_ON_MESSAGE } };
  return { event: outcome.value };
}

/** The card, drawn for somebody who may act on it, which is the answer every action ends with. */
function cardFor(event: ViaEvent, context: CommandContext, heading: string): Reply {
  const card = renderEventCard(event, { websiteUrl: context.websiteUrl, linked: true });
  return { ...card, content: `${heading}\n\n${card.content}` };
}

/**
 * Whether the acting person is an editor of the organization the event belongs
 * to, read from the memberships the web platform answers with.
 *
 * This is the one place in the bot that compares the web platform's answer
 * itself rather than reading a refusal, and it is here because re posting an
 * announcement writes nothing to VIA and the internal service API has no
 * endpoint that answers "may this person act" on its own. The comparison is
 * made against the memberships the web platform sends for that account, so it
 * is the web platform's answer about that person rather than a second rule,
 * and it is refused with the same code the acting endpoints refuse with so
 * that the sentence a person reads is the same one. The decision log carries
 * the endpoint this should become once the web platform has one.
 */
function requireEditorOf(event: ViaEvent, link: LinkedAccount | null): void {
  if (!link) {
    throw new ViaError('This Discord account is not linked to a VIA account.', 403, 'not_linked');
  }
  if (link.isGlobalAdmin) return;
  const editor = link.memberships.some(membership =>
    membership.rsoId === event.rsoId
    && (membership.role === 'editor' || membership.role === 'board' || membership.role === 'admin'));
  if (!editor) {
    throw new ViaError(
      'You are not an editor of that organization, so you cannot change its events.',
      403,
      'forbidden',
    );
  }
}

/** The form that moves an event, filled in with the times it runs at now. */
function postponeModal(event: ViaEvent): Reply {
  return {
    content: '',
    modal: {
      customId: ADMIN_BUTTON.postpone(event.eventId),
      title: 'Move this event',
      fields: [
        {
          customId: 'start',
          label: 'The new start, as YYYY-MM-DD HH:MM',
          value: campusWallClock(event.startTime),
          required: true,
        },
        {
          customId: 'end',
          label: 'The new end, as YYYY-MM-DD HH:MM',
          value: campusWallClock(event.endTime),
          required: true,
        },
        {
          customId: 'reason',
          label: 'Why it moved, which VIA passes on',
          style: 'paragraph',
          required: false,
          maxLength: MAX_REASON_LENGTH,
        },
      ],
    },
  };
}

/** The form that changes what an event says, filled in with what it says now. */
function describeModal(event: ViaEvent): Reply {
  return {
    content: '',
    modal: {
      customId: ADMIN_BUTTON.describe(event.eventId),
      title: 'What this event says',
      fields: [
        {
          customId: 'description',
          label: 'The description, as students read it',
          style: 'paragraph',
          value: event.description ?? '',
          required: false,
          maxLength: MAX_DESCRIPTION_LENGTH,
        },
      ],
    },
  };
}

/** The form that pins a note about where an event is, filled in with the note it carries. */
function noteModal(event: ViaEvent): Reply {
  return {
    content: '',
    modal: {
      customId: ADMIN_BUTTON.note(event.eventId),
      title: 'Where to find this event',
      fields: [
        {
          customId: 'note',
          label: 'The note, such as which entrance to use',
          value: event.locationNote ?? '',
          required: false,
          maxLength: MAX_NOTE_LENGTH,
        },
      ],
    },
  };
}

/** The confirmation a cancellation asks for, because a cancellation is read by a whole server. */
function cancelConfirmation(event: ViaEvent): Reply {
  const rows: ReplyRow[] = [{
    kind: 'row',
    components: [{
      kind: 'button',
      style: 'danger',
      label: 'Cancel this event',
      customId: ADMIN_BUTTON.confirmCancel(event.eventId),
    }],
  }];
  return {
    content: [
      `**${event.title}** runs on ${campusDateTime(event.startTime)}.`,
      '',
      'Cancelling it marks it as cancelled on VIA, edits the announcement in every server that made one, and posts a notice under it. The event itself is not deleted, so a student who planned to go is told rather than left wondering.',
    ].join('\n'),
    components: rows,
  };
}

/** A wall clock reading in the shape the web platform reads, or null for anything else. */
function wallClock(typed: string): string | null {
  const text = typed.trim();
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(text) ? text.replace('T', ' ') : null;
}

/** Move an event, with the times the form came back with. */
async function postpone(
  event: ViaEvent,
  fields: Record<string, string>,
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  const start = wallClock(fields.start ?? '');
  const end = wallClock(fields.end ?? '');
  // A modal is free text, so the shape is read here and the person is told
  // plainly, rather than the web platform being asked to read prose.
  if (!start || !end) return { content: TIME_NOT_READ_MESSAGE };

  const outcome = await actOnVia(
    () => context.via.postponeEvent(
      event.eventId,
      { startTime: start, endTime: end, reason: (fields.reason ?? '').trim() },
      interaction.userId,
    ),
    { rsoName: event.rsoName },
  );
  if (!outcome.ok) return outcome.reply;

  const moved = outcome.value ?? event;
  return cardFor(moved, context, `**${moved.title}** now runs on ${campusDateTime(moved.startTime)}.`);
}

async function cancel(
  event: ViaEvent,
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  const outcome = await actOnVia(
    () => context.via.cancelEvent(event.eventId, interaction.userId),
    { rsoName: event.rsoName },
  );
  if (!outcome.ok) return outcome.reply;

  return {
    content: [
      `**${event.title}** has been cancelled on VIA.`,
      '',
      'Every server that announced it has its announcement marked and a notice posted under it, and the people who asked to be reminded are told.',
    ].join('\n'),
  };
}

async function describe(
  event: ViaEvent,
  fields: Record<string, string>,
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  const typed = (fields.description ?? '').trim();
  const outcome = await actOnVia(
    () => context.via.patchEvent(event.eventId, { description: typed || null }, interaction.userId),
    { rsoName: event.rsoName },
  );
  if (!outcome.ok) return outcome.reply;

  const changed = outcome.value ?? event;
  const heading = typed
    ? `**${changed.title}** now says this.`
    : `**${changed.title}** no longer carries a description.`;
  return cardFor(changed, context, heading);
}

async function setVisibility(
  event: ViaEvent,
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  const wanted = !event.isPrivate;
  const outcome = await actOnVia(
    () => context.via.patchEvent(event.eventId, { isPrivate: wanted }, interaction.userId),
    { rsoName: event.rsoName },
  );
  if (!outcome.ok) return outcome.reply;

  const changed = outcome.value ?? event;
  const heading = wanted
    ? `**${changed.title}** is now internal, so only members of ${changed.rsoName ?? 'the organization'} see it.`
    : `**${changed.title}** is now public, so everybody sees it.`;
  return cardFor(changed, context, heading);
}

async function pinNote(
  event: ViaEvent,
  fields: Record<string, string>,
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  const typed = (fields.note ?? '').trim();
  const outcome = await actOnVia(
    () => context.via.patchEvent(event.eventId, { locationNote: typed || null }, interaction.userId),
    { rsoName: event.rsoName },
  );
  if (!outcome.ok) return outcome.reply;

  const changed = outcome.value ?? event;
  const heading = typed
    ? `The note on **${changed.title}** now reads: ${typed}`
    : `**${changed.title}** no longer carries a note about where it is.`;
  return cardFor(changed, context, heading);
}

/**
 * Post the announcement card again, in the channel this server bound to
 * announcements.
 *
 * Two things are asked of the server before anything is posted, and neither is
 * about the person. The server has to be one that follows the organization the
 * event belongs to, because an announcement of an organization's event in a
 * server that never asked to hear about that organization is the bot posting
 * where it was not invited. And the channel has to be the one the server bound
 * to announcements, because that is where the server said its announcements
 * go: posting into whichever channel the command happened to be run in would
 * let one editor put an announcement in any channel of any server the bot is
 * in, which is a server manager's decision rather than an editor's.
 *
 * The new announcement is written down as the server's announcement for that
 * event, so a later change edits the message people are actually reading
 * rather than the one that was pushed off the end of the channel.
 */
async function repost(
  event: ViaEvent,
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  const outcome = await actOnVia(async () => {
    requireEditorOf(event, await context.via.getLink(interaction.userId));
  }, { rsoName: event.rsoName });
  if (!outcome.ok) return outcome.reply;

  if (!interaction.guildId) return { content: GUILD_ONLY_MESSAGE };
  if (!context.postMessage) return { content: NOTHING_TO_POST_WITH_MESSAGE };

  const following = await context.guilds.listGuildsFollowing(event.rsoId);
  if (!following.some(installation => installation.guildId === interaction.guildId)) {
    return { content: NOT_FOLLOWED_HERE_MESSAGE };
  }

  const channels = await context.guilds.listChannels(interaction.guildId);
  const channelId = channels.announcements;
  if (!channelId) return { content: NO_ANNOUNCEMENTS_CHANNEL_MESSAGE };

  const card = renderEventCard(event, { websiteUrl: context.websiteUrl, manageable: true });
  const messageId = await context.postMessage(channelId, card);
  await context.mirrors?.recordAnnouncement(interaction.guildId, event.eventId, { channelId, messageId });

  return { content: `**${event.title}** has been announced again in <#${channelId}>.` };
}

export const NOTHING_TO_POST_WITH_MESSAGE =
  'The bot cannot post in this server right now, so the announcement has not been posted again. Please try again in a few minutes.';

export const NOT_FOLLOWED_HERE_MESSAGE =
  'This server does not follow the organization that event belongs to, so its announcements do not go here.';

export const NO_ANNOUNCEMENTS_CHANNEL_MESSAGE =
  'This server has no channel bound to announcements, so a server manager has to bind one with the config command before an announcement can be posted here again.';

/** The card, for a linked person, which is what the manage button opens. */
async function manage(
  event: ViaEvent,
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  const outcome = await actOnVia(async () => {
    const link = await context.via.getLink(interaction.userId);
    if (!link) {
      throw new ViaError('This Discord account is not linked to a VIA account.', 403, 'not_linked');
    }
  });
  if (!outcome.ok) return outcome.reply;

  return renderEventCard(event, { websiteUrl: context.websiteUrl, linked: true });
}

/**
 * One handler for every administrative button and every form sent back from
 * one, because they are one set of actions over one event and Discord routes
 * both by the identifier the message was built with.
 */
/** The event an identifier is about, which is always its last part. */
function eventIdOf(customId: string): number | null {
  const parts = customId.split(':');
  return identifier(parts[parts.length - 1]);
}

/**
 * The three actions that open a form, and the forms they send back.
 *
 * A button that opens a form is answered before the interaction is
 * acknowledged, because Discord takes a form only as the first thing said
 * about one. That leaves three seconds rather than fifteen minutes, so these
 * three make one call to fill the boxes in and nothing more. The form that
 * comes back is a new interaction, so the write behind it is acknowledged and
 * answered like anything else.
 */
export const adminFormComponent: ComponentHandler = {
  featureId: postponeFeature.id,
  prefix: FORM_PREFIX,
  ephemeral: true,
  opensModal: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const customId = interaction.customId ?? '';
    const eventId = eventIdOf(customId);
    if (eventId === null) return { content: NOTHING_TO_ACT_ON_MESSAGE };

    const found = await eventFor(eventId, interaction, context);
    if ('refusal' in found) return found.refusal;
    const { event } = found;

    // A form that has been sent back carries what was typed, and the button of
    // the same name opens that form. Discord tells the two apart by the kind
    // of interaction, so nothing has to be encoded in the identifier.
    const submitted = interaction.kind === 'modal';

    if (customId === ADMIN_BUTTON.postpone(eventId)) {
      return submitted
        ? postpone(event, interaction.fields, interaction, context)
        : postponeModal(event);
    }

    if (customId === ADMIN_BUTTON.describe(eventId)) {
      return submitted
        ? describe(event, interaction.fields, interaction, context)
        : describeModal(event);
    }

    if (customId === ADMIN_BUTTON.note(eventId)) {
      return submitted
        ? pinNote(event, interaction.fields, interaction, context)
        : noteModal(event);
    }

    return { content: NOTHING_TO_ACT_ON_MESSAGE };
  },
};

/** The three actions that answer with a message, and the card that opens from an announcement. */
export const adminComponent: ComponentHandler = {
  featureId: postponeFeature.id,
  prefix: 'admin:',
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const customId = interaction.customId ?? '';
    const eventId = eventIdOf(customId);
    if (eventId === null) return { content: NOTHING_TO_ACT_ON_MESSAGE };

    const found = await eventFor(eventId, interaction, context);
    if ('refusal' in found) return found.refusal;
    const { event } = found;

    if (customId === ADMIN_BUTTON.manage(eventId)) return manage(event, interaction, context);
    if (customId === ADMIN_BUTTON.cancel(eventId)) return cancelConfirmation(event);
    if (customId === ADMIN_BUTTON.confirmCancel(eventId)) return cancel(event, interaction, context);
    if (customId === ADMIN_BUTTON.visibility(eventId)) return setVisibility(event, interaction, context);
    if (customId === ADMIN_BUTTON.repost(eventId)) return repost(event, interaction, context);

    return { content: NOTHING_TO_ACT_ON_MESSAGE };
  },
};

/**
 * The events an organization has coming up, for the option every
 * administrative command takes. It completes from the listing that does not
 * ask for internal events, which is the one the client caches, exactly as the
 * event command's own completion does.
 */
async function completeEvents(
  interaction: Interaction,
  context: CommandContext,
): Promise<AutocompleteChoice[]> {
  if (interaction.focusedOption?.name !== 'event') return [];
  const typed = (interaction.focusedOption.value ?? '').trim().toLowerCase();
  const page = await context.via.listEvents({ limit: 100 });

  return page.events
    .filter(event => !typed
      || event.title.toLowerCase().includes(typed)
      || (event.rsoName ?? '').toLowerCase().includes(typed))
    .slice(0, 25)
    .map(event => ({
      name: [event.title, event.rsoName, campusDateTime(event.startTime)].filter(Boolean).join(', '),
      value: String(event.eventId),
    }));
}

/** What every administrative command does before it does its own work. */
async function commandEvent(
  interaction: Interaction,
  context: CommandContext,
): Promise<{ event: ViaEvent } | { refusal: Reply }> {
  if (!interaction.guildId) return { refusal: { content: GUILD_ONLY_MESSAGE } };
  const eventId = identifier(interaction.options.event);
  if (eventId === null) return { refusal: { content: NOT_AN_EVENT_MESSAGE } };
  return eventFor(eventId, interaction, context);
}

/**
 * One command per action, each of them the same two steps: read the event the
 * option named, then do exactly what the button of that name does.
 */
function adminCommand(
  featureId: string,
  name: string,
  act: (event: ViaEvent, interaction: Interaction, context: CommandContext) => Promise<Reply> | Reply,
  options: { opensModal?: boolean } = {},
): CommandHandler {
  return {
    featureId,
    name: `via ${name}`,
    ephemeral: true,
    ...(options.opensModal ? { opensModal: true } : {}),

    async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
      const found = await commandEvent(interaction, context);
      if ('refusal' in found) return found.refusal;
      return act(found.event, interaction, context);
    },

    autocomplete: completeEvents,
  };
}

export const postponeCommand = adminCommand(
  postponeFeature.id,
  postponeFeature.command!.name,
  event => postponeModal(event),
  { opensModal: true },
);

export const cancelCommand = adminCommand(
  cancelFeature.id,
  cancelFeature.command!.name,
  event => cancelConfirmation(event),
);

export const describeCommand = adminCommand(
  describeFeature.id,
  describeFeature.command!.name,
  event => describeModal(event),
  { opensModal: true },
);

export const visibilityCommand = adminCommand(
  visibilityFeature.id,
  visibilityFeature.command!.name,
  (event, interaction, context) => setVisibility(event, interaction, context),
);

export const repostCommand = adminCommand(
  repostFeature.id,
  repostFeature.command!.name,
  (event, interaction, context) => repost(event, interaction, context),
);

export const noteCommand = adminCommand(
  noteFeature.id,
  noteFeature.command!.name,
  event => noteModal(event),
  { opensModal: true },
);

/** Kept for the modules that offer the link button beside a refusal of their own. */
export { LINK_BUTTON };
