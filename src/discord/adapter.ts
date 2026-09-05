import {
  ApplicationIntegrationType, ChannelType, ComponentType, GuildScheduledEventEntityType,
  GuildScheduledEventPrivacyLevel, InteractionContextType, InteractionType, MessageFlags,
  PermissionFlagsBits, TextInputStyle,
} from 'discord.js';
import type { Client } from 'discord.js';
import type { DiscordPermission, InteractionContext } from '../features/registry.ts';

/**
 * What Discord will carry in one message: how long it may be, and how many
 * rows of components it may hold. Both are Discord's limits rather than the
 * bot's, and they are named here because this is the module that is about
 * Discord itself. Everything that builds a message reads them from here rather
 * than keeping a number of its own.
 */
export const MAX_MESSAGE_LENGTH = 2000;
export const MAX_MESSAGE_ROWS = 5;

/**
 * The seam between discord.js and everything else.
 *
 * Interactions arrive here and leave as plain objects. Answers arrive here as
 * plain objects and leave as library calls. Nothing beyond this file and
 * client.ts imports discord.js, so a command is tested by handing it an
 * object literal and reading the object it answers with, and no test needs a
 * gateway connection.
 *
 * The deferral rule lives here too. Discord gives an application three
 * seconds to acknowledge an interaction and fifteen minutes to answer it, and
 * the web platform can take longer than three seconds under load, so
 * respond() acknowledges first and edits the acknowledgement with the answer.
 * A person sees a thinking state rather than a failed command.
 */

export type InteractionKind = 'chatCommand' | 'button' | 'select' | 'modal' | 'autocomplete';

/** The value an application command option can carry, once the library has resolved it. */
export type OptionValue = string | number | boolean;

export interface Interaction {
  kind: InteractionKind;
  /** Discord's identifier for this interaction, which the logs carry. */
  id: string;
  /**
   * The command, with its subcommand group and subcommand separated by
   * spaces, so that `/via setup` arrives as "via setup" and the dispatcher
   * has one string to key on. Null for anything that is not a command.
   */
  commandName: string | null;
  /** The options a command was given, by name. */
  options: Record<string, OptionValue>;
  /** The identifier a component or modal was built with. Null for a command. */
  customId: string | null;
  /** What was chosen in a select menu. */
  values: string[];
  /** What was typed into a modal, by field identifier. */
  fields: Record<string, string>;
  /** The option a person is still typing, on an autocomplete. */
  focusedOption: { name: string; value: string } | null;
  userId: string;
  guildId: string | null;
  channelId: string | null;
  /** Where the person is: a server, the bot direct messages, or another private channel. */
  context: InteractionContext;
  /**
   * Whether the server this interaction came from has installed the bot.
   *
   * Section 6.8 of the design publishes the application with both installation
   * contexts, so a person who installed it to their own account can use it in
   * a server that has not added it. Discord says which installation authorized
   * the interaction, and an interaction authorized only by the person is
   * answered where only they can see it, because the bot was not invited into
   * that server's channels. Outside a server there is no server to have
   * installed anything, so this is true.
   */
  installedInServer: boolean;
  /**
   * The permissions the person holds in this server, named as the registry
   * names them. Empty outside a server, where there are no server permissions
   * to hold. Setup reads this, because being a server manager is a Discord
   * permission and not a VIA role.
   */
  memberPermissions: readonly DiscordPermission[];
  /**
   * The permissions the bot itself holds here, named as the registry names
   * them. The setup panel reads this to say which features cannot work
   * because a grant is missing, which is a question about the bot rather than
   * about the person. Empty outside a server.
   */
  applicationPermissions: readonly DiscordPermission[];
}

export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger' | 'link';

/**
 * Whether a menu picks from a list the bot wrote, from the server's channels,
 * or from the server's roles. The role menu is Discord's own, so a server
 * mapping its member role does not have to keep a list of role identifiers in
 * step with the bot.
 */
export type SelectKind = 'string' | 'channel' | 'role';

/** One entry in a menu the bot wrote. */
export interface ReplySelectOption {
  label: string;
  value: string;
  description?: string;
  /** Whether the entry is shown as the one already chosen. */
  selected?: boolean;
}

export interface ReplyButton {
  kind: 'button';
  label: string;
  style: ButtonStyle;
  /** A button that opens an address, which is a link button and carries no identifier. */
  url?: string;
  /** A button the bot answers, which carries the identifier its handler keys on. */
  customId?: string;
  disabled?: boolean;
}

