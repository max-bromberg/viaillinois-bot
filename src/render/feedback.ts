import { campusDate } from './campusTime.ts';
import type { Reply, ReplyModal } from '../discord/adapter.ts';
import type { ViaEvent } from '../via/client.ts';

/**
 * The one message the bot sends that nobody asked for.
 *
 * Section 6.4 of the design is careful about this message, and every rule it
 * sets is written into what is rendered here. It is one message, once, about
 * one event, and the way to stop being asked again is a button on the message
 * itself rather than a sentence pointing at a settings command. The scores are
 * five buttons rather than a menu, because a person reading this on a phone
 * should be able to answer it with one tap and never open anything.
 *
 * The comment is asked for afterwards, in a form, and only from somebody who
 * has already given a score. That way the message asks for one thing, the
 * answer is recorded the moment it is given, and the comment is an offer
 * rather than a second question standing between the person and being done.
 */

/** How a person stops being asked for feedback. */
export const FEEDBACK_STOP_SENTENCE =
  'You receive this because you marked interest in this event or asked to be reminded of it. Press Do not ask me again to stop these messages for good.';

/** How long a comment may be, which is what the web platform accepts. */
export const MAX_COMMENT_LENGTH = 1000;

/** The scores a person can give, from poor to excellent. */
export const RATINGS = [1, 2, 3, 4, 5] as const;

/**
 * The buttons on the feedback message, and the form the comment arrives in.
 * The score is carried in the identifier of the comment button, so that the
 * comment is recorded with the score the person already gave rather than with
 * a score the bot has to remember for them.
 */
export const FEEDBACK_BUTTON = {
  rate: (eventId: number, rating: number) => `feedback:rate:${eventId}:${rating}`,
  stop: (eventId: number) => `feedback:stop:${eventId}`,
  comment: (eventId: number, rating: number) => `feedback:comment:${eventId}:${rating}`,
};

/** The box the comment is typed into, which is what the form sends back. */
export const COMMENT_FIELD = 'comment';

/** What the person reads when their score has been recorded. */
export function ratingRecordedMessage(rating: number): string {
  return `Thank you. Your score of ${rating} out of 5 has been recorded, and the board sees the average rather than who gave which score.`;
}

/** What the person reads when their comment has been recorded beside it. */
export const COMMENT_RECORDED_MESSAGE =
  'Thank you. Your comment has been recorded beside your score, and the board reads it without being told who wrote it.';

/** What the person reads once they have asked not to be asked again. */
export const FEEDBACK_STOPPED_MESSAGE =
  'You will not be asked about an event again. You can turn these messages back on from the feed settings command whenever you like.';

/** The direct message somebody receives the morning after an event. */
export function renderFeedbackRequest(event: ViaEvent): Reply {
  const organization = event.rsoName ? ` from ${event.rsoName}` : '';
  return {
    content: [
      `**How was ${event.title}?**`,
      '',
      `You asked VIA about this event${organization}, which ran on ${campusDate(event.startTime)}.`,
      '',
      'Choose a score from 1, which is poor, to 5, which is excellent. The board reads the average and the comments, and never who gave which score.',
      '',
      FEEDBACK_STOP_SENTENCE,
    ].join('\n'),
    components: [
      {
        kind: 'row',
        components: RATINGS.map(rating => ({
          kind: 'button' as const,
          style: 'secondary' as const,
          label: String(rating),
          customId: FEEDBACK_BUTTON.rate(event.eventId, rating),
        })),
      },
      {
        kind: 'row',
        components: [{
          kind: 'button',
          style: 'secondary',
          label: 'Do not ask me again',
          customId: FEEDBACK_BUTTON.stop(event.eventId),
        }],
      },
    ],
  };
}

/**
 * The message as it stands once a score has been given. It replaces the five
 * buttons, so that the message a person comes back to says what they answered
 * rather than offering them the question again.
 */
export function renderRatingRecorded(eventId: number, rating: number): Reply {
  return {
    content: ratingRecordedMessage(rating),
    components: [{
      kind: 'row',
      components: [{
        kind: 'button',
        style: 'primary',
        label: 'Add a comment',
        customId: FEEDBACK_BUTTON.comment(eventId, rating),
      }],
    }],
  };
}

/** The form the comment is typed into. */
export function commentModal(eventId: number, rating: number): ReplyModal {
  return {
    customId: FEEDBACK_BUTTON.comment(eventId, rating),
    title: 'Tell the board more',
    fields: [{
      customId: COMMENT_FIELD,
      label: 'What would you tell the board?',
      style: 'paragraph',
      required: false,
      maxLength: MAX_COMMENT_LENGTH,
    }],
  };
}
