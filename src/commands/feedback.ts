import { featureById } from '../features/registry.ts';
import {
  commentModal, renderRatingRecorded, COMMENT_FIELD, COMMENT_RECORDED_MESSAGE, FEEDBACK_BUTTON,
  FEEDBACK_STOPPED_MESSAGE, MAX_COMMENT_LENGTH, RATINGS,
} from '../render/feedback.ts';
import { actOnVia, identifier } from './shared.ts';
import type { CommandContext, ComponentHandler } from './types.ts';
import type { Interaction, Reply } from '../discord/adapter.ts';

/**
 * What the buttons on a feedback request do.
 *
 * The message is a direct message the bot sent the morning after an event, so
 * everything here answers a person about their own answer and nobody else's.
 * A score is recorded the moment it is pressed, and the message is edited in
 * place to say so, because a person who has answered should not be left
 * looking at the question. The comment is offered afterwards and recorded with
 * the score they already gave, which is why the score travels in the identifier
 * of the comment button rather than being remembered anywhere.
 *
 * The off switch is on the message itself, as section 6.4 requires. It flips
 * the same preference the feed settings panel flips, so a person who pressed
 * it once can turn feedback messages back on there if they change their mind.
 *
 * Nothing here decides who may answer. The web platform records the answer
 * against the NetID the acting header resolves to, and refuses an account it
 * no longer knows, which the person reads as an offer to link again.
 */

const feature = featureById('feedback.request');

/** What somebody reads when a button names something this handler cannot answer. */
export const UNKNOWN_ANSWER_MESSAGE =
  'This button is from a version of VIA that is no longer running, so nothing has been recorded.';

/** The identifiers a feedback button carries: the event, and the score where there is one. */
export function answerOf(customId: string): { eventId: number; rating: number | null } | null {
  const parts = customId.split(':');
  if (parts[0] !== 'feedback') return null;
  const eventId = identifier(parts[2]);
  if (eventId === null) return null;
  const rating = parts.length > 3 ? identifier(parts[3]) : null;
  return { eventId, rating };
}

/** Whether a score is one of the five the message offered. */
function isRating(rating: number | null): rating is number {
  return rating !== null && (RATINGS as readonly number[]).includes(rating);
}

/**
 * The comment, as it arrived. An empty box is a person who opened the form and
 * changed their mind, which is recorded as no comment rather than as an empty
 * one, and a comment longer than the web platform accepts is cut here so that
 * the answer is recorded rather than refused.
 */
function commentOf(fields: Record<string, string>): string | undefined {
  const typed = (fields[COMMENT_FIELD] ?? '').trim();
  return typed ? typed.slice(0, MAX_COMMENT_LENGTH) : undefined;
}

/**
 * The comment, which is the one part of this that opens a form. It is a
 * handler of its own, and its prefix comes first in the dispatcher's list,
 * because Discord takes a form only as the first thing an application says
 * about an interaction and everything else here answers by editing the
 * message it sits on.
 */
export const feedbackCommentComponent: ComponentHandler = {
  featureId: feature.id,
  prefix: 'feedback:comment:',
  ephemeral: true,
  opensModal: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const answer = answerOf(interaction.customId ?? '');
    if (!answer || !isRating(answer.rating)) return { content: UNKNOWN_ANSWER_MESSAGE };
    const { eventId, rating } = answer;

    // The button of the same name opens the form, and the form comes back as
    // an interaction of its own carrying what was typed, which is how the two
    // are told apart.
    if (interaction.kind !== 'modal') {
      return { content: '', modal: commentModal(eventId, rating) };
    }

    const comment = commentOf(interaction.fields);
    const recorded = await actOnVia(() => context.via.recordFeedback(
      eventId,
      comment === undefined ? { rating } : { rating, comment },
      interaction.userId,
    ));
    if (!recorded.ok) return recorded.reply;

    return { content: COMMENT_RECORDED_MESSAGE };
  },
};

/** The five scores and the off switch, which edit the message they sit on. */
export const feedbackComponent: ComponentHandler = {
  featureId: feature.id,
  prefix: 'feedback:',
  updateInPlace: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const customId = interaction.customId ?? '';
    const answer = answerOf(customId);
    if (!answer) return { content: UNKNOWN_ANSWER_MESSAGE, components: [] };
    const { eventId, rating } = answer;

    if (customId === FEEDBACK_BUTTON.stop(eventId)) {
      await context.feed.savePreferences(interaction.userId, { feedbackOptOut: true });
      return { content: FEEDBACK_STOPPED_MESSAGE, components: [] };
    }

    if (isRating(rating) && customId === FEEDBACK_BUTTON.rate(eventId, rating)) {
      const recorded = await actOnVia(() =>
        context.via.recordFeedback(eventId, { rating }, interaction.userId));
      if (!recorded.ok) return { ...recorded.reply, components: recorded.reply.components ?? [] };
      return renderRatingRecorded(eventId, rating);
    }

    return { content: UNKNOWN_ANSWER_MESSAGE, components: [] };
  },
};