/**
 * A menu. The setup panels are built out of these: one menu of fixed choices
 * for the kind of server, the binding and the feature toggles, and one menu
 * of the server's own channels for each channel purpose, which is Discord's
 * channel select rather than a list the bot has to keep in step with the
 * server.
 */
export interface ReplySelect {
  kind: 'select';
  selectKind: SelectKind;
  customId: string;
  placeholder?: string;
  /** How few and how many entries a person may choose, one and one by default. */
  minValues?: number;
  maxValues?: number;
  /** The entries, for a menu of fixed choices. */
  options?: ReplySelectOption[];
  disabled?: boolean;
}

export type ReplyComponent = ReplyButton | ReplySelect;

export interface ReplyRow {
  kind: 'row';
  components: ReplyComponent[];
}

/**
 * A file the answer carries, such as the calendar file for an event. The
 * content is held as text because everything the bot attaches is text, and
 * it is turned into the buffer the library wants at the edge.
 */
export interface ReplyFile {
  name: string;
  content: string;
  contentType?: string;
}

export interface Reply {
  content: string;
  /** Whether only the person who asked sees the answer. */
  ephemeral?: boolean;
  components?: ReplyRow[];
  files?: ReplyFile[];
  /**
   * A form to open instead of a message. Discord allows an application to
   * show a modal only as the first thing it says about an interaction, never
   * after an acknowledgement, so a handler that answers with one is run
   * before anything is acknowledged and the rest of this reply is unused.
   */
  modal?: ReplyModal;
}

/** Whether a box in a modal is one line or several. */
export type ModalFieldStyle = 'short' | 'paragraph';

/** One box in a modal, filled in with what it holds now where there is one. */
export interface ReplyModalField {
  /** The identifier the submitted value arrives under. */
  customId: string;
  /** What the person reads above the box, at most forty five characters. */
  label: string;
  style?: ModalFieldStyle;
  /** What the box starts with, which is how a modal is pre filled. */
  value?: string;
  placeholder?: string;
  required?: boolean;
  maxLength?: number;
}

/**
 * A form Discord shows over the message. The identifier is what the submitted
 * form arrives under, so it carries what the handler needs to know, such as
 * the event being changed.
 */
export interface ReplyModal {
  customId: string;
  /** The heading of the form, at most forty five characters. */
  title: string;
  fields: ReplyModalField[];
}

/** One completion Discord offers while a person is still typing an option. */
export interface AutocompleteChoice {
  name: string;
  value: string;
}

/** How many completions Discord accepts, and how long each name may be. */
export const MAX_AUTOCOMPLETE_CHOICES = 25;
export const MAX_AUTOCOMPLETE_NAME = 100;

/**
 * The channels a purpose may be bound to. A purpose is a place the bot
 * posts, so the menu offers the two kinds of channel a message can be posted
 * in and nothing else.
 */
export const POSTABLE_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

/** The sentence a person sees when the work behind an interaction threw. */
export const FAILURE_MESSAGE = 'Something went wrong on the VIA side. Please try again in a moment.';

const BUTTON_STYLES: Record<ButtonStyle, number> = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
  link: 5,
};

/**
 * The library resolves options into a tree: a subcommand group holds a
 * subcommand, which holds the leaves. The command name takes the branches and
 * the option record takes the leaves, so a command reads one flat record
 * whatever shape it was declared with.
 */
function readOptions(data: readonly unknown[]): {
  path: string[];
  options: Record<string, OptionValue>;
  focused: { name: string; value: string } | null;
} {
  const path: string[] = [];
  const options: Record<string, OptionValue> = {};
  let focused: { name: string; value: string } | null = null;

  const walk = (entries: readonly unknown[]) => {
    for (const entry of entries) {
      const option = entry as {
        name: string;
        type: number;
        value?: OptionValue;
        focused?: boolean;
        options?: readonly unknown[];
      };
      // Subcommand groups are type 2 and subcommands type 1, as Discord numbers them.
      if (option.type === 1 || option.type === 2) {
        path.push(option.name);
        walk(option.options ?? []);
        continue;
      }
      if (option.value !== undefined) options[option.name] = option.value;
      if (option.focused) focused = { name: option.name, value: String(option.value ?? '') };
    }
  };
  walk(data);

  return { path, options, focused };
}

