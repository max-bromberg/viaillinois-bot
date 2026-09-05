import { featureById } from '../features/registry.ts';
import {
  answerAutocomplete, applyReply, respond, respondByUpdate, toInteraction, type Interaction,
} from '../discord/adapter.ts';
import { guildSubject, userSubject, type RateTier } from '../ratelimit/windows.ts';
import { describeWait, type CommandContext, type CommandHandler, type ComponentHandler } from './types.ts';
import { linkCommand, linkComponent } from './link.ts';
import { unlinkCommand } from './unlink.ts';
import {
  eventsCommand, eventCommand, rsoCommand, eventsComponent, eventComponent, rsoComponent,
} from './events.ts';
import { setupCommand, configCommand, removeCommand, setupComponent } from './setup.ts';
import {
  followCommand, unfollowCommand, followingCommand, calendarCommand,
  feedSettingsCommand, feedRemindersCommand, feedComponent,
} from './feed.ts';

export { describeWait } from './types.ts';
export type { CommandContext, CommandHandler, ComponentHandler } from './types.ts';
export { linkCommand, linkComponent } from './link.ts';
export { unlinkCommand, deleteLocalData } from './unlink.ts';

/**
 * The dispatcher.
 *
 * One interaction arrives, one command runs. Before it runs, the command is
 * counted against the person and against the server, and a refusal is a
 * sentence naming the wait rather than silence. A command that is refused is
 * answered straight away rather than acknowledged first, because there is no
 * work to wait for and a thinking state that resolves into a refusal reads
 * worse than a refusal.
 *
 * Three kinds of interaction reach a handler. A chat command runs the command
 * of that name. An autocomplete runs the completions of the command being
 * typed, and is answered with a list rather than a message. A button or a menu
 * runs the component handler whose prefix its identifier begins with, which is
 * how the buttons on a card and the panels of setup are answered by the module
 * that posted them. Anything else is left alone rather than answered with a
 * sentence about something nothing has posted.
 */

/** Every command the bot answers, keyed by the name the adapter reports. */
export const handlers: readonly CommandHandler[] = [
  linkCommand,
  unlinkCommand,
  eventsCommand,
  eventCommand,
  rsoCommand,
  setupCommand,
  configCommand,
  removeCommand,
  followCommand,
  unfollowCommand,
  followingCommand,
  feedSettingsCommand,
  feedRemindersCommand,
  calendarCommand,
];

/**
 * Every component the bot answers. The first handler whose prefix the
 * identifier begins with answers it, so the order here matters only if two
 * prefixes overlap, and no two of them do.
 */
export const componentHandlers: readonly ComponentHandler[] = [
  linkComponent,
  eventsComponent,
  eventComponent,
  rsoComponent,
  setupComponent,
  feedComponent,
];

export const UNKNOWN_COMMAND_MESSAGE =
  'This bot does not answer that command. The command list may have changed since Discord last refreshed it, so please try again in a few minutes.';

export const USER_LIMIT_MESSAGE = 'You have run too many VIA commands in the last hour.';
export const GUILD_LIMIT_MESSAGE = 'This server has run too many VIA commands in the last hour.';

/**
 * Which limit a command is counted against. A command anybody may run is
 * counted against the tighter limit, and a command only a linked person may
 * run against the wider one, because a linked person is accountable through a
 * NetID. This follows the tier the registry declares rather than a lookup of
 * whether the person is linked, so that no command costs a call to the web
 * platform before it has decided to make one.
 */
export function tierOf(handler: CommandHandler | ComponentHandler): RateTier {
  return featureById(handler.featureId).tier === 'read' ? 'unlinked' : 'linked';
}

export function createDispatcher(context: CommandContext): (raw: unknown) => Promise<void> {
  const byName = new Map(handlers.map(handler => [handler.name, handler]));

  /**
   * Count the interaction against the person and against the server, and
   * answer with the sentence naming the wait when either refuses. A refusal is
   * answered straight away rather than acknowledged first, because there is no
   * work to wait for and a thinking state that resolves into a refusal reads
   * worse than a refusal.
   */
  async function withinLimits(interaction: Interaction, tier: RateTier, raw: unknown): Promise<boolean> {
    const person = await context.rateWindows.consume(userSubject(interaction.userId), tier);
    if (!person.allowed) {
      await applyReply(raw, {
        content: `${USER_LIMIT_MESSAGE} Please try again ${describeWait(person.retryAfterSeconds)}.`,
        ephemeral: true,
      });
      return false;
    }

    if (interaction.guildId) {
      // Something the server ceiling refuses has still been sent by the
      // person, so it stays counted against them.
      const server = await context.rateWindows.consume(guildSubject(interaction.guildId), 'guild');
      if (!server.allowed) {
        await applyReply(raw, {
          content: `${GUILD_LIMIT_MESSAGE} Please try again ${describeWait(server.retryAfterSeconds)}.`,
          ephemeral: true,
        });
        return false;
      }
    }
    return true;
  }

  /**
   * An autocomplete fires on every keystroke and expires in three seconds, so
   * it is not counted against anybody: counting it would refuse a person for
   * typing a name. What makes that affordable is that the reads behind it are
   * the cached ones. A failure answers with no completions rather than
   * throwing, because there is nobody waiting on a sentence.
   */
  async function complete(interaction: Interaction, raw: unknown): Promise<void> {
    const handler = interaction.commandName ? byName.get(interaction.commandName) : undefined;
    if (!handler?.autocomplete) {
      await answerAutocomplete(raw, []);
      return;
    }
    try {
      await answerAutocomplete(raw, await handler.autocomplete(interaction, context));
    } catch (err) {
      console.error('completing an option failed:', (err as Error).message);
      await answerAutocomplete(raw, []);
    }
  }

  return async function dispatch(raw: unknown): Promise<void> {
    const interaction: Interaction = toInteraction(raw);

    if (interaction.kind === 'autocomplete') {
      await complete(interaction, raw);
      return;
    }

    if (interaction.kind === 'button' || interaction.kind === 'select') {
      const customId = interaction.customId ?? '';
      const handler = componentHandlers.find(one => customId.startsWith(one.prefix));
      // A component nothing answers is left alone. It was posted by a version
      // of the bot that is no longer running, and a sentence about a button
      // that no longer exists helps nobody.
      if (!handler) return;

      if (!(await withinLimits(interaction, tierOf(handler), raw))) return;

      if (handler.updateInPlace) {
        await respondByUpdate(raw, () => handler.run(interaction, context));
        return;
      }
      await respond(raw, { ephemeral: handler.ephemeral !== false }, () => handler.run(interaction, context));
      return;
    }

    if (interaction.kind !== 'chatCommand') return;

    const handler = interaction.commandName ? byName.get(interaction.commandName) : undefined;
    if (!handler) {
      await applyReply(raw, { content: UNKNOWN_COMMAND_MESSAGE, ephemeral: true });
      return;
    }

    if (!(await withinLimits(interaction, tierOf(handler), raw))) return;

    await respond(raw, { ephemeral: handler.ephemeral }, () => handler.run(interaction, context));
  };
}
