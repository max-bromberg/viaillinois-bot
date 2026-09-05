import { featureById } from '../features/registry.ts';
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
 * The outbox consumer, which is how the bot will eventually learn that a link
 * was made, is not built yet, so this increment watches for the link itself.
 * It asks the web platform every few seconds for a minute after handing out
 * the address, and confirms in one direct message when the link resolves. If
 * the person takes longer than that, or never finishes, the bot says nothing
 * more: the web platform's own page has already confirmed it to them, and a
 * message an hour later would be worse than none.
 */

/** How long the bot leaves between one lookup and the next. */
export const LINK_POLL_INTERVAL_MS = 3_000;

/** How long the bot watches for the link before it stops. */
export const LINK_POLL_WINDOW_MS = 60_000;

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
 * Watch for the link and confirm it once. A failure here is not the person's
 * to hear about: they have the address, and the web platform confirms on the
 * page, so a lookup that fails is logged and the watch carries on.
 */
export async function awaitLink(discordUserId: string, context: CommandContext): Promise<void> {
  const startedAt = context.now().getTime();

  while (context.now().getTime() - startedAt < LINK_POLL_WINDOW_MS) {
    await context.sleep(LINK_POLL_INTERVAL_MS);
    let link;
    try {
      link = await context.via.getLink(discordUserId);
    } catch (err) {
      console.error('waiting for a link failed:', (err as Error).message);
      return;
    }
    if (!link) continue;

    await context.sendDirectMessage(
      discordUserId,
      `This Discord account is now linked to your VIA account, ${link.displayName}. `
      + 'You can follow organizations, set reminders and receive updates here. '
      + 'Run the unlink command at any time to undo this.',
    );
    return;
  }
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

    context.schedule(() => awaitLink(interaction.userId, context));

    return {
      content:
        `Open ${session.address} to finish linking this Discord account to your VIA account. `
        + 'You will sign in with your NetID and then approve the bot on Discord. '
        + 'The address works once and expires in ten minutes.',
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