function readFields(raw: unknown): Record<string, string> {
  const fields = (raw as { fields?: { fields?: unknown } } | null)?.fields?.fields;
  if (!(fields instanceof Map)) return {};
  const values: Record<string, string> = {};
  for (const [name, field] of fields) {
    values[String(name)] = String((field as { value?: unknown })?.value ?? '');
  }
  return values;
}

function readKind(raw: { type?: number; componentType?: number }): InteractionKind {
  if (raw.type === InteractionType.ApplicationCommandAutocomplete) return 'autocomplete';
  if (raw.type === InteractionType.ModalSubmit) return 'modal';
  if (raw.type === InteractionType.MessageComponent) {
    return raw.componentType === ComponentType.Button ? 'button' : 'select';
  }
  return 'chatCommand';
}

/**
 * Which of the three contexts a person is in. The library reports it
 * directly on anything recent, and the server identifier settles it for
 * anything that does not.
 */
function readContext(raw: { context?: number | null; guildId?: string | null }): InteractionContext {
  if (raw.context === InteractionContextType.Guild) return 'guild';
  if (raw.context === InteractionContextType.BotDM) return 'botDm';
  if (raw.context === InteractionContextType.PrivateChannel) return 'privateChannel';
  return raw.guildId ? 'guild' : 'botDm';
}

/**
 * Whether the server an interaction came from has installed the bot.
 *
 * Discord names the installations that authorized an interaction, keyed by
 * installation context, so the server's own installation being among them is
 * the question. An interaction from outside a server has no server to have
 * installed anything. An interaction that names no owners at all is read as
 * installed, because that is every interaction Discord sent before user
 * installation existed.
 */
function readInstalledInServer(raw: {
  guildId?: string | null;
  authorizingIntegrationOwners?: Record<string, unknown> | null;
}): boolean {
  if (!raw.guildId) return true;
  const owners = raw.authorizingIntegrationOwners;
  if (!owners || typeof owners !== 'object') return true;
  return String(ApplicationIntegrationType.GuildInstall) in owners;
}

/**
 * The permissions a person holds in this server, by name.
 *
 * The library hands these over as a PermissionsBitField on anything recent
 * and as a decimal string on anything that has been through JSON, so both are
 * read. Administrator holds every permission on Discord's own side, and it is
 * expanded here so that no caller has to remember that.
 */
export function readPermissions(raw: unknown): DiscordPermission[] {
  const source = raw as { bitfield?: bigint | string } | bigint | string | null | undefined;
  const value = source === null || source === undefined
    ? null
    : (typeof source === 'object' ? (source as { bitfield?: bigint | string }).bitfield : source);
  if (value === null || value === undefined || value === '') return [];

  let bits: bigint;
  try {
    bits = BigInt(value);
  } catch {
    return [];
  }
  if (bits === 0n) return [];

  const names = Object.entries(PermissionFlagsBits) as [DiscordPermission, bigint][];
  return names.filter(([, flag]) => (bits & flag) === flag).map(([name]) => name);
}

/** Whether a person holds one named permission, with administrator holding all of them. */
export function hasPermission(interaction: Interaction, permission: DiscordPermission): boolean {
  return interaction.memberPermissions.includes('Administrator')
    || interaction.memberPermissions.includes(permission);
}

/** Turn a library interaction into the plain object every command is written against. */
export function toInteraction(raw: unknown): Interaction {
  const source = raw as {
    id: string;
    type?: number;
    componentType?: number;
    commandName?: string;
    customId?: string;
    values?: string[];
    options?: { data?: readonly unknown[] };
    user: { id: string };
    guildId?: string | null;
    channelId?: string | null;
    context?: number | null;
    authorizingIntegrationOwners?: Record<string, unknown> | null;
    memberPermissions?: unknown;
    appPermissions?: unknown;
  };

  const kind = readKind(source);
  const { path, options, focused } = readOptions(source.options?.data ?? []);
  const name = source.commandName ? [source.commandName, ...path].join(' ') : null;

  return {
    kind,
    id: String(source.id),
    commandName: kind === 'chatCommand' || kind === 'autocomplete' ? name : null,
    options,
    customId: source.customId ?? null,
    values: source.values ? [...source.values] : [],
    fields: kind === 'modal' ? readFields(source) : {},
    focusedOption: kind === 'autocomplete' ? focused : null,
    userId: String(source.user.id),
    guildId: source.guildId ?? null,
    channelId: source.channelId ?? null,
    context: readContext(source),
    installedInServer: readInstalledInServer(source),
    memberPermissions: source.guildId ? readPermissions(source.memberPermissions) : [],
    applicationPermissions: source.guildId ? readPermissions(source.appPermissions) : [],
  };
}

