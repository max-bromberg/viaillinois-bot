import {
  ChannelType, ComponentType, InteractionContextType, InteractionType, MessageFlags,
  PermissionFlagsBits,
} from 'discord.js';
import type { DiscordPermission, InteractionContext } from '../features/registry.ts';

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

/** Whether a menu picks from a list the bot wrote or from the server's channels. */
export type SelectKind = 'string' | 'channel';

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

function selectJson(select: ReplySelect): Record<string, unknown> {
  const built: Record<string, unknown> = {
    type: select.selectKind === 'channel' ? ComponentType.ChannelSelect : ComponentType.StringSelect,
    custom_id: select.customId,
    min_values: select.minValues ?? 1,
    max_values: select.maxValues ?? 1,
  };
  if (select.placeholder) built.placeholder = select.placeholder;
  if (select.disabled) built.disabled = true;
  if (select.selectKind === 'channel') {
    built.channel_types = [...POSTABLE_CHANNEL_TYPES];
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

/** Turn the plain components of a reply into the rows the library sends. */
export function toComponents(reply: Reply): unknown[] {
  return (reply.components ?? []).map(row => ({
    type: ComponentType.ActionRow,
    components: row.components.map(component =>
      component.kind === 'select' ? selectJson(component) : buttonJson(component)),
  }));
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
