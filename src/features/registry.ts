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
 * How a channel purpose is written for somebody who has to choose a channel
 * for it, and for the notice a manager is sent when a feature had to be
 * switched off because none is bound. Both read the same words, because they
 * are about the same setting.
 */
export const CHANNEL_PURPOSE_LABELS: Record<ChannelPurpose, string> = {
  announcements: 'announcements',
  digest: 'the weekly digest',
  reminders: 'reminders',
  exams: 'exam notices',
  thisweek: 'the this week message',
};

/**
 * Where an interaction can come from, named as Discord names them: a server,
 * the bot's own direct messages, or a group direct message and any other
 * private channel reached through user installation.
 */
export type InteractionContext = 'guild' | 'botDm' | 'privateChannel';

/** A Discord permission, named as discord.js names it, so setup can say which grant is missing. */
export type DiscordPermission = keyof typeof PermissionFlagsBits;

/**
 * The application command a feature is reached by, when it is reached by one.
 *
 * Where the command sits is not declared here, because it follows from the
 * tier: the read and linked tiers are what students use, so those commands
 * sit at the top level, and the editor and manager tiers are setup and board
 * work, so those sit under the via group. The description is separate from
 * the feature description because Discord allows a hundred characters and a
 * server manager reading the setup panel deserves more than that.
 */
/** The kinds of value a command option can be declared as. */
export type CommandOptionKind = 'string' | 'boolean';

/**
 * One option on a command. An option either lets Discord complete the value
 * as the person types, which is how organizations and events are found, or
 * offers a fixed list of choices, which is how a window is picked. It is
 * never both, because Discord accepts only one of the two.
 */
export interface FeatureCommandOption {
  name: string;
  /** What Discord shows beside the option, at most a hundred characters. */
  description: string;
  kind: CommandOptionKind;
  required?: boolean;
  /** Whether the bot completes the value as the person types it. */
  autocomplete?: boolean;
  /** The fixed values a person picks from, when the option has any. */
  choices?: readonly { name: string; value: string }[];
}

/**
 * Another name the same feature is reached by. Configuration is one feature
 * with two ways in, because a manager setting the bot up for the first time
 * looks for setup and a manager changing one answer later looks for config,
 * and both open the same panels over the same rows. A second registry entry
 * would be a second feature to toggle and a second default to keep in step,
 * which is not what a second name is.
 */
export interface AlternateCommandName {
  name: string;
  description: string;
}

export interface FeatureCommand {
  /**
   * The group the command sits in, when it sits in one that the tier does not
   * already decide. The editor and manager tiers sit under the via group
   * because that is what they are, and a group named here is for a set of
   * student commands that belong together, such as the personal feed
   * settings, so that a person types the thing rather than a list of
   * unrelated top level names.
   */
  group?: string;
  /** The name a person types, without the group. */
  name: string;
  /** What Discord shows beside the name, at most a hundred characters. */
  description: string;
  /** The options the command takes, in the order Discord shows them. */
  options?: readonly FeatureCommandOption[];
  /** Other names that reach the same feature. */
  alternateNames?: readonly AlternateCommandName[];
}

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
  /** The command the feature is reached by, when there is one. */
  command?: FeatureCommand;
}

/**
 * What Discord shows beside a command group, keyed by the group name. A group
 * is one command with subcommands under it as far as Discord is concerned, and
 * one command needs one description.
 */