function buttonJson(button: ReplyButton): Record<string, unknown> {
  const built: Record<string, unknown> = {
    type: ComponentType.Button,
    style: BUTTON_STYLES[button.style],
    label: button.label,
  };
  if (button.url) built.url = button.url;
  if (button.customId) built.custom_id = button.customId;
  if (button.disabled) built.disabled = true;
  return built;
}

const SELECT_TYPES: Record<SelectKind, number> = {
  string: ComponentType.StringSelect,
  channel: ComponentType.ChannelSelect,
  role: ComponentType.RoleSelect,
};

function selectJson(select: ReplySelect): Record<string, unknown> {
  const built: Record<string, unknown> = {
    type: SELECT_TYPES[select.selectKind],
    custom_id: select.customId,
    min_values: select.minValues ?? 1,
    max_values: select.maxValues ?? 1,
  };
  if (select.placeholder) built.placeholder = select.placeholder;
  if (select.disabled) built.disabled = true;
  if (select.selectKind === 'channel') {
    built.channel_types = [...POSTABLE_CHANNEL_TYPES];
  } else if (select.selectKind === 'role') {
    // A role menu is Discord's own list, so it carries no options of ours.
  } else {
    built.options = (select.options ?? []).map(option => {
      const entry: Record<string, unknown> = { label: option.label, value: option.value };
      if (option.description) entry.description = option.description;
      if (option.selected) entry.default = true;
      return entry;
    });
  }
  // The placeholder reads better before the values in Discord's own payloads,
  // and the order of keys is what a test comparing whole objects sees.
  const ordered: Record<string, unknown> = { type: built.type, custom_id: built.custom_id };
  if (built.placeholder) ordered.placeholder = built.placeholder;
  ordered.min_values = built.min_values;
  ordered.max_values = built.max_values;
  if (built.disabled) ordered.disabled = true;
  if (built.options) ordered.options = built.options;
  if (built.channel_types) ordered.channel_types = built.channel_types;
  return ordered;
}

/**
 * A server, as the gateway announces it. The library hands over a whole guild
 * object with every channel and member it has cached, and the bot needs four
 * fields of it, so this is the same seam the interactions go through.
 */
export interface Guild {
  id: string;
  name: string | null;
  /** The only person the join event names, since it does not say who invited the bot. */
  ownerId: string;
  /**
   * Whether Discord can currently reach the server. A guild delete event with
   * this false is an outage rather than a removal, and the two have to be told
   * apart before anything is deleted.
   */
  available: boolean;
}

/** Turn a library guild into the plain object the lifecycle is written against. */
export function toGuild(raw: unknown): Guild {
  const source = raw as {
    id: string;
    name?: string | null;
    ownerId?: string | null;
    available?: boolean;
  };
  return {
    id: String(source.id),
    name: source.name ?? null,
    ownerId: String(source.ownerId ?? ''),
    available: source.available !== false,
  };
}

/**
 * Interest a person left on one of the server's scheduled events, as the
 * gateway reports it. The signal names the scheduled event rather than the VIA
 * event, and Event_Mirrors is what turns one into the other.
 */
export interface ScheduledEventInterest {
  /** Null when the library named no server, which nothing acts on. */
  guildId: string | null;
  scheduledEventId: string;
  discordUserId: string;
}

/** Turn the scheduled event and the person the gateway names into the three identifiers. */
export function toScheduledEventInterest(rawEvent: unknown, rawUser: unknown): ScheduledEventInterest {
  const event = rawEvent as { id?: string; guildId?: string | null; guild?: { id?: string } | null };
  const user = rawUser as { id?: string };
  const guildId = event?.guildId ?? event?.guild?.id ?? null;
  return {
    guildId: guildId ? String(guildId) : null,
    scheduledEventId: String(event?.id ?? ''),
    discordUserId: String(user?.id ?? ''),
  };
}

