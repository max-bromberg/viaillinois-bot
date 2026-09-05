import { eq } from 'drizzle-orm';
import { featureById } from '../features/registry.ts';
import { interestMarks, reminders, subscriptions, userCourses, userPreferences } from '../db/schema.ts';
import { ViaBusyError, ViaError } from '../via/client.ts';
import { describeWait, type CommandContext, type CommandHandler } from './types.ts';
import type { BotDatabase } from '../ratelimit/windows.ts';
import type { Interaction, Reply } from '../discord/adapter.ts';

/**
 * The unlink command.
 *
 * Unlinking deletes the link and everything the bot held for the account, on
 * both sides. The web platform goes first: if it refuses or cannot be
 * reached, the bot keeps what it has, because a bot that had forgotten a
 * person's subscriptions while the web platform still believed them linked
 * would be worse than one that did nothing.
 *
 * The rows the bot holds are deleted even when there was no link, because
 * they can only be left over from a link that went away, and there is nothing
 * they could still belong to.
 */

const feature = featureById('identity.unlink');

export const UNREACHABLE_MESSAGE =
  'VIA is not answering right now, so the link cannot be removed. Please try again in a few minutes.';

export const UNLINKED_MESSAGE =
  'This Discord account is no longer linked to VIA, and every subscription, preference, reminder and course the bot held for it has been deleted.';

export const NOTHING_TO_UNLINK_MESSAGE =
  'This Discord account is not linked to a VIA account, so there is nothing to unlink.';

/**
 * Delete every row the bot holds for a Discord account. The five tables here
 * are all of them: nothing else in the bot database is keyed by a person.
 * Interest_Marks is one of them, because a mark is a thing the bot holds
 * about a person and it exists only to reach them after an event.
 */
export async function deleteLocalData(db: BotDatabase, discordUserId: string): Promise<void> {
  await db.delete(subscriptions).where(eq(subscriptions.discordUserId, discordUserId));
  await db.delete(userPreferences).where(eq(userPreferences.discordUserId, discordUserId));
  await db.delete(reminders).where(eq(reminders.discordUserId, discordUserId));
  await db.delete(userCourses).where(eq(userCourses.discordUserId, discordUserId));
  await db.delete(interestMarks).where(eq(interestMarks.discordUserId, discordUserId));
}

export const unlinkCommand: CommandHandler = {
  featureId: feature.id,
  name: feature.command!.name,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    let removed: boolean;
    try {
      removed = await context.via.unlink(interaction.userId);
    } catch (err) {
      if (err instanceof ViaBusyError) {
        return { content: `VIA is busy right now. Please try again ${describeWait(err.retryAfterSeconds)}.` };
      }
      if (err instanceof ViaError) return { content: UNREACHABLE_MESSAGE };
      throw err;
    }

    await context.deleteLocalData(interaction.userId);

    return { content: removed ? UNLINKED_MESSAGE : NOTHING_TO_UNLINK_MESSAGE };
  },
};
