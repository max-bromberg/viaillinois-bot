import { ViaBusyError, ViaError } from '../via/client.ts';
import { describeWait, type CommandContext } from './types.ts';
import type { Interaction, Reply, ReplyRow } from '../discord/adapter.ts';

/**
 * The answers more than one command has to give.
 *
 * Three things come up wherever a person reaches VIA through the bot: an
 * option that was typed rather than chosen from the list Discord offers, a web
 * platform that refused or did not answer, and a person who has no VIA account
 * and needs one for what they just pressed. Each of them is one sentence, and
 * each of them is written once here so that the events commands and the feed
 * commands say the same thing rather than two things that nearly match.
 */

export const NOT_AN_RSO_MESSAGE =
  'Please choose an organization from the list Discord offers as you type, rather than typing a name of your own.';

export const NO_SUCH_RSO_MESSAGE =
  'VIA does not have an organization by that name. It may have been removed since Discord last completed it.';

export const UNREACHABLE_MESSAGE =
  'VIA is not answering right now, so there is nothing to show. Please try again in a few minutes.';

export const LINK_NEEDED_MESSAGE =
  'This needs a VIA account, so please link this Discord account first and then try again.';

/** The button that sends somebody who is not linked to the link command. */
export const LINK_BUTTON: ReplyRow[] = [{
  kind: 'row',
  components: [{ kind: 'button', style: 'primary', label: 'Link my account', customId: 'identity:link' }],
}];

/** Turn whatever went wrong into the sentence the person reads. */
export function answerFor(err: unknown): Reply {
  if (err instanceof ViaBusyError) {
    return { content: `VIA is busy right now. Please try again ${describeWait(err.retryAfterSeconds)}.` };
  }
  if (err instanceof ViaError) return { content: UNREACHABLE_MESSAGE };
  throw err;
}

/** A whole number an option or an identifier carries, or null when it is anything else. */
export function identifier(value: unknown): number | null {
  const text = String(value ?? '').trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * Whether the person has a VIA account, and the answer if they do not. A
 * refusal here is a button rather than a sentence about a command they would
 * have to go and find.
 */
export async function requireLink(
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply | null> {
  let link;
  try {
    link = await context.via.getLink(interaction.userId);
  } catch (err) {
    return answerFor(err);
  }
  if (link) return null;
  return { content: LINK_NEEDED_MESSAGE, components: LINK_BUTTON };
}