export const COMMAND_GROUP_DESCRIPTIONS: Record<string, string> = {
  via: 'Set up VIA in this server and run your organization events.',
  feed: 'Choose what VIA sends you about the organizations you follow.',
};

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
    command: { name: 'link', description: 'Link this Discord account to your VIA account.' },
  },
  {
    id: 'events.list',
    description: 'List the events coming up, with an option for one organization, for a window of time, and for the events an organization marked internal.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'read',
    contexts: EVERYWHERE,
    command: {
      name: 'events',
      description: 'See the events coming up across ECE.',
      options: [
        {
          name: 'rso',
          description: 'One organization, by name.',
          kind: 'string',
          autocomplete: true,
        },
        {
          name: 'window',
          description: 'How far ahead to look.',
          kind: 'string',
          choices: [
            { name: 'Today', value: 'today' },
            { name: 'This week', value: 'thisweek' },
            { name: 'Next week', value: 'nextweek' },
            { name: 'This month', value: 'thismonth' },
          ],
        },
        {
          name: 'internal',
          description: 'Include the events your organizations marked internal.',
          kind: 'boolean',
        },
      ],
    },
  },
  {
    id: 'events.detail',
    description: 'Show one event with its time, its room and its description, and offer a reminder, an interest mark, a calendar file and the page on viaillinois.com.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'read',
    contexts: EVERYWHERE,
    command: {
      name: 'event',
      description: 'Show one event.',
      options: [
        {
          name: 'event',
          description: 'The event, by title or by organization.',
          kind: 'string',
          required: true,
          autocomplete: true,
        },
      ],
    },
  },
  {
    id: 'rsos.detail',
    description: 'Show one organization with its description and the events it has coming up.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'read',
    contexts: EVERYWHERE,
    command: {
      name: 'rso',
      description: 'Show one organization.',
      options: [
        {
          name: 'rso',
          description: 'The organization, by name.',
          kind: 'string',
          required: true,
          autocomplete: true,
        },
      ],
    },
  },
  {
    id: 'announce.new',
    description: 'Post an announcement in the announcements channel when an organization this server follows creates an event, or a series of meetings, on VIA.',
    category: 'proactive',
    // Nothing proactive happens in a server until that server asks for it, so
    // every feature in this category is off until a manager switches it on.
    defaultEnabled: false,
    requiredPermissions: ['ViewChannel', 'SendMessages'],
    channelPurposes: ['announcements'],
    tier: 'manager',
    contexts: ['guild'],
  },
  {
    id: 'announce.changes',
    description: 'Keep an announcement current when the event it describes moves, changes room, is cancelled or is removed, and post a short notice beside it.',
    category: 'proactive',
    defaultEnabled: false,
    requiredPermissions: ['ViewChannel', 'SendMessages'],
    channelPurposes: ['announcements'],
    tier: 'manager',
    contexts: ['guild'],
  },
  {
    id: 'mirror.scheduled',
    description: 'Mirror the events coming up into the server Events tab as Discord scheduled events, so that members can mark themselves interested with Discord own control and receive Discord own reminders.',
    category: 'proactive',
    defaultEnabled: false,
    // The Events tab is not a channel, so this feature binds no channel
    // purpose. What it does need is the permission to create and edit the
    // server's own scheduled events.
    requiredPermissions: ['ManageEvents'],
    channelPurposes: [],
    tier: 'manager',
    contexts: ['guild'],
  },
  {
    id: 'setup.configure',
    description: 'Set the bot up in this server and change any answer later: what kind of server this is, the organizations it follows, the channels the bot posts in, and which features are on.',
    category: 'administration',
    defaultEnabled: true,
    // Manage Server is the permission the person needs, which the manager tier
    // says. The bot itself needs nothing beyond answering the interaction.
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'manager',
    contexts: ['guild'],
    command: {
      name: 'setup',
      description: 'Set the bot up in this server.',
      options: [
        {
          name: 'rso',
          description: 'Bind this server to one organization, by name.',
          kind: 'string',
          autocomplete: true,
        },
      ],
      alternateNames: [
        { name: 'config', description: 'Change how the bot is set up in this server.' },
      ],
    },
  },
  {
    id: 'setup.remove',
    description: 'Remove the bot from this server: every scheduled event it created, the message it pinned, and every row it holds for this server.',
    category: 'administration',
    defaultEnabled: true,
    // Manage Server is the permission the person needs, which the manager tier
    // says. The bot itself needs nothing beyond answering the interaction.
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'manager',
    contexts: ['guild'],
    command: {
      name: 'remove',
      description: 'Remove the bot and everything it holds for this server.',
    },
  },
  {
    id: 'feed.follow',
    description: 'Follow and unfollow organizations, or follow every organization in ECE, which is what the personal digest and the personal reminders are drawn from.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'linked',
    contexts: EVERYWHERE,
    command: {
      name: 'follow',
      description: 'Follow an organization, so that VIA writes to you about it.',
      options: [
        {
          name: 'rso',
          description: 'The organization, by name, or every organization in ECE.',
          kind: 'string',
          autocomplete: true,
        },
      ],
      // The three names are one feature because they are one set of rows:
      // following, unfollowing and reading back what is followed are the same
      // question asked three ways. The organization is optional on all three
      // because Discord gives every name the same options, and each of them
      // has something to say without one.
      alternateNames: [
        { name: 'unfollow', description: 'Stop following an organization.' },
        { name: 'following', description: 'See the organizations you follow.' },
      ],
    },
  },
  {
    id: 'feed.digest',
    description: 'Send a weekly direct message listing what is coming up for the organizations you follow, on the day and at the hour you choose.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'linked',
    contexts: EVERYWHERE,
    command: {
      group: 'feed',
      name: 'settings',
      description: 'Change what VIA sends you and when.',
    },
  },
  {
    id: 'feed.reminders',
    description: 'Send a direct message before each event you asked to be reminded of, at the lead time you choose.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'linked',
    contexts: EVERYWHERE,
    command: {
      group: 'feed',
      name: 'reminders',
      description: 'See the events you asked to be reminded of.',
    },
  },
  {
    id: 'feed.calendar',
    description: 'Give you a private calendar address carrying every event of the organizations you follow, so that your own calendar stays current.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'linked',
    contexts: EVERYWHERE,
    command: {
      name: 'calendar',
      description: 'Get your private VIA calendar address.',
    },
  },
  {
    id: 'announce.digest',
    description: 'Post one message a week in the digest channel, listing the coming week for the organizations this server follows, grouped by day.',
    category: 'proactive',
    defaultEnabled: false,
    requiredPermissions: ['ViewChannel', 'SendMessages'],
    channelPurposes: ['digest'],
    tier: 'manager',
    contexts: ['guild'],
  },
  {
    id: 'announce.dayof',
    description: 'Post a short reminder in the reminders channel before each event of the day, at the lead time this server chooses.',
    category: 'proactive',
    defaultEnabled: false,
    requiredPermissions: ['ViewChannel', 'SendMessages'],
    channelPurposes: ['reminders'],
    tier: 'manager',
    contexts: ['guild'],
  },
  {
    id: 'living.thisweek',
    description: 'Keep one pinned message in the this week channel listing the events of the current week, edited in place whenever any of them changes.',
    category: 'proactive',
    defaultEnabled: false,
    // The message is pinned once and unpinned when the bot is removed, which
    // is what the Manage Messages permission is for.
    requiredPermissions: ['ViewChannel', 'SendMessages', 'ManageMessages'],
    channelPurposes: ['thisweek'],
    tier: 'manager',
    contexts: ['guild'],
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
    command: { name: 'unlink', description: 'Remove the link between this Discord account and your VIA account.' },
  },
];

/** The feature with the given identifier, or an error naming the identifier. */
export function featureById(id: string): Feature {
  const feature = features.find(f => f.id === id);
  if (!feature) throw new Error(`There is no feature with the identifier ${id}.`);
  return feature;
}
