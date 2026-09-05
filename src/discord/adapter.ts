import { ComponentType, InteractionContextType, InteractionType, MessageFlags } from 'discord.js';
import type { InteractionContext } from '../features/registry.ts';

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
}

export type ButtonStyle = 'primary' | 'secondary' | 'success' | 'danger' | 'link';

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

export interface ReplyRow {
  kind: 'row';
  components: ReplyButton[];
}

export interface Reply {
  content: string;
  /** Whether only the person who asked sees the answer. */
  ephemeral?: boolean;
  components?: ReplyRow[];
}

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
  };
}

/** Turn the plain components of a reply into the rows the library sends. */
export function toComponents(reply: Reply): unknown[] {
  return (reply.components ?? []).map(row => ({
    type: ComponentType.ActionRow,
    components: row.components.map(button => {
      const built: Record<string, unknown> = {
        type: ComponentType.Button,
        style: BUTTON_STYLES[button.style],
        label: button.label,
      };
      if (button.url) built.url = button.url;
      if (button.customId) built.custom_id = button.customId;
      if (button.disabled) built.disabled = true;
      return built;
    }),
  }));
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

  if (target.deferred) {
    await target.editReply({ content: reply.content, components });
    return;
  }

  const payload: Record<string, unknown> = { content: reply.content, components };
  if (reply.ephemeral) payload.flags = MessageFlags.Ephemeral;

  if (target.replied) {
    await target.followUp(payload);
    return;
  }
  await target.reply(payload);
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
