import { CHANNEL_PURPOSE_LABELS, type ChannelPurpose } from '../features/registry.ts';
import type { FeatureDisabler } from './disable.ts';
import type { GuildStore } from './store.ts';

/**
 * Where a proactive feature posts.
 *
 * Every proactive feature posts to the channel bound to its purpose, and a
 * server with the feature switched on and no channel bound has broken it
 * without meaning to. There are three things the bot could do about that and
 * two of them are bad: fail quietly every few minutes, or fill the log with
 * the same failure. So the feature is switched off, which is the honest state,
 * and the manager who set the bot up is told once, which is what the feature
 * disabler does.
 *
 * This is one function because four features need it, and a sentence a
 * manager reads should not depend on which of them asked.
 */

export interface ChannelLookupOptions {
  guilds: GuildStore;
  disable: FeatureDisabler;
}

/** Why a feature cannot work, in the words the setup panel would use. */
export function noChannelReason(purpose: ChannelPurpose): string {
  return `no channel is bound to ${CHANNEL_PURPOSE_LABELS[purpose]}`;
}

/**
 * The channel a server posts this feature in, or nothing when it does not
 * post it: the feature is off, or it is on and no channel is bound, in which
 * case it is switched off and the manager is told.
 */
export async function channelFor(
  options: ChannelLookupOptions,
  guildId: string,
  featureId: string,
  purpose: ChannelPurpose,
): Promise<string | null> {
  if (!(await options.guilds.isFeatureEnabled(guildId, featureId))) return null;

  const channels = await options.guilds.listChannels(guildId);
  const channelId = channels[purpose];
  if (channelId) return channelId;

  await options.disable.disable(guildId, featureId, noChannelReason(purpose));
  return null;
}
