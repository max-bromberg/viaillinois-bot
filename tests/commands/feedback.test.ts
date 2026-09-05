import { describe, it, expect, beforeEach } from 'vitest';
import { feedbackComponent, feedbackCommentComponent } from '../../src/commands/feedback.ts';
import {
  COMMENT_FIELD, COMMENT_RECORDED_MESSAGE, FEEDBACK_BUTTON, FEEDBACK_STOPPED_MESSAGE,
  ratingRecordedMessage,
} from '../../src/render/feedback.ts';
import { NOT_LINKED_TO_ACT_MESSAGE } from '../../src/commands/shared.ts';
import { componentHandlers } from '../../src/commands/index.ts';
import { interaction, testContext } from './support.ts';

/**
 * The buttons on the feedback message.
 *
 * A score is recorded the moment it is pressed, because a person who answered
 * has answered and should not have to press anything else for it to count.
 * The comment is offered afterwards, in a form, and it is recorded with the
 * score they already gave, which is how the web platform holds one answer per
 * person and event rather than two. The off switch is on the message itself,
 * as section 6.4 requires, and it flips the same preference the feed settings
 * panel flips.
 */
describe('answering a feedback request', () => {
  const ADA = '204255221017214977';

  let context: ReturnType<typeof testContext>;

  beforeEach(() => {
    context = testContext();
    context.via.clearEvents();
    context.via.seedEvent({ eventId: 10, rsoId: 3, title: 'General meeting' });
    context.via.seedLink(ADA);
  });

  /** A button press on a direct message, which is where these messages live. */
  function pressed(customId: string, overrides = {}) {
    return interaction({
      kind: 'button',
      commandName: null,
      customId,
      userId: ADA,
      guildId: null,
      channelId: '800000000000000001',
      context: 'botDm',
      ...overrides,
    });
  }

  it('records the score as the acting person and thanks them for it', async () => {
    const reply = await feedbackComponent.run(pressed(FEEDBACK_BUTTON.rate(10, 4)), context.context);

    expect(context.via.feedback).toEqual([
      { eventId: 10, rating: 4, comment: null, actingDiscordUserId: ADA },
    ]);
    expect(reply.content).toBe(ratingRecordedMessage(4));
  });

  it('offers the comment as a button once a score has been given, and takes the five away', async () => {
    const reply = await feedbackComponent.run(pressed(FEEDBACK_BUTTON.rate(10, 4)), context.context);

    const buttons = (reply.components ?? []).flatMap(row => row.components);
    expect(buttons.map(one => (one as { customId?: string }).customId))
      .toEqual([FEEDBACK_BUTTON.comment(10, 4)]);
  });

  it('edits the message the score was given on rather than answering beside it', () => {
    expect(feedbackComponent.updateInPlace).toBe(true);
  });

  it('opens the comment form when the comment button is pressed', async () => {
    const reply = await feedbackCommentComponent.run(
      pressed(FEEDBACK_BUTTON.comment(10, 4)), context.context);

    expect(reply.modal?.customId).toBe(FEEDBACK_BUTTON.comment(10, 4));
    expect(reply.modal?.fields.map(field => field.customId)).toEqual([COMMENT_FIELD]);
    expect(feedbackCommentComponent.opensModal).toBe(true);
  });

  it('records the comment beside the score the person already gave', async () => {
    const reply = await feedbackCommentComponent.run(interaction({
      kind: 'modal',
      commandName: null,
      customId: FEEDBACK_BUTTON.comment(10, 4),
      fields: { [COMMENT_FIELD]: 'The room was easy to find.' },
      userId: ADA,
      guildId: null,
      context: 'botDm',
    }), context.context);

    expect(context.via.feedback).toEqual([
      { eventId: 10, rating: 4, comment: 'The room was easy to find.', actingDiscordUserId: ADA },
    ]);
    expect(reply.content).toBe(COMMENT_RECORDED_MESSAGE);
  });

  it('records nothing more when the comment box was sent back empty', async () => {
    await feedbackComponent.run(pressed(FEEDBACK_BUTTON.rate(10, 4)), context.context);
    const reply = await feedbackCommentComponent.run(interaction({
      kind: 'modal',
      commandName: null,
      customId: FEEDBACK_BUTTON.comment(10, 4),
      fields: { [COMMENT_FIELD]: '   ' },
      userId: ADA,
      guildId: null,
      context: 'botDm',
    }), context.context);

    expect(context.via.feedback).toEqual([
      { eventId: 10, rating: 4, comment: null, actingDiscordUserId: ADA },
    ]);
    expect(reply.content).toBe(COMMENT_RECORDED_MESSAGE);
  });

  it('turns the feedback messages off for good when the person asks', async () => {
    const reply = await feedbackComponent.run(pressed(FEEDBACK_BUTTON.stop(10)), context.context);

    expect(reply.content).toBe(FEEDBACK_STOPPED_MESSAGE);
    expect((await context.feed.preferences(ADA)).feedbackOptOut).toBe(true);
    expect(reply.components).toEqual([]);
    // Saying no to being asked is not saying anything about the event.
    expect(context.via.feedback).toEqual([]);
  });

  it('offers the link to somebody whose VIA account has gone since the message was sent', async () => {
    const other = '204255221017214978';
    const reply = await feedbackComponent.run(
      pressed(FEEDBACK_BUTTON.rate(10, 4), { userId: other }), context.context);

    expect(reply.content).toBe(NOT_LINKED_TO_ACT_MESSAGE);
    expect(context.via.feedback).toEqual([]);
  });

  /**
   * The dispatcher answers a component with the first handler whose prefix it
   * begins with, and the comment handler's prefix sits inside the other one's,
   * so the order of the two is what makes the form open at all.
   */
  it('is answered by the comment handler before the handler its prefix sits inside', () => {
    const prefixes = componentHandlers.map(handler => handler.prefix);
    expect(prefixes).toContain('feedback:comment:');
    expect(prefixes).toContain('feedback:');
    expect(prefixes.indexOf('feedback:comment:')).toBeLessThan(prefixes.indexOf('feedback:'));
  });

  it('leaves a button it does not know alone rather than recording anything', async () => {
    const reply = await feedbackComponent.run(pressed('feedback:something:10'), context.context);
    expect(context.via.feedback).toEqual([]);
    expect(reply.content.length).toBeGreaterThan(0);
  });
});
