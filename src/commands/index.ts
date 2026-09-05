import { featureById } from '../features/registry.ts';
import { applyReply, respond, toInteraction, type Interaction } from '../discord/adapter.ts';
import { guildSubject, userSubject, type RateTier } from '../ratelimit/windows.ts';
import { describeWait, type CommandContext, type CommandHandler } from './types.ts';
import { linkCommand } from './link.ts';
import { unlinkCommand } from './unlink.ts';

export { describeWait } from './types.ts';
export type { CommandContext, CommandHandler } from './types.ts';
export { linkCommand } from './link.ts';
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
 * Only chat commands reach a handler in this increment. Buttons, select
 * menus and modals arrive from the components that later increments post, so
 * an interaction of one of those kinds is left alone here rather than
 * answered with a sentence about a component nothing has posted yet.
 */

/** Every command the bot answers, keyed by the name the adapter reports. */
export const handlers: readonly CommandHandler[] = [linkCommand, unlinkCommand];

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
export function tierOf(handler: CommandHandler): RateTier {
  return featureById(handler.featureId).tier === 'read' ? 'unlinked' : 'linked';
}

export function createDispatcher(context: CommandContext): (raw: unknown) => Promise<void> {
  const byName = new Map(handlers.map(handler => [handler.name, handler]));

  return async function dispatch(raw: unknown): Promise<void> {
    const interaction: Interaction = toInteraction(raw);
    if (interaction.kind !== 'chatCommand') return;

    const handler = interaction.commandName ? byName.get(interaction.commandName) : undefined;
    if (!handler) {
      await applyReply(raw, { content: UNKNOWN_COMMAND_MESSAGE, ephemeral: true });
      return;
    }

    const person = await context.rateWindows.consume(userSubject(interaction.userId), tierOf(handler));
    if (!person.allowed) {
      await applyReply(raw, {
        content: `${USER_LIMIT_MESSAGE} Please try again ${describeWait(person.retryAfterSeconds)}.`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.guildId) {
      // A command the server ceiling refuses has still been sent by the
      // person, so it stays counted against them.
      const server = await context.rateWindows.consume(guildSubject(interaction.guildId), 'guild');
      if (!server.allowed) {
        await applyReply(raw, {
          content: `${GUILD_LIMIT_MESSAGE} Please try again ${describeWait(server.retryAfterSeconds)}.`,
          ephemeral: true,
        });
        return;
      }
    }

    await respond(raw, { ephemeral: handler.ephemeral }, () => handler.run(interaction, context));
  };
}
