import type { PermissionFlagsBits } from 'discord.js';

/**
 * The feature registry.
 *
 * Every capability the bot has is a named feature here. Setup reads the
 * registry to build its panels, command registration reads it to build the
 * command list, and per server state in Guild_Features is keyed by the
 * identifiers declared here. A capability that is not in the registry does
 * not exist as far as a server manager is concerned.
 */

/** What kind of thing a feature is, which is how setup groups its toggles. */
export type FeatureCategory = 'command' | 'proactive' | 'roles' | 'administration';

/** The tier from section 4 of the design that a person needs to use a feature. */
export type FeatureTier = 'read' | 'linked' | 'editor' | 'manager';

/**
 * The purposes a server can bind a channel to. A proactive feature posts to
 * the channel bound to its purpose, and cannot be enabled until one is.
 */
export const CHANNEL_PURPOSES = ['announcements', 'digest', 'reminders', 'exams', 'thisweek'] as const;
export type ChannelPurpose = (typeof CHANNEL_PURPOSES)[number];

/**
 * Where an interaction can come from, named as Discord names them: a server,
 * the bot's own direct messages, or a group direct message and any other
 * private channel reached through user installation.
 */
export type InteractionContext = 'guild' | 'botDm' | 'privateChannel';

/** A Discord permission, named as discord.js names it, so setup can say which grant is missing. */
export type DiscordPermission = keyof typeof PermissionFlagsBits;

export interface Feature {
  /** Category and name separated by a dot, as the design lists them. */
  id: string;
  /** What the feature does, in the words a server manager reads in setup. */
  description: string;
  category: FeatureCategory;
  /** Whether the feature is on when the bot is first installed in a server. */
  defaultEnabled: boolean;
  /** The Discord permissions the bot needs for the feature to work. */
  requiredPermissions: readonly DiscordPermission[];
  /** The channel purposes the feature posts to, empty when it does not post. */
  channelPurposes: readonly ChannelPurpose[];
  /** The tier a person needs to use the feature. */
  tier: FeatureTier;
  /** The contexts the feature can be used in. */
  contexts: readonly InteractionContext[];
}

const EVERYWHERE: readonly InteractionContext[] = ['guild', 'botDm', 'privateChannel'];

export const features: readonly Feature[] = [
  {
    id: 'identity.link',
    description: 'Link a Discord account to a VIA account through a sign in on viaillinois.com.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'read',
    contexts: EVERYWHERE,
  },
  {
    id: 'identity.unlink',
    description: 'Remove the link between a Discord account and a VIA account, along with every subscription and preference the bot held for it.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'linked',
    contexts: EVERYWHERE,
  },
];

/** The feature with the given identifier, or an error naming the identifier. */
export function featureById(id: string): Feature {
  const feature = features.find(f => f.id === id);
  if (!feature) throw new Error(`There is no feature with the identifier ${id}.`);
  return feature;
}
