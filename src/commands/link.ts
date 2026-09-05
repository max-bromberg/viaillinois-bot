import { featureById } from '../features/registry.ts';
import { campusTimeOfDay, relativeTimestamp } from '../render/campusTime.ts';
import { linkedRolesAdvice } from '../roles/linked.ts';
import { ViaBusyError, ViaError } from '../via/client.ts';
import { describeWait, type CommandContext, type CommandHandler, type ComponentHandler } from './types.ts';
import type { Interaction, Reply } from '../discord/adapter.ts';

/**
 * The link command.
 *
 * The bot asks the web platform to open a link session and hands the person a
 * single use address on viaillinois.com. Everything that decides whether the
 * link is made happens there: the NetID sign in the web platform already
 * does, and Discord's own consent screen, which is what proves the person
 * controls the Discord account.
 *
 * The command opens the session, hands out the address and is finished. How
 * the bot learns that the link was made is the outbox: the web platform writes
 * a link.completed entry, and the handler in src/identity/links.ts confirms it
 * to the person in a direct message. That is section 4 of the design, and it
 * is why nothing here waits for anything: a person who signs in ten minutes
 * later is confirmed then rather than not at all.
 */

const feature = featureById('identity.link');

/** What the person is told when the web platform cannot be reached at all. */
export const UNREACHABLE_MESSAGE =
  'VIA is not answering right now, so linking cannot be started. Please try again in a few minutes.';

function answerFor(err: unknown): Reply {
  if (err instanceof ViaBusyError) {
    return { content: `VIA is busy right now. Please try again ${describeWait(err.retryAfterSeconds)}.` };
  }
  if (err instanceof ViaError) return { content: UNREACHABLE_MESSAGE };
  throw err;
}

/**
 * When the address stops working, as the web platform said it would. It is
 * read from the session rather than written here, so a change to the web
 * platform's own expiry is a change to what a person is told, and it is shown
 * as the campus clock with Discord's relative timestamp beside it, as every
 * other time in the bot is.
 */
export function describeExpiry(expiresAt: string): string {
  const clock = campusTimeOfDay(expiresAt);
  if (!clock) return 'The address works once, and it expires shortly.';
  return `The address works once, and it expires at ${clock} ${relativeTimestamp(expiresAt)}.`;
}

export const linkCommand: CommandHandler = {
  featureId: feature.id,
  name: feature.command!.name,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    let session;
    try {
      session = await context.via.openLinkSession(interaction.userId);
    } catch (err) {
      return answerFor(err);
    }

    return {
      content:
        `Open ${session.address} to finish linking this Discord account to your VIA account. `
        + 'You will sign in with your NetID and then approve the bot on Discord. '
        + `${describeExpiry(session.expiresAt)}\n\n`
        + linkedRolesAdvice(),
      components: [{
        kind: 'row',
        components: [{
          kind: 'button',
          style: 'link',
          label: 'Sign in on viaillinois.com',
          url: session.address,
        }],
      }],
    };
  },
};

/**
 * The link button.
 *
 * Several answers end in a person who has no VIA account being offered a Link
 * button: the reminder and interest buttons on an event card, the follow
 * button on an organization card, and the refusal a manager reads when binding
 * a server needs an account they do not have. The button does exactly what the
 * command does, because a button that told somebody to go and type a command
 * instead would be a button that does nothing.
 */
export const linkComponent: ComponentHandler = {
  featureId: feature.id,
  prefix: 'identity:link',
  ephemeral: true,
  run: (interaction: Interaction, context: CommandContext) => linkCommand.run(interaction, context),
};