/** Turn the plain components of a reply into the rows the library sends. */
export function toComponents(reply: Reply): unknown[] {
  return (reply.components ?? []).map(row => ({
    type: ComponentType.ActionRow,
    components: row.components.map(component =>
      component.kind === 'select' ? selectJson(component) : buttonJson(component)),
  }));
}

const MODAL_FIELD_STYLES: Record<ModalFieldStyle, number> = {
  short: TextInputStyle.Short,
  paragraph: TextInputStyle.Paragraph,
};

/**
 * Turn a modal into the payload the library shows. Discord puts each box in a
 * row of its own, which is why the rows here are not something the caller has
 * to build.
 */
export function toModal(modal: ReplyModal): Record<string, unknown> {
  return {
    custom_id: modal.customId,
    title: modal.title,
    components: modal.fields.map(field => {
      const input: Record<string, unknown> = {
        type: ComponentType.TextInput,
        custom_id: field.customId,
        label: field.label,
        style: MODAL_FIELD_STYLES[field.style ?? 'short'],
        required: Boolean(field.required),
      };
      if (field.value) input.value = field.value;
      if (field.placeholder) input.placeholder = field.placeholder;
      if (field.maxLength !== undefined) input.max_length = field.maxLength;
      return { type: ComponentType.ActionRow, components: [input] };
    }),
  };
}

/** Turn the files of a reply into the attachments the library sends. */
export function toFiles(reply: Reply): { attachment: Buffer; name: string; contentType?: string }[] {
  return (reply.files ?? []).map(file => ({
    attachment: Buffer.from(file.content, 'utf8'),
    name: file.name,
    ...(file.contentType ? { contentType: file.contentType } : {}),
  }));
}

interface Updatable {
  deferred: boolean;
  replied: boolean;
  update: (options: Record<string, unknown>) => Promise<unknown>;
  editReply: (options: Record<string, unknown>) => Promise<unknown>;
}

