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
 * How much of a description Discord shows beside a menu option, and how many
 * options one menu holds. Both are Discord's limits rather than the bot's,
 * and both are named here because the registry is what has to fit inside
 * them.
 */
export const MAX_SELECT_OPTION_DESCRIPTION = 100;
export const MAX_SELECT_OPTIONS = 25;

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
  /**
   * The same thing said short enough to sit in a Discord menu option, which
   * Discord cuts at a hundred characters. The setup panel lists the features
   * of one category a line each and puts the summary on the menu entry that
   * switches each one, because the full description of every feature in one
   * message is more than Discord will carry.
   */
  summary: string;
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
  courses: 'Keep the courses VIA reminds you about the exams of.',
};

const EVERYWHERE: readonly InteractionContext[] = ['guild', 'botDm', 'privateChannel'];

/**
 * The hours of the campus day, written the way somebody says them out loud.
 * The free room search and the scheduler both ask for an hour, and both offer
 * the same list, so the list is written once here.
 */
export const HOUR_CHOICES: readonly { name: string; value: string }[] = [
  { name: 'midnight', value: '0' },
  { name: '1 in the morning', value: '1' },
  { name: '2 in the morning', value: '2' },
  { name: '3 in the morning', value: '3' },
  { name: '4 in the morning', value: '4' },
  { name: '5 in the morning', value: '5' },
  { name: '6 in the morning', value: '6' },
  { name: '7 in the morning', value: '7' },
  { name: '8 in the morning', value: '8' },
  { name: '9 in the morning', value: '9' },
  { name: '10 in the morning', value: '10' },
  { name: '11 in the morning', value: '11' },
  { name: 'midday', value: '12' },
  { name: '1 in the afternoon', value: '13' },
  { name: '2 in the afternoon', value: '14' },
  { name: '3 in the afternoon', value: '15' },
  { name: '4 in the afternoon', value: '16' },
  { name: '5 in the afternoon', value: '17' },
  { name: '6 in the evening', value: '18' },
  { name: '7 in the evening', value: '19' },
  { name: '8 in the evening', value: '20' },
  { name: '9 at night', value: '21' },
  { name: '10 at night', value: '22' },
  { name: '11 at night', value: '23' },
];

/**
 * The event an administrative action is about. Every one of the six actions
 * names the same option, completed the same way, because they are six things
 * done to one event rather than six different questions.
 */
const EVENT_OPTION: FeatureCommandOption = {
  name: 'event',
  description: 'The event, by title or by organization.',
  kind: 'string',
  required: true,
  autocomplete: true,
};

