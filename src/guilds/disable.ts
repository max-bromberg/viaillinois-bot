import { featureById } from '../features/registry.ts';
import { NO_OUTBOX_ENTRY, guildTarget, type Deliveries } from '../delivery/deliveries.ts';
import type { GuildStore } from './store.ts';

/**
 * Switching a feature off in a server where it can no longer work.
 *
 * A server can break one of its own proactive features without meaning to, by
 * unbinding the channel it posts to or by taking away a permission the bot
 * needs. There are three things the bot could do about that, and two of them
 * are bad: it could keep trying and fail quietly every few minutes, or it
 * could keep trying and fill the log with the same failure. So it switches the
 * feature off, which is the honest state, and tells the manager who set the
 * bot up why and what to do about it.
 *
 * The notice goes through Deliveries, keyed by the server and the feature
 * rather than by an outbox entry, so a hundred entries about the same broken
 * feature send one direct message. The manager can switch the feature back on
 * from the configuration panel once the channel or the permission is back,
 * which is the same panel that would have refused to switch it on in that
 * state in the first place.
 */

export interface FeatureDisablerOptions {
  guilds: GuildStore;
  deliveries: Deliveries;
  /** Sends one direct message and answers whether it arrived, never throwing. */
  sendDirectMessage: (discordUserId: string, content: string) => Promise<boolean>;
}

export interface FeatureDisabler {
  /**
   * Switch the feature off in this server and tell the manager once, with the
   * reason written as the setup panel writes it.
   */
  disable(guildId: string, featureId: string, reason: string): Promise<void>;
}

/** What the manager reads. The reason is the sentence the setup panel would show. */
export function disabledNotice(featureDescription: string, reason: string): string {
  return [
    'The VIA bot has switched off one of its features in a server you set it up in, because the feature cannot work there any more.',
    '',
    `The feature: ${featureDescription}`,
    `The reason: ${reason}.`,
    '',
    'Nothing else has changed, and no other feature has been touched. Run the config command in that server to put it right, and switch the feature on again from the features panel.',
  ].join('\n');
}

export function createFeatureDisabler(options: FeatureDisablerOptions): FeatureDisabler {
  const { guilds, deliveries, sendDirectMessage } = options;

  return {
    async disable(guildId: string, featureId: string, reason: string): Promise<void> {
      const feature = featureById(featureId);
      await guilds.setFeatureEnabled(guildId, featureId, false);

      const installation = await guilds.getInstallation(guildId);
      // A server the bot holds no record of has no manager to tell, and
      // nothing to switch off beyond what has just been written.
      if (!installation) return;

      const intended = await deliveries.intend({
        outboxId: NO_OUTBOX_ENTRY,
        target: guildTarget(guildId),
        purpose: `disabled:${featureId}`,
        kind: 'direct_message',
      });
      if (!intended.isNew && intended.deliveredAt !== null) return;

      console.log(`feature ${featureId} switched off in server ${guildId}: ${reason}`);
      await sendDirectMessage(installation.installedBy, disabledNotice(feature.description, reason));
      // The notice is recorded whether or not it arrived. A person who does
      // not accept direct messages from the bot would otherwise be written to
      // on every entry forever.
      await deliveries.recordPosted(intended.deliveryId, null);
    },
  };
}