interface Answerable {
  deferred: boolean;
  replied: boolean;
  deferReply: (options: { flags?: number }) => Promise<unknown>;
  reply: (options: Record<string, unknown>) => Promise<unknown>;
  editReply: (options: Record<string, unknown>) => Promise<unknown>;
  followUp: (options: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Say the answer, whichever of the three ways is the right one: a first reply
 * when nothing was acknowledged, an edit of the acknowledgement when one was,
 * and a follow up when something has already been said.
 */
export async function applyReply(raw: unknown, reply: Reply): Promise<void> {
  const target = raw as Answerable;
  const components = toComponents(reply);
  const files = toFiles(reply);

  if (target.deferred) {
    await target.editReply({
      content: reply.content,
      components,
      ...(files.length > 0 ? { files } : {}),
    });
    return;
  }

  const payload: Record<string, unknown> = { content: reply.content, components };
  if (files.length > 0) payload.files = files;
  if (reply.ephemeral) payload.flags = MessageFlags.Ephemeral;

  if (target.replied) {
    await target.followUp(payload);
    return;
  }
  await target.reply(payload);
}

/**
 * Answer a component by editing the message it sits on.
 *
 * A setup panel is one ephemeral message that changes as the manager works
 * through it. Replying to a menu would leave the old panel behind and add a
 * second one below it, so the panel is edited in place instead, which is what
 * Discord's update is for.
 */
export async function applyUpdate(raw: unknown, reply: Reply): Promise<void> {
  const target = raw as Updatable;
  const payload = { content: reply.content, components: toComponents(reply) };
  if (target.deferred || target.replied) {
    await target.editReply(payload);
    return;
  }
  await target.update(payload);
}

/**
 * Acknowledge first, then work, then edit the acknowledgement with the
 * answer. Whether the answer is only for the person who asked has to be
 * decided before the acknowledgement, because Discord fixes it there, so the
 * caller states it rather than the handler discovering it.
 */
export async function respond(
  raw: unknown,
  options: { ephemeral: boolean },
  produce: () => Promise<Reply>,
): Promise<void> {
  const target = raw as Answerable;
  await target.deferReply(options.ephemeral ? { flags: MessageFlags.Ephemeral } : {});

  let reply: Reply;
  try {
    reply = await produce();
  } catch (err) {
    console.error('interaction failed:', (err as Error).message);
    reply = { content: FAILURE_MESSAGE, ephemeral: options.ephemeral };
  }
  await applyReply(target, { ...reply, ephemeral: options.ephemeral });
}

interface Modalable {
  showModal: (payload: unknown) => Promise<unknown>;
}

/**
 * Open a form over the message.
 *
 * Discord takes a modal only as the first thing an application says about an
 * interaction, so nothing may have been acknowledged before this is called.
 * That is why a handler which answers with one is run before the deferral
 * rather than after it, and why the work behind such a handler is kept to the
 * one call it takes to fill the boxes in.
 */
export async function showModal(raw: unknown, modal: ReplyModal): Promise<void> {
  await (raw as Modalable).showModal(toModal(modal));
}

interface Acknowledgeable {
  deferred: boolean;
  replied: boolean;
  deferUpdate: () => Promise<unknown>;
  update: (options: Record<string, unknown>) => Promise<unknown>;
  editReply: (options: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Acknowledge a component, do the work, then edit the panel with the answer.
 *
 * This is respond() for the panels: the same three seconds apply, and the
 * same thinking state is better than a failed interaction. Nothing here takes
 * an ephemeral flag, because the message being edited already is what it is.
 */
export async function respondByUpdate(raw: unknown, produce: () => Promise<Reply>): Promise<void> {
  const target = raw as Acknowledgeable;
  await target.deferUpdate();

  let reply: Reply;
  try {
    reply = await produce();
  } catch (err) {
    console.error('panel failed:', (err as Error).message);
    reply = { content: FAILURE_MESSAGE };
  }
  await applyUpdate(target, reply);
}

interface Completable {
  respond: (choices: AutocompleteChoice[]) => Promise<unknown>;
}

/**
 * Answer an autocomplete with the completions Discord will show.
 *
 * Discord takes at most twenty five, and refuses the whole answer over a name
 * longer than a hundred characters, so both are enforced here rather than in
 * every command that completes something. An autocomplete arrives on every
 * keystroke and expires in three seconds, so one that arrives too late is
 * dropped quietly: there is no person waiting on a sentence, and throwing
 * would only fill the log with a race nobody can win.
 */
export async function answerAutocomplete(raw: unknown, choices: AutocompleteChoice[]): Promise<void> {
  const trimmed = choices.slice(0, MAX_AUTOCOMPLETE_CHOICES).map(choice => ({
    name: choice.name.length > MAX_AUTOCOMPLETE_NAME
      ? choice.name.slice(0, MAX_AUTOCOMPLETE_NAME)
      : choice.name,
    value: choice.value,
  }));
  try {
    await (raw as Completable).respond(trimmed);
  } catch (err) {
    console.error('answering an autocomplete failed:', (err as Error).message);
  }
}

/**
 * The actions the bot takes on its own.
 *
 * Everything proactive reaches Discord through this wrapper: an announcement
 * posted into a channel, an edit of it when the event changes, a notice that
 * replies to it, a pin, and the server's own scheduled events. It sits here
 * with the rest of the adapter because it is the same seam, and because it is
 * the only other place that has to know what discord.js calls things.
 *
 * It is thin deliberately. It builds no content and decides nothing: it takes
 * a Reply, which every renderer already produces, and turns it into the call
 * the library wants. That is what lets the announcement handlers and the
 * scheduled event mirror be tested against an object that records what it was
 * asked to do, with no gateway anywhere.
 *
 * Nothing here catches a failure. A post that fails is an outbox entry that
 * has not been handled, and the consumer decides what to do about it.
 */

/**
 * A Discord scheduled event as the bot creates them. Every VIA event is of
 * the external kind, because it happens somewhere Discord has no channel for,
 * and the external kind carries the place as a line of text and requires an
 * end time, which VIA always has.
 */
export interface ScheduledEventDraft {
  name: string;
  description?: string;
  /** A time carrying the campus offset, as the web platform sends them. */
  startTime: string;
  endTime: string;
  /** Where the event is, in the words the card shows. */
  location: string;
}

/** Where a message goes and what it answers, when it answers something. */
export interface PostOptions {
  /** The message this one replies to, which is how a notice sits under its announcement. */
  replyToMessageId?: string;
}

/**
 * A poll, as Discord's own control takes it. The duration is in hours,
 * because that is what Discord counts in, and the content is the message the
 * poll sits under, which says what the poll is for.
 */
export interface PollDraft {
  content: string;
  /** The question itself, at most three hundred characters. */
  question: string;
  /** The answers, at most ten of them, each at most fifty five characters. */
  answers: string[];
  durationHours: number;
  allowMultiselect?: boolean;
}

/** One answer of a poll and how many people chose it. */
export interface PollAnswerResult {
  text: string;
  votes: number;
}

/**
 * A poll as it now stands. Discord finalizes the counts shortly after a poll
 * closes, and until it has, the counts are the ones seen so far.
 */
export interface PollResults {
  finalized: boolean;
  answers: PollAnswerResult[];
}

export interface DiscordActions {
  /** Post a message and answer with the identifier it left behind. */
  postMessage(channelId: string, reply: Reply, options?: PostOptions): Promise<string>;
  editMessage(channelId: string, messageId: string, reply: Reply): Promise<void>;
  pinMessage(channelId: string, messageId: string): Promise<void>;
  unpinMessage(channelId: string, messageId: string): Promise<void>;
  createScheduledEvent(guildId: string, draft: ScheduledEventDraft): Promise<string>;
  editScheduledEvent(guildId: string, scheduledEventId: string, draft: ScheduledEventDraft): Promise<void>;
  deleteScheduledEvent(guildId: string, scheduledEventId: string): Promise<void>;
  /** Post a message carrying one of Discord's own polls, and answer with its identifier. */
  postPoll(channelId: string, poll: PollDraft): Promise<string>;
  /**
   * The poll on a message as it now stands, or null when the message carries
   * none. The scheduler reads this when a poll's time is up, because Discord
   * sends no event of its own to say that a poll has closed.
   */
  readPoll(channelId: string, messageId: string): Promise<PollResults | null>;
  /**
   * Give somebody a role, answering whether it was given. Somebody who has
   * left the server is not a failure to put right, so that answers false
   * rather than throwing.
   */
  addRole(guildId: string, discordUserId: string, roleId: string): Promise<boolean>;
  /** Take a role away again, answering whether it was taken. */
  removeRole(guildId: string, discordUserId: string, roleId: string): Promise<boolean>;
  /** Which permissions the bot itself holds in a server, named as the registry names them. */
  permissionsIn(guildId: string): Promise<DiscordPermission[]>;
}

/**
 * Discord's codes for a channel that is gone and for permissions the bot does
 * not have. All three mean the same thing to a proactive feature: the place it
 * was told to post in is no longer a place it can post in, which is the
 * server's to fix and the manager's to be told about.
 */
const MISSING_ACCESS_CODES = new Set([10003, 50001, 50013]);

export function isMissingAccess(err: unknown): boolean {
  const code = (err as { code?: number } | null)?.code;
  return typeof code === 'number' && MISSING_ACCESS_CODES.has(code);
}

/** Discord's code for a message that is no longer there, such as one somebody deleted. */
const UNKNOWN_MESSAGE = 10008;

/** Discord's code for somebody who is not a member of the server any more. */
const UNKNOWN_MEMBER = 10007;

/**
 * Whether the person a role call named has left the server. Nobody has to put
 * that right: a person who has left holds no roles to give or to take.
 */
export function isMissingMember(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === UNKNOWN_MEMBER;
}

/**
 * Whether the message a call named is gone. An announcement somebody deleted
 * is nothing to keep current, and nothing for anybody to put right, so it is
 * told apart from a channel the bot can no longer reach.
 */
export function isMissingMessage(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === UNKNOWN_MESSAGE;
}

interface Postable {
  send: (payload: Record<string, unknown>) => Promise<{ id: string }>;
  messages: { fetch: (messageId: string) => Promise<PostedMessage> };
}

interface PostedMessage {
  id: string;
  edit: (payload: Record<string, unknown>) => Promise<unknown>;
  pin: () => Promise<unknown>;
  unpin: () => Promise<unknown>;
  /** The poll the message carries, for a message the bot posted one on. */
  poll?: {
    resultsFinalized?: boolean;
    answers?: Map<number, { text?: string; voteCount?: number }>;
  } | null;
}

/** A member, as the library answers one, with the two role calls on it. */
interface GuildMember {
  roles: {
    add: (roleId: string) => Promise<unknown>;
    remove: (roleId: string) => Promise<unknown>;
  };
}

export function createDiscordActions(client: Client): DiscordActions {
  async function channel(channelId: string): Promise<Postable> {
    const found = await client.channels.fetch(channelId);
    if (!found) throw new Error(`Discord has no channel with the identifier ${channelId}.`);
    return found as unknown as Postable;
  }

  async function message(channelId: string, messageId: string): Promise<PostedMessage> {
    return (await channel(channelId)).messages.fetch(messageId);
  }

  async function guild(guildId: string) {
    const found = await client.guilds.fetch(guildId);
    if (!found) throw new Error(`Discord has no server with the identifier ${guildId}.`);
    return found as unknown as {
      members: {
        me: { permissions: unknown } | null;
        fetch: (memberId: string) => Promise<GuildMember>;
      };
      scheduledEvents: {
        create: (payload: Record<string, unknown>) => Promise<{ id: string }>;
        edit: (id: string, payload: Record<string, unknown>) => Promise<unknown>;
        delete: (id: string) => Promise<unknown>;
      };
    };
  }

  /** What a scheduled event is, in the words the library takes. */
  function scheduledEventPayload(draft: ScheduledEventDraft): Record<string, unknown> {
    return {
      name: draft.name,
      ...(draft.description ? { description: draft.description } : {}),
      scheduledStartTime: draft.startTime,
      scheduledEndTime: draft.endTime,
      privacyLevel: GuildScheduledEventPrivacyLevel.GuildOnly,
      entityType: GuildScheduledEventEntityType.External,
      entityMetadata: { location: draft.location },
    };
  }

  return {
    async postMessage(channelId, reply, options = {}) {
      const payload: Record<string, unknown> = {
        content: reply.content,
        components: toComponents(reply),
      };
      const files = toFiles(reply);
      if (files.length > 0) payload.files = files;
      if (options.replyToMessageId) {
        // A notice that replies to an announcement somebody deleted is still
        // worth posting, so the reply does not fail with the reference.
        payload.reply = { messageReference: options.replyToMessageId, failIfNotExists: false };
      }
      const posted = await (await channel(channelId)).send(payload);
      return String(posted.id);
    },

    async editMessage(channelId, messageId, reply) {
      await (await message(channelId, messageId)).edit({
        content: reply.content,
        components: toComponents(reply),
      });
    },

    async pinMessage(channelId, messageId) {
      await (await message(channelId, messageId)).pin();
    },

    async unpinMessage(channelId, messageId) {
      await (await message(channelId, messageId)).unpin();
    },

    async createScheduledEvent(guildId, draft) {
      const created = await (await guild(guildId)).scheduledEvents.create(scheduledEventPayload(draft));
      return String(created.id);
    },

    async editScheduledEvent(guildId, scheduledEventId, draft) {
      await (await guild(guildId)).scheduledEvents.edit(scheduledEventId, scheduledEventPayload(draft));
    },

    async deleteScheduledEvent(guildId, scheduledEventId) {
      await (await guild(guildId)).scheduledEvents.delete(scheduledEventId);
    },

    async postPoll(channelId, poll) {
      const posted = await (await channel(channelId)).send({
        content: poll.content,
        poll: {
          question: { text: poll.question },
          answers: poll.answers.map(text => ({ text })),
          duration: poll.durationHours,
          allowMultiselect: Boolean(poll.allowMultiselect),
        },
      });
      return String(posted.id);
    },

    async readPoll(channelId, messageId) {
      const held = (await message(channelId, messageId)).poll;
      if (!held) return null;
      return {
        finalized: Boolean(held.resultsFinalized),
        answers: [...(held.answers?.values() ?? [])].map(answer => ({
          text: String(answer.text ?? ''),
          votes: Number(answer.voteCount ?? 0),
        })),
      };
    },

    /**
     * The two role calls. A person who has left the server is answered with
     * false rather than an error, because there is nothing there to put right
     * and a reconciliation that threw on one departed member would stop for
     * everybody behind them.
     */
    async addRole(guildId, discordUserId, roleId) {
      let member: GuildMember;
      try {
        member = await (await guild(guildId)).members.fetch(discordUserId);
      } catch (err) {
        if (isMissingMember(err)) return false;
        throw err;
      }
      await member.roles.add(roleId);
      return true;
    },

    async removeRole(guildId, discordUserId, roleId) {
      let member: GuildMember;
      try {
        member = await (await guild(guildId)).members.fetch(discordUserId);
      } catch (err) {
        if (isMissingMember(err)) return false;
        throw err;
      }
      await member.roles.remove(roleId);
      return true;
    },

    async permissionsIn(guildId) {
      const me = (await guild(guildId)).members.me;
      return me ? readPermissions(me.permissions) : [];
    },
  };
}
