import { eq } from 'drizzle-orm';
import { featureById } from '../features/registry.ts';
import {
  interestMarks, reminders, roleGrants, subscriptions, userCourses, userPreferences,
} from '../db/schema.ts';
import { createGuildStore } from '../guilds/store.ts';
import { ViaBusyError, ViaError } from '../via/client.ts';
import { describeWait, type CommandContext, type CommandHandler } from './types.ts';
import type { BotDatabase } from '../ratelimit/windows.ts';
import type { Interaction, Reply } from '../discord/adapter.ts';
import type { MembershipRoles } from '../roles/membership.ts';

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

export interface DeleteLocalDataOptions {
  /**
   * How a mapped role is taken back, which is the same module the membership
   * entries and the daily reconciliation go through. It is left out where a
   * caller has no gateway to take a role back with, and the grant rows are
   * then deleted on their own.
   */
  roles?: Pick<MembershipRoles, 'apply'>;
}

/**
 * Delete every row the bot holds for a Discord account. The six tables here
 * are all of them: nothing else in the bot database is keyed by a person.
 * Interest_Marks is one of them, because a mark is a thing the bot holds about
 * a person and it exists only to reach them after an event.
 *
 * Role_Grants is the one of the six that is not only a row. A grant says the
 * bot gave somebody a Discord role because VIA listed them as a member of the
 * organization a server speaks for, and a link that has gone means VIA lists
 * them as nothing. So the role is taken back in every server that holds a
 * grant for the account, through the same module the membership entries go
 * through, and only then are the rows deleted. Taking the role back first is
 * what makes a failure safe: the grant stays, so the role is not stranded in a
 * server with nothing left to remember that the bot gave it.
 */
export async function deleteLocalData(
  db: BotDatabase,
  discordUserId: string,
  options: DeleteLocalDataOptions = {},
): Promise<void> {
  await takeBackRoles(db, discordUserId, options.roles);

  await db.delete(subscriptions).where(eq(subscriptions.discordUserId, discordUserId));
  await db.delete(userPreferences).where(eq(userPreferences.discordUserId, discordUserId));
  await db.delete(reminders).where(eq(reminders.discordUserId, discordUserId));
  await db.delete(userCourses).where(eq(userCourses.discordUserId, discordUserId));
  await db.delete(interestMarks).where(eq(interestMarks.discordUserId, discordUserId));
  await db.delete(roleGrants).where(eq(roleGrants.discordUserId, discordUserId));
}

/** Take back every mapped role the bot gave this account, server by server. */
async function takeBackRoles(
  db: BotDatabase,
  discordUserId: string,
  roles: Pick<MembershipRoles, 'apply'> | undefined,
): Promise<void> {
  if (!roles) return;

  const held = await db.select().from(roleGrants).where(eq(roleGrants.discordUserId, discordUserId));
  const guildIds = [...new Set(held.map(grant => grant.guildId))].sort();
  if (guildIds.length === 0) return;

  const guilds = createGuildStore(db);
  for (const guildId of guildIds) {
    const installation = await guilds.getInstallation(guildId);
    // A server the bot no longer holds a row for has no roles to take back,
    // and its grants go with the rest of what the account left behind.
    if (!installation) continue;
    // A role of null is what says the person is a member of nothing, which is
    // exactly what a link that has gone means.
    await roles.apply(installation, discordUserId, null);
  }
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