export const features: readonly Feature[] = [
  {
    id: 'identity.link',
    description: 'Link a Discord account to a VIA account through a sign in on viaillinois.com.',
    summary: 'Link a Discord account to a VIA account.',
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
    summary: 'List the events coming up, for one organization or for all of ECE.',
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
    summary: 'Show one event, with a reminder, an interest mark and a calendar file.',
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
    summary: 'Show one organization and the events it has coming up.',
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
    summary: 'Announce a new event in the announcements channel.',
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
    summary: 'Keep an announcement current when the event it describes changes.',
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
    summary: 'Mirror the events coming up into the server Events tab.',
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
    summary: 'Set the bot up in this server, and change any answer later.',
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
    summary: 'Remove the bot and every row it holds for this server.',
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
    summary: 'Follow and unfollow organizations, or follow every organization in ECE.',
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
    summary: 'Send a weekly direct message listing what is coming up.',
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
    summary: 'Send a direct message before each event you asked about.',
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
    summary: 'Give you a private calendar address for the organizations you follow.',
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
    summary: 'Post the coming week in the digest channel, once a week.',
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
    summary: 'Post a short reminder before each event of the day.',
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
    summary: 'Keep one pinned message listing the events of this week.',
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
    id: 'midterms.lookup',
    description: 'Show the exams VIA has for one course, with their rooms and their times, and say which of them are still pending confirmation.',
    summary: 'Show the exams VIA has for one course.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'read',
    contexts: EVERYWHERE,
    command: {
      name: 'midterms',
      description: 'See the exams VIA has for a course.',
      options: [
        {
          name: 'course',
          description: 'The course, by its code or its title.',
          kind: 'string',
          required: true,
          autocomplete: true,
        },
      ],
    },
  },
  {
    id: 'feed.courses',
    description: 'Keep the list of courses you are taking, which is what VIA reminds you about the exams of and writes to you when one of those exams changes.',
    summary: 'Keep the courses VIA reminds you about the exams of.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'linked',
    contexts: EVERYWHERE,
    command: {
      // Adding a course, removing one and reading back what was added are one
      // feature because they are one set of rows. Discord will not answer the
      // name of a group on its own, so reading the list back is a subcommand
      // of its own rather than the bare name.
      group: 'courses',
      name: 'add',
      description: 'Add a course, so that VIA reminds you about its exams.',
      options: [
        {
          name: 'course',
          description: 'The course, by its code or its title.',
          kind: 'string',
          autocomplete: true,
        },
      ],
      alternateNames: [
        { name: 'remove', description: 'Stop hearing about the exams of a course.' },
        { name: 'list', description: 'See the courses you added.' },
      ],
    },
  },
  {
    id: 'announce.exams',
    description: 'Post one message a week in the exam notices channel, listing the confirmed exams of the coming week, grouped by day.',
    summary: 'Post the confirmed exams of the coming week, once a week.',
    category: 'proactive',
    defaultEnabled: false,
    requiredPermissions: ['ViewChannel', 'SendMessages'],
    channelPurposes: ['exams'],
    tier: 'manager',
    contexts: ['guild'],
  },
  {
    id: 'campus.rooms',
    description: 'Show the rooms of a building that have no class, no reservation and no VIA event in them for a window of time.',
    summary: 'Show the rooms of a building with nothing in them for a window of time.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'read',
    contexts: EVERYWHERE,
    command: {
      name: 'rooms',
      description: 'Find a free room in a building.',
      options: [
        {
          name: 'building',
          description: 'The building, by code or by name.',
          kind: 'string',
          required: true,
          autocomplete: true,
        },
        {
          name: 'date',
          description: 'The day, written as YYYY-MM-DD. Leave it out for today.',
          kind: 'string',
        },
        {
          name: 'from',
          description: 'The hour the window starts at. Leave it out for the next hour.',
          kind: 'string',
          choices: HOUR_CHOICES,
        },
        {
          name: 'to',
          description: 'The hour the window ends at.',
          kind: 'string',
          choices: HOUR_CHOICES,
        },
      ],
    },
  },
  {
    id: 'campus.course',
    description: 'Show the sections of one course, with the days they meet on, the hours they run and the rooms they are in.',
    summary: 'Show when and where the sections of a course meet.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'read',
    contexts: EVERYWHERE,
    command: {
      name: 'course',
      description: 'See when and where a course meets.',
      options: [
        {
          name: 'course',
          description: 'The course, by its code or its title.',
          kind: 'string',
          required: true,
          autocomplete: true,
        },
      ],
    },
  },
  {
    id: 'campus.building',
    description: 'Say what a building code stands for, with the address when the university listing records one.',
    summary: 'Say what a building code stands for.',
    category: 'command',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'read',
    contexts: EVERYWHERE,
    command: {
      name: 'building',
      description: 'See what a building code stands for.',
      options: [
        {
          name: 'building',
          description: 'The building, by code or by name.',
          kind: 'string',
          required: true,
          autocomplete: true,
        },
      ],
    },
  },
  /**
   * The administrative actions of section 6.7.
   *
   * Every one of them is refused by the web platform unless the acting person
   * is an editor or a board member of the organization the event belongs to,
   * which is what the editor tier means: the bot asks and reads the refusal
   * rather than working out for itself who may act. Each is a command for
   * somebody who prefers typing and a button on the event card and on the
   * announcement for somebody who is already reading one.
   */
  {
    id: 'admin.postpone',
    description: 'Let an editor of an organization move one of its events to a new time, with a reason that travels with the change notice.',
    summary: 'Move one event to a new time, with an optional reason.',
    category: 'administration',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'editor',
    contexts: ['guild'],
    command: {
      name: 'postpone',
      description: 'Move one of your organization events to a new time.',
      options: [EVENT_OPTION],
    },
  },
  {
    id: 'admin.cancel',
    description: 'Let an editor of an organization cancel one of its events, after a confirmation, so that the announcement is marked and the notice follows.',
    summary: 'Cancel one event on VIA, after a confirmation.',
    category: 'administration',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'editor',
    contexts: ['guild'],
    command: {
      name: 'cancel',
      description: 'Cancel one of your organization events.',
      options: [EVENT_OPTION],
    },
  },
  {
    id: 'admin.describe',
    description: 'Let an editor of an organization change what one of its events says about itself, in a box filled with what it says now.',
    summary: 'Change what one event says about itself.',
    category: 'administration',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'editor',
    contexts: ['guild'],
    command: {
      name: 'describe',
      description: 'Change what one of your organization events says.',
      options: [EVENT_OPTION],
    },
  },
  {
    id: 'admin.visibility',
    description: 'Let an editor of an organization switch one of its events between public and internal to the members of that organization.',
    summary: 'Switch one event between public and internal.',
    category: 'administration',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'editor',
    contexts: ['guild'],
    command: {
      name: 'visibility',
      description: 'Switch one of your organization events between public and internal.',
      options: [EVENT_OPTION],
    },
  },
  {
    id: 'admin.repost',
    description: 'Let an editor of an organization post the announcement card of one of its events again, in the announcements channel or in the channel the command was run in.',
    summary: 'Post the announcement card of one event again.',
    category: 'administration',
    defaultEnabled: true,
    // Re posting is the one administrative action that posts a message into a
    // channel, so it is the one that needs the permission to post.
    requiredPermissions: ['ViewChannel', 'SendMessages'],
    channelPurposes: [],
    tier: 'editor',
    contexts: ['guild'],
    command: {
      name: 'repost',
      description: 'Post the announcement of one of your organization events again.',
      options: [EVENT_OPTION],
    },
  },
  {
    id: 'admin.locationnote',
    description: 'Let an editor of an organization pin a short note about where one of its events is, such as which entrance to use, shown on the card and on the announcement.',
    summary: 'Pin a short note about where one event is.',
    category: 'administration',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'editor',
    contexts: ['guild'],
    command: {
      name: 'note',
      description: 'Pin a short note about where one of your organization events is.',
      options: [EVENT_OPTION],
    },
  },
  {
    id: 'scheduler.recommend',
    description: 'Ask VIA which evenings work for a repeat, for one week or for the rest of the term, with the score of each, the number of clear weeks and the reasons.',
    summary: 'Ask which evenings work for a repeat, with scores and reasons.',
    category: 'administration',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'editor',
    contexts: ['guild'],
    command: {
      name: 'schedule',
      description: 'Ask VIA which evenings work for a repeat.',
      options: [
        {
          name: 'rso',
          description: 'The organization the repeat is for, by name.',
          kind: 'string',
          required: true,
          autocomplete: true,
        },
        {
          name: 'span',
          description: 'How far ahead to look.',
          kind: 'string',
          choices: [
            { name: 'One week', value: 'week' },
            { name: 'The rest of the term', value: 'term' },
          ],
        },
        {
          name: 'length',
          description: 'How long each meeting runs.',
          kind: 'string',
          choices: [
            { name: 'Half an hour', value: '30' },
            { name: 'An hour', value: '60' },
            { name: 'An hour and a half', value: '90' },
            { name: 'Two hours', value: '120' },
            { name: 'Three hours', value: '180' },
          ],
        },
        {
          name: 'earliest',
          description: 'The earliest hour a meeting may start at.',
          kind: 'string',
          choices: HOUR_CHOICES,
        },
        {
          name: 'latest',
          description: 'The latest hour a meeting may end by.',
          kind: 'string',
          choices: HOUR_CHOICES,
        },
      ],
    },
  },
  {
    id: 'scheduler.poll',
    description: 'Open a Discord poll over the evenings VIA recommended, in a channel of your choosing, so that member availability joins the campus data.',
    summary: 'Open a Discord poll over the evenings VIA recommended.',
    category: 'administration',
    defaultEnabled: true,
    // The poll is posted into a channel the board member picks, which is what
    // the two permissions are for. It binds no purpose, because the channel is
    // chosen when the poll is opened rather than in setup.
    requiredPermissions: ['ViewChannel', 'SendMessages'],
    channelPurposes: [],
    tier: 'editor',
    contexts: ['guild'],
  },
  {
    id: 'scheduler.accept',
    description: 'Create the repeat from a recommendation, checking it again first and showing anything that has changed since the poll was opened.',
    summary: 'Create the repeat from a recommendation, after checking it again.',
    category: 'administration',
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'editor',
    contexts: ['guild'],
  },
  {
    id: 'roles.membership',
    description: 'Give the members, the editors and the board of the organization this server is bound to a Discord role each, kept in step as memberships change on VIA.',
    summary: 'Give members, editors and board members a Discord role.',
    category: 'roles',
    // A server that has not asked for this has not thought about which Discord
    // role means what, and a bot that starts handing out roles on the day it
    // joins is a bot that gets removed.
    defaultEnabled: false,
    requiredPermissions: ['ManageRoles'],
    channelPurposes: [],
    tier: 'manager',
    contexts: ['guild'],
    command: {
      name: 'roles',
      description: 'Map the VIA membership roles to Discord roles in this server.',
    },
  },
  {
    id: 'roles.linked',
    description: 'Publish whether a person has a verified NetID, whether they sit on a board, and when they linked, as facts any server can require for a role in its own role settings.',
    summary: 'Publish a verified NetID as a fact a server can require for a role.',
    category: 'roles',
    // The facts are registered once for the whole application and pushed by
    // the web platform, so there is nothing here for a server to switch on and
    // nothing for the bot to be given in a server.
    defaultEnabled: true,
    requiredPermissions: [],
    channelPurposes: [],
    tier: 'linked',
    contexts: ['guild'],
  },
  {
    id: 'identity.unlink',
    description: 'Remove the link between a Discord account and a VIA account, along with every subscription and preference the bot held for it.',
    summary: 'Remove the link between a Discord account and a VIA account.',
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
