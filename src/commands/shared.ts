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

export const NOT_LINKED_TO_ACT_MESSAGE =
  'This needs a VIA account, because VIA decides who may act for an organization. Please link this Discord account and then try again.';

/**
 * What somebody reads when the web platform does not list them as an editor
 * of the organization whose event they tried to change. It says whose decision
 * it was and what to do about it, because the person did nothing wrong and can
 * act on what they are told.
 */
export function notAnEditorMessage(rsoName: string | null): string {
  const organization = rsoName ?? 'that organization';
  return `VIA does not list this account as an editor of ${organization}, so nothing has been changed. Ask somebody on the board of ${organization} to make you an editor on viaillinois.com.`;
}

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

/**
 * Doing something on VIA as the person who asked for it.
 *
 * Every administrative action, and the scheduler, calls the web platform with
 * the acting Discord account and reads whatever comes back. Four answers are
 * refusals a person can act on and each of them is one sentence: no VIA
 * account, which is a link button rather than an instruction to go and find a
 * command; an account the web platform does not list as an editor of that
 * organization; a clash, which is named as the web platform named it; and a
 * busy web platform, which names the wait. Anything else is the web platform
 * not answering, which is the same sentence everywhere else in the bot.
 *
 * It is written once here so that six actions and three scheduler steps say
 * the same thing rather than nine things that nearly match, and so that the
 * bot decides none of it: what comes back is what the web platform decided.
 */
export type ViaActionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reply: Reply };

export interface ViaActionOptions {
  /** The organization the action was about, named in the refusal when it is known. */
  rsoName?: string | null;
}

export async function actOnVia<T>(
  run: () => Promise<T>,
  options: ViaActionOptions = {},
): Promise<ViaActionOutcome<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (err) {
    if (err instanceof ViaBusyError) {
      return {
        ok: false,
        reply: { content: `VIA is busy right now. Please try again ${describeWait(err.retryAfterSeconds)}.` },
      };
    }
    if (err instanceof ViaError) {
      if (err.code === 'not_linked') {
        return { ok: false, reply: { content: NOT_LINKED_TO_ACT_MESSAGE, components: LINK_BUTTON } };
      }
      if (err.code === 'forbidden') {
        return { ok: false, reply: { content: notAnEditorMessage(options.rsoName ?? null) } };
      }
      if (err.code === 'conflict') {
        return { ok: false, reply: { content: `${err.message} Nothing has been changed.` } };
      }
      // A value the web platform will not take is answered with the sentence
      // the web platform wrote about it, because it names the field.
      if (err.code === 'invalid') {
        return { ok: false, reply: { content: `${err.message} Nothing has been changed.` } };
      }
      if (err.code === 'not_found') {
        return { ok: false, reply: { content: NOTHING_TO_ACT_ON_MESSAGE } };
      }
      return { ok: false, reply: { content: UNREACHABLE_MESSAGE } };
    }
    throw err;
  }
}

export const NOTHING_TO_ACT_ON_MESSAGE =
  'VIA does not have that event any more, so there is nothing to change. It was probably deleted after this message was posted.';
