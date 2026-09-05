import {
  features as allFeatures, featureById, CHANNEL_PURPOSES, CHANNEL_PURPOSE_LABELS,
  type ChannelPurpose, type DiscordPermission, type Feature, type FeatureCategory,
} from '../features/registry.ts';
import { hasPermission, type Interaction, type Reply, type ReplyRow } from '../discord/adapter.ts';
import { WEEKDAY_NAMES, describeHour } from '../jobs/clock.ts';
import { LEAD_CHOICES, describeLead } from './feed.ts';
import { ViaBusyError, ViaError } from '../via/client.ts';
import type { GuildBinding, GuildInstallation, GuildKind } from '../guilds/store.ts';
import { describeWait, type CommandContext, type CommandHandler, type ComponentHandler } from './types.ts';

/**
 * Setup, configuration and removal.
 *
 * Server owner control is a stated goal of the design, so this is a first
 * class part of the bot rather than a settings afterthought. It is five
 * panels, in the order the design lists them: what kind of server this is,
 * what it speaks for, which channels the bot may post in, which features are
 * on, and when the timed posts happen. Every panel is one ephemeral message that is edited in place, so a
 * manager sees one panel rather than a column of them, and nobody else in the
 * server sees any of it.
 *
 * Two decisions are not the bot's to make. Whether a person may run any of
 * this is Discord's, through the Manage Server permission, because the person
 * who manages an organization's server is often not on its board and setting
 * the bot up should not require them to be. Whether a server may be bound to
 * an organization is the web platform's, because binding is a claim about who
 * the server speaks for, and the bot asks rather than deciding.
 */

const configureFeature = featureById('setup.configure');
const removeFeature = featureById('setup.remove');

export const NOT_A_MANAGER_MESSAGE =
  'Setting the bot up in a server needs the Manage Server permission, which this Discord account does not have here. Ask a server manager to run this command.';

export const GUILD_ONLY_MESSAGE =
  'This command sets the bot up in a server, so it has to be run inside the server you want to set up.';

export const NOT_LINKED_TO_BIND_MESSAGE =
  'Binding this server to an organization needs a VIA account, because VIA decides who may speak for an organization. Please link this Discord account and then run setup again.';

export const UNREACHABLE_MESSAGE =
  'VIA is not answering right now, so nothing has been changed. Please try again in a few minutes.';

export const DONE_MESSAGE =
  'Setup is finished. Run the config command at any time to change any of these answers.';

/** The button that sends a manager who has no VIA account to the link command. */
const LINK_ROW: ReplyRow = {
  kind: 'row',
  components: [{ kind: 'button', style: 'primary', label: 'Link my account', customId: 'identity:link' }],
};

/** The panels, named as the step buttons name them. */
export type SetupStep = 'kind' | 'binding' | 'channels' | 'features' | 'timing' | 'menu' | 'done';

/** What a panel needs to know about the server it is drawn for. */
export interface PanelState {
  installation: GuildInstallation;
  channels: Partial<Record<ChannelPurpose, string>>;
  followedRsos: number[];
  /** The permissions the bot itself holds here, which decide what can work. */
  permissions: readonly DiscordPermission[];
}

/**
 * How Discord writes a permission in its own settings screen, so that a
 * manager reading "Send Messages" can go and find the switch by that name.
 */
export function permissionName(permission: DiscordPermission): string {
  return permission.replace(/([a-z])([A-Z])/g, '$1 $2').replace('Guild', 'Server');
}

/** How a channel purpose is written, which the registry keeps beside the purposes. */
export const PURPOSE_LABELS = CHANNEL_PURPOSE_LABELS;

/** How a category of feature is written at the head of its page. */
const CATEGORY_LABELS: Record<FeatureCategory, string> = {
  command: 'Commands',
  proactive: 'Proactive posts',
  roles: 'Roles',
  administration: 'Administration',
};

/** What each page of the features panel is about, for the menu that turns to it. */
const CATEGORY_SUMMARIES: Record<FeatureCategory, string> = {
  command: 'What people can ask the bot for.',
  proactive: 'What the bot posts on its own.',
  roles: 'The Discord roles the bot gives out.',
  administration: 'Setting the bot up, and running your events from Discord.',
};

export const CATEGORY_ORDER: FeatureCategory[] = ['command', 'proactive', 'roles', 'administration'];

/**
 * Why a feature cannot work here, or null when nothing stops it.
 *
 * Two things stop a feature: a purpose it posts to that no channel is bound
 * to, and a permission the bot was not given. Both are the server's to fix,
 * and both are said in the panel rather than discovered when the feature
 * silently posts nothing.
 */
export function blockedReason(
  feature: Feature,
  state: { channels: Partial<Record<ChannelPurpose, string>>; permissions: readonly DiscordPermission[] },
): string | null {
  const missingChannel = feature.channelPurposes.find(purpose => !state.channels[purpose]);
  if (missingChannel) {
    return `no channel is bound to ${PURPOSE_LABELS[missingChannel]}`;
  }
  const missingPermission = feature.requiredPermissions.find(permission =>
    !state.permissions.includes(permission) && !state.permissions.includes('Administrator'));
  if (missingPermission) {
    // The sentence this is spliced into already says where, so the reason
    // does not say it a second time.
    return `the bot does not have the ${permissionName(missingPermission)} permission`;
  }
  return null;
}

function stepButton(label: string, step: SetupStep, style: 'primary' | 'secondary' = 'secondary') {
  return { kind: 'button' as const, style, label, customId: `setup:step:${step}` };
}

/** How a binding reads in a sentence. */
function describeBinding(installation: GuildInstallation, rsoName: string | null): string {
  if (installation.binding === 'all') return 'every organization in ECE';
  if (installation.binding === 'set') return 'a chosen set of organizations';
  if (installation.binding === 'rso') return rsoName ?? 'one organization';
  return 'nothing yet';
}

/** The panel that asks what kind of server this is. */
function kindPanel(state: PanelState): Reply {
  return {
    content: [
      '**Step 1 of 5: what kind of server is this?**',
      '',
      'An organization server belongs to one organization and speaks for it. A community server is a wider space where students from several organizations read about what is coming up.',
    ].join('\n'),
    components: [
      {
        kind: 'row',
        components: [{
          kind: 'select',
          selectKind: 'string',
          customId: 'setup:kind',
          placeholder: 'Choose what kind of server this is',
          options: [
            {
              label: 'An organization server',
              value: 'rso',
              description: 'This server belongs to one organization.',
              selected: state.installation.kind === 'rso',
            },
            {
              label: 'A community server',
              value: 'community',
              description: 'This server is a wider space across ECE.',
              selected: state.installation.kind === 'community',
            },
          ],
        }],
      },
      { kind: 'row', components: [stepButton('Organizations', 'binding'), stepButton('Close', 'done')] },
    ],
  };
}

/** The panel that asks what the server speaks for. */
function bindingPanel(state: PanelState, rsoName: string | null): Reply {
  return {
    content: [
      '**Step 2 of 5: which organizations does this server follow?**',
      '',
      `This server currently follows ${describeBinding(state.installation, rsoName)}.`,
      '',
      "Binding a server to one organization needs a VIA account on that organization's board, because it is a claim about who this server speaks for. Following all of ECE or a chosen set needs nothing beyond the Manage Server permission.",
    ].join('\n'),
    components: [
      {
        kind: 'row',
        components: [{
          kind: 'select',
          selectKind: 'string',
          customId: 'setup:binding',
          placeholder: 'Choose what this server follows',
          options: [
            {
              label: 'One organization',
              value: 'rso',
              description: 'This server speaks for one organization.',
              selected: state.installation.binding === 'rso',
            },
            {
              label: 'All of ECE',
              value: 'all',
              description: 'Everything from every organization.',
              selected: state.installation.binding === 'all',
            },
            {
              label: 'A chosen set of organizations',
              value: 'set',
              description: 'Only the organizations you pick.',
              selected: state.installation.binding === 'set',
            },
          ],
        }],
      },
      {
        kind: 'row',
        components: [stepButton('Back', 'kind'), stepButton('Channels', 'channels'), stepButton('Close', 'done')],
      },
    ],
  };
}

/** How many entries a Discord menu holds, which bounds the organization menus. */
const MAX_MENU_OPTIONS = 25;

/** The menu of organizations to bind this server to, or to follow. */
function rsoMenuPanel(options: {
  heading: string;
  explanation: string;
  customId: string;
  rsos: { rsoId: number; name: string }[];
  chosen: number[];
  multiple: boolean;
}): Reply {
  const shown = options.rsos.slice(0, MAX_MENU_OPTIONS);
  const lines = [options.heading, '', options.explanation];
  if (options.rsos.length > shown.length) {
    // What to do about a menu that will not hold every organization depends on
    // which question is being answered. The organization option on the setup
    // command binds this server to one organization, which is not what
    // somebody choosing a set of organizations to follow is doing.
    lines.push('', options.multiple
      ? `Discord shows at most ${MAX_MENU_OPTIONS} organizations in one menu. Choose from these for now, and run the config command again to add more.`
      : `Discord shows at most ${MAX_MENU_OPTIONS} organizations in one menu, so the rest are not listed here. Run the setup command with the organization option to reach any of them by name.`);
  }

  if (shown.length === 0) {
    return {
      content: [options.heading, '', 'VIA has no organizations to choose from right now.'].join('\n'),
      components: [{ kind: 'row', components: [stepButton('Back', 'binding')] }],
    };
  }

  return {
    content: lines.join('\n'),
    components: [
      {
        kind: 'row',
        components: [{
          kind: 'select',
          selectKind: 'string',
          customId: options.customId,
          placeholder: options.multiple ? 'Choose the organizations to follow' : 'Choose the organization',
          minValues: 1,
          maxValues: options.multiple ? shown.length : 1,
          options: shown.map(rso => ({
            label: rso.name,
            value: String(rso.rsoId),
            selected: options.chosen.includes(rso.rsoId),
          })),
        }],
      },
      { kind: 'row', components: [stepButton('Back', 'binding'), stepButton('Channels', 'channels')] },
    ],
  };
}

/** The panel that binds a channel to each purpose the bot posts to. */
function channelsPanel(state: PanelState, purpose: ChannelPurpose | null): Reply {
  const lines = [
    '**Step 3 of 5: which channels may the bot post in?**',
    '',
    'The bot posts nothing at all until a channel is bound to a purpose. Choose a purpose to bind a channel to it.',
    '',
  ];
  for (const one of CHANNEL_PURPOSES) {
    const channelId = state.channels[one];
    lines.push(`- ${PURPOSE_LABELS[one]}: ${channelId ? `<#${channelId}>` : 'no channel bound'}`);
  }

  const rows: ReplyRow[] = [{
    kind: 'row',
    components: [{
      kind: 'select',
      selectKind: 'string',
      customId: 'setup:purpose',
      placeholder: 'Choose a purpose to bind a channel to',
      options: CHANNEL_PURPOSES.map(one => ({
        label: PURPOSE_LABELS[one],
        value: one,
        selected: one === purpose,
      })),
    }],
  }];

  if (purpose) {
    rows.push({
      kind: 'row',
      components: [{
        kind: 'select',
        selectKind: 'channel',
        customId: `setup:channel:${purpose}`,
        placeholder: `Choose the channel for ${PURPOSE_LABELS[purpose]}`,
      }],
    });
    if (state.channels[purpose]) {
      rows.push({
        kind: 'row',
        components: [{
          kind: 'button',
          style: 'danger',
          label: 'Unbind this purpose',
          customId: `setup:unbind:${purpose}`,
        }],
      });
    }
  }

  rows.push({
    kind: 'row',
    components: [stepButton('Back', 'binding'), stepButton('Features', 'features'), stepButton('Close', 'done')],
  });

  return { content: lines.join('\n'), components: rows };
}

export interface FeatureListState {
  features: readonly Feature[];
  /** Whether each feature is on here, by identifier. */
  enabled: Record<string, boolean>;
  channels: Partial<Record<ChannelPurpose, string>>;
  permissions: readonly DiscordPermission[];
  /** Which category the page being drawn is about. */
  category: FeatureCategory;
}

/**
 * One page of the features panel.
 *
 * The registry has more features than Discord will carry in one message or
 * offer in one menu, so the panel is one page per category: a menu that turns
 * to another page, a line per feature on this page saying whether it is on and
 * what stops it when something does, and a menu that switches one of them.
 * What each feature does is written on the entry in that second menu, which is
 * where Discord has room for a sentence beside a name.
 */
export function renderFeatureList(state: FeatureListState): Reply {
  const inCategory = state.features.filter(feature => feature.category === state.category);

  const lines = [
    '**Step 4 of 5: features**',
    '',
    'Choose a category to see what is in it, then choose a feature to switch it on or off. The feature menu says what each feature does, and a feature that cannot work says why here.',
    '',
    `**${CATEGORY_LABELS[state.category]}**`,
  ];

  if (inCategory.length === 0) {
    lines.push('There is nothing in this category yet.');
  }
  for (const feature of inCategory) {
    const on = state.enabled[feature.id] ?? feature.defaultEnabled;
    const blocked = blockedReason(feature, state);
    // A manager reads what the feature does. The identifier is how the bot
    // keys its own rows and means nothing to the person choosing.
    lines.push(`- ${on ? 'on' : 'off'}: ${feature.summary}`);
    if (blocked) lines.push(`  This cannot work here because ${blocked}.`);
  }

  const rows: ReplyRow[] = [{
    kind: 'row',
    components: [{
      kind: 'select',
      selectKind: 'string',
      customId: 'setup:category',
      placeholder: 'Choose a category of features',
      options: CATEGORY_ORDER.map(category => ({
        label: CATEGORY_LABELS[category],
        value: category,
        description: CATEGORY_SUMMARIES[category],
        selected: category === state.category,
      })),
    }],
  }];

  if (inCategory.length > 0) {
    rows.push({
      kind: 'row',
      components: [{
        kind: 'select',
        selectKind: 'string',
        customId: 'setup:feature',
        placeholder: 'Choose a feature to switch on or off',
        options: inCategory.slice(0, MAX_MENU_OPTIONS).map(feature => {
          const on = state.enabled[feature.id] ?? feature.defaultEnabled;
          return {
            // Discord allows a hundred characters on a label, so a long
            // summary is cut there and given in full in the description
            // underneath it.
            label: `${on ? 'Switch off' : 'Switch on'}: ${feature.summary}`.slice(0, 100),
            value: feature.id,
            description: feature.summary,
          };
        }),
      }],
    });
  }

  rows.push({
    kind: 'row',
    components: [
      stepButton('Back', 'channels'),
      stepButton('Timing', 'timing'),
      stepButton('Done', 'done', 'primary'),
    ],
  });

  return { content: lines.join('\n'), components: rows };
}

/**
 * The panel that says when the timed posts happen: the day and the hour of the
 * weekly digest, how far ahead the day of reminders are posted, and whether
 * each digest is pinned and the one before it unpinned.
 *
 * Every one of these has a default that works, which is why it is the last
 * step rather than the first: a manager who closes setup at step four still
 * gets a digest on Sunday evening with an hour of notice before each event.
 */
export function timingPanel(state: PanelState): Reply {
  const { installation } = state;
  const lines = [
    '**Step 5 of 5: when the timed posts happen**',
    '',
    `The weekly digest is posted on ${WEEKDAY_NAMES[installation.digestDay]} at ${describeHour(installation.digestHour)}, on the campus clock.`,
    `The day of reminders are posted ${describeLead(installation.reminderLeadMinutes)} before each event.`,
    `Each digest is ${installation.digestPinned ? 'pinned, and the one before it unpinned' : 'not pinned'}.`,
    '',
    'These matter only for the features that use them, so a server with the weekly digest switched off can leave them as they are.',
  ];

  return {
    content: lines.join('\n'),
    components: [
      {
        kind: 'row',
        components: [{
          kind: 'select',
          selectKind: 'string',
          customId: 'setup:digestday',
          placeholder: 'Choose the day the weekly digest is posted on',
          options: WEEKDAY_NAMES.map((name, day) => ({
            label: name,
            value: String(day),
            selected: day === installation.digestDay,
          })),
        }],
      },
      {
        kind: 'row',
        components: [{
          kind: 'select',
          selectKind: 'string',
          customId: 'setup:digesthour',
          placeholder: 'Choose the hour the weekly digest is posted at',
          options: Array.from({ length: 24 }, (_unused, hour) => ({
            label: describeHour(hour),
            value: String(hour),
            selected: hour === installation.digestHour,
          })),
        }],
      },
      {
        kind: 'row',
        components: [{
          kind: 'select',
          selectKind: 'string',
          customId: 'setup:lead',
          placeholder: 'Choose how far ahead the day of reminders are posted',
          options: LEAD_CHOICES.map(choice => ({
            label: choice.label,
            value: String(choice.minutes),
            selected: choice.minutes === installation.reminderLeadMinutes,
          })),
        }],
      },
      {
        kind: 'row',
        components: [
          {
            kind: 'button',
            style: installation.digestPinned ? 'primary' : 'secondary',
            label: installation.digestPinned ? 'Stop pinning the digest' : 'Pin each digest',
            customId: 'setup:pinned',
          },
          stepButton('Back', 'features'),
          stepButton('Done', 'done', 'primary'),
        ],
      },
    ],
  };
}

/** The configuration menu, which is every panel reachable from one place. */
function menuPanel(state: PanelState, rsoName: string | null): Reply {
  const lines = ['**How the bot is set up in this server**', ''];

  if (!state.installation.isSetUp) {
    lines.push('This server has not been set up yet, so the bot answers commands and posts nothing.', '');
  }

  lines.push(`Kind of server: ${state.installation.kind === 'rso' ? 'an organization server'
    : state.installation.kind === 'community' ? 'a community server' : 'not chosen yet'}`);
  lines.push(`Follows: ${describeBinding(state.installation, rsoName)}`);
  if (state.installation.binding === 'set') {
    lines.push(`Organizations followed: ${state.followedRsos.length}`);
  }
  lines.push('');
  for (const purpose of CHANNEL_PURPOSES) {
    const channelId = state.channels[purpose];
    lines.push(`- ${PURPOSE_LABELS[purpose]}: ${channelId ? `<#${channelId}>` : 'no channel bound'}`);
  }
  lines.push('');
  lines.push(`Weekly digest: ${WEEKDAY_NAMES[state.installation.digestDay]} at ${describeHour(state.installation.digestHour)}, ${state.installation.digestPinned ? 'pinned' : 'not pinned'}`);
  lines.push(`Day of reminders: ${describeLead(state.installation.reminderLeadMinutes)} before each event`);

  return {
    content: lines.join('\n'),
    components: [
      {
        kind: 'row',
        components: [
          stepButton('Kind of server', 'kind'),
          stepButton('Organizations', 'binding'),
          stepButton('Channels', 'channels'),
          stepButton('Features', 'features'),
          stepButton('Timing', 'timing'),
        ],
      },
      { kind: 'row', components: [stepButton('Close', 'done')] },
    ],
  };
}

/** Read everything a panel needs about the server, creating the row if it is missing. */
async function readState(interaction: Interaction, context: CommandContext): Promise<PanelState> {
  const guildId = interaction.guildId!;
  let installation = await context.guilds.getInstallation(guildId);
  if (!installation) {
    // A server can reach setup without the bot having seen a join event, after
    // an outage or a restart, and a manager should not have to reinvite the
    // bot to fix that.
    await context.guilds.createInstallation(guildId, interaction.userId);
    installation = (await context.guilds.getInstallation(guildId))!;
  }
  return {
    installation,
    channels: await context.guilds.listChannels(guildId),
    followedRsos: await context.guilds.listFollowedRsos(guildId),
    permissions: interaction.applicationPermissions,
  };
}

/** The name of the organization a server is bound to, when it is bound to one. */
async function boundRsoName(state: PanelState, context: CommandContext): Promise<string | null> {
  if (state.installation.binding !== 'rso' || state.installation.rsoId === null) return null;
  const rsos = await context.via.listRsos();
  return rsos.find(rso => rso.rsoId === state.installation.rsoId)?.name ?? null;
}

/** Everything a person reads when the web platform refused or did not answer. */
function answerFor(err: unknown): Reply {
  if (err instanceof ViaBusyError) {
    return { content: `VIA is busy right now. Please try again ${describeWait(err.retryAfterSeconds)}.` };
  }
  if (err instanceof ViaError) return { content: UNREACHABLE_MESSAGE };
  throw err;
}

/**
 * The panel for a named step, read fresh from the server's rows. The features
 * panel is one page per category, and the page it opens on is the first
 * category, which is the commands, unless the caller names another.
 */
async function panelFor(
  step: SetupStep,
  interaction: Interaction,
  context: CommandContext,
  category: FeatureCategory = CATEGORY_ORDER[0]!,
): Promise<Reply> {
  const state = await readState(interaction, context);

  if (step === 'done') return { content: DONE_MESSAGE, components: [] };
  if (step === 'kind') return kindPanel(state);
  if (step === 'binding') return bindingPanel(state, await boundRsoName(state, context));
  if (step === 'channels') return channelsPanel(state, null);
  if (step === 'timing') return timingPanel(state);
  if (step === 'features') {
    return renderFeatureList({
      features: allFeatures,
      enabled: await context.guilds.listFeatureChanges(interaction.guildId!),
      channels: state.channels,
      permissions: state.permissions,
      category,
    });
  }
  return menuPanel(state, await boundRsoName(state, context));
}

/**
 * Bind this server to one organization, if VIA agrees that the person may.
 *
 * The refusal is the whole point of asking. A manager who has no VIA account
 * is told to link, and a manager who is not on that board is told who can bind
 * it, because both of them can act on what they are told and neither of them
 * did anything wrong.
 */
async function bindToRso(
  rsoId: number,
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  let rsos;
  try {
    rsos = await context.via.listRsos();
  } catch (err) {
    return answerFor(err);
  }
  const rso = rsos.find(one => one.rsoId === rsoId);
  if (!rso) {
    return { content: 'VIA does not have an organization with that identifier, so nothing has been bound.' };
  }

  try {
    await context.via.confirmBinding(rsoId, interaction.userId);
  } catch (err) {
    if (err instanceof ViaError && err.code === 'not_linked') {
      return { content: NOT_LINKED_TO_BIND_MESSAGE, components: [LINK_ROW] };
    }
    if (err instanceof ViaError && err.code === 'forbidden') {
      return {
        content: `VIA will not let this Discord account bind a server to ${rso.name}. Only a board member of ${rso.name}, or a VIA global administrator, can do that. Ask somebody on the board to run setup, or ask them to add you to the board on viaillinois.com.`,
      };
    }
    return answerFor(err);
  }

  // The web platform has just confirmed that this person may speak for the
  // organization, which is exactly the person the daily role reconciliation
  // has to read its members as, so the server writes down who they were.
  await context.guilds.setBinding(interaction.guildId!, {
    binding: 'rso',
    rsoId,
    boundBy: interaction.userId,
  });
  const state = await readState(interaction, context);
  const panel = channelsPanel(state, null);
  return { ...panel, content: `This server is now bound to ${rso.name}.\n\n${panel.content}` };
}

/** Switch one feature on or off, refusing to switch on one that cannot work. */
export async function toggleFeature(
  feature: Feature,
  guildId: string,
  context: CommandContext,
  state: { channels: Partial<Record<ChannelPurpose, string>>; permissions: readonly DiscordPermission[] },
): Promise<Reply> {
  // The state is read from the server's changes rather than through the
  // registry lookup, so that a feature can be reasoned about here before the
  // registry has it, which is what the tests for the proactive features do.
  const changes = await context.guilds.listFeatureChanges(guildId);
  const enabled = changes[feature.id] ?? feature.defaultEnabled;

  if (!enabled) {
    const blocked = blockedReason(feature, state);
    if (blocked) {
      return {
        content: `${feature.summary}\n\nThis cannot be switched on here because ${blocked}. Fix that first and then switch it on.`,
      };
    }
  }

  await context.guilds.setFeatureEnabled(guildId, feature.id, !enabled);
  return {
    content: `${feature.summary}\n\nThis is now ${enabled ? 'off' : 'on'} in this server.`,
  };
}

/**
 * The answers each menu offers, checked rather than trusted.
 *
 * What comes back from a menu is whatever arrived at the gateway, and these
 * three go straight into columns that have room for nothing else. A value the
 * menu never offered puts the panel back rather than writing a row nothing can
 * read afterwards.
 */
const GUILD_KINDS: readonly GuildKind[] = ['rso', 'community'];
const GUILD_BINDINGS: readonly GuildBinding[] = ['rso', 'all', 'set'];

/** The channel purpose a menu or an identifier names, or nothing for anything else. */
function purposeOf(value: string): ChannelPurpose | null {
  return CHANNEL_PURPOSES.find(one => one === value) ?? null;
}

/** Whether the person may run any of this, and the sentence they read when they may not. */
function refuseUnlessManager(interaction: Interaction): Reply | null {
  if (!interaction.guildId) return { content: GUILD_ONLY_MESSAGE, components: [] };
  if (!hasPermission(interaction, 'ManageGuild')) return { content: NOT_A_MANAGER_MESSAGE, components: [] };
  return null;
}

export const setupCommand: CommandHandler = {
  featureId: configureFeature.id,
  name: `via ${configureFeature.command!.name}`,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const refusal = refuseUnlessManager(interaction);
    if (refusal) return refusal;

    // The organization option is the way to reach an organization Discord's
    // menu cannot hold, and it completes as the manager types.
    const named = interaction.options.rso;
    if (named !== undefined) {
      const rsoId = /^\d+$/.test(String(named)) ? Number(named) : null;
      if (rsoId === null) {
        return { content: 'Please choose an organization from the list Discord offers as you type, rather than typing a name of your own.' };
      }
      await readState(interaction, context);
      return bindToRso(rsoId, interaction, context);
    }

    return panelFor('kind', interaction, context);
  },

  /**
   * The completion behind the organization option is the same question the
   * command refuses, asked one keystroke at a time. Somebody who may not run
   * setup is offered nothing rather than the organization list, and no call is
   * made to the web platform on their behalf.
   */
  async autocomplete(interaction: Interaction, context: CommandContext) {
    if (refuseUnlessManager(interaction)) return [];
    if (interaction.focusedOption?.name !== 'rso') return [];
    const typed = (interaction.focusedOption.value ?? '').trim().toLowerCase();
    const rsos = await context.via.listRsos();
    return rsos
      .filter(rso => !typed || rso.name.toLowerCase().includes(typed))
      .slice(0, MAX_MENU_OPTIONS)
      .map(rso => ({ name: rso.name, value: String(rso.rsoId) }));
  },
};

/** The same panels, opened at the menu rather than at the first question. */
export const configCommand: CommandHandler = {
  featureId: configureFeature.id,
  name: `via ${configureFeature.command!.alternateNames![0]!.name}`,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const refusal = refuseUnlessManager(interaction);
    if (refusal) return refusal;
    return panelFor('menu', interaction, context);
  },

  autocomplete: setupCommand.autocomplete,
};

/**
 * Everything a panel can be pressed or chosen. One handler answers all of it,
 * because every identifier begins with the same prefix and every answer edits
 * the same panel.
 */
export const setupComponent: ComponentHandler = {
  featureId: configureFeature.id,
  prefix: 'setup:',
  updateInPlace: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const refusal = refuseUnlessManager(interaction);
    if (refusal) return refusal;

    const guildId = interaction.guildId!;
    const customId = interaction.customId ?? '';
    const chosen = interaction.values[0] ?? '';

    if (customId === REMOVE_BUTTON) return removeEverything(interaction, context);

    if (customId.startsWith('setup:step:')) {
      return panelFor(customId.slice('setup:step:'.length) as SetupStep, interaction, context);
    }

    if (customId === 'setup:kind') {
      await readState(interaction, context);
      // What a menu sends back is whatever arrived, so it is checked against
      // the answers the menu actually offers rather than trusted into a
      // column that has no room for anything else.
      const kind = GUILD_KINDS.find(one => one === chosen);
      if (!kind) return panelFor('kind', interaction, context);
      await context.guilds.setKind(guildId, kind);
      return panelFor('binding', interaction, context);
    }

    if (customId === 'setup:binding') {
      const state = await readState(interaction, context);
      const binding = GUILD_BINDINGS.find(one => one === chosen);
      if (!binding) return panelFor('binding', interaction, context);

      if (binding === 'all') {
        await context.guilds.setBinding(guildId, { binding: 'all' });
        await context.guilds.setFollowedRsos(guildId, []);
        return panelFor('channels', interaction, context);
      }

      let rsos;
      try {
        rsos = await context.via.listRsos();
      } catch (err) {
        return answerFor(err);
      }

      if (binding === 'set') {
        return rsoMenuPanel({
          heading: '**Step 2 of 5: which organizations does this server follow?**',
          explanation: 'Choose every organization this server should hear about. Choosing again replaces the whole set.',
          customId: 'setup:followed',
          rsos,
          chosen: state.followedRsos,
          multiple: true,
        });
      }

      return rsoMenuPanel({
        heading: '**Step 2 of 5: which organization does this server speak for?**',
        explanation: "Binding a server to an organization needs a VIA account on that organization's board, so VIA is asked to confirm it when you choose.",
        customId: 'setup:bindrso',
        rsos,
        chosen: state.installation.rsoId === null ? [] : [state.installation.rsoId],
        multiple: false,
      });
    }

    if (customId === 'setup:followed') {
      await readState(interaction, context);
      const rsoIds = interaction.values.map(Number).filter(Number.isInteger);
      await context.guilds.setBinding(guildId, { binding: 'set' });
      await context.guilds.setFollowedRsos(guildId, rsoIds);
      return panelFor('channels', interaction, context);
    }

    if (customId === 'setup:bindrso') {
      await readState(interaction, context);
      const rsoId = /^\d+$/.test(chosen) ? Number(chosen) : null;
      if (rsoId === null) return panelFor('binding', interaction, context);
      return bindToRso(rsoId, interaction, context);
    }

    if (customId === 'setup:digestday' || customId === 'setup:digesthour') {
      const state = await readState(interaction, context);
      const value = /^\d+$/.test(chosen) ? Number(chosen) : null;
      const day = customId === 'setup:digestday' ? value : state.installation.digestDay;
      const hour = customId === 'setup:digesthour' ? value : state.installation.digestHour;
      if (day === null || hour === null) return panelFor('timing', interaction, context);

      await context.guilds.setDigestSchedule(guildId, day, hour);
      return panelFor('timing', interaction, context);
    }

    if (customId === 'setup:lead') {
      await readState(interaction, context);
      const minutes = /^\d+$/.test(chosen) ? Number(chosen) : null;
      if (minutes === null) return panelFor('timing', interaction, context);
      await context.guilds.setReminderLeadMinutes(guildId, minutes);
      return panelFor('timing', interaction, context);
    }

    if (customId === 'setup:pinned') {
      const state = await readState(interaction, context);
      await context.guilds.setDigestPinned(guildId, !state.installation.digestPinned);
      return panelFor('timing', interaction, context);
    }

    if (customId === 'setup:purpose') {
      const state = await readState(interaction, context);
      return channelsPanel(state, purposeOf(chosen));
    }

    if (customId.startsWith('setup:channel:')) {
      const purpose = purposeOf(customId.slice('setup:channel:'.length));
      if (!purpose) return panelFor('channels', interaction, context);
      await readState(interaction, context);
      await context.guilds.bindChannel(guildId, purpose, chosen);
      const state = await readState(interaction, context);
      const panel = channelsPanel(state, purpose);
      return {
        ...panel,
        content: `The bot will post ${PURPOSE_LABELS[purpose]} in <#${chosen}>.\n\n${panel.content}`,
      };
    }

    if (customId.startsWith('setup:unbind:')) {
      const purpose = purposeOf(customId.slice('setup:unbind:'.length));
      if (!purpose) return panelFor('channels', interaction, context);
      await readState(interaction, context);
      await context.guilds.unbindChannel(guildId, purpose);
      const state = await readState(interaction, context);
      const panel = channelsPanel(state, purpose);
      return {
        ...panel,
        content: `The bot will no longer post ${PURPOSE_LABELS[purpose]} anywhere.\n\n${panel.content}`,
      };
    }

    if (customId === 'setup:category') {
      const category = CATEGORY_ORDER.includes(chosen as FeatureCategory)
        ? (chosen as FeatureCategory)
        : CATEGORY_ORDER[0]!;
      return panelFor('features', interaction, context, category);
    }

    if (customId === 'setup:feature') {
      const state = await readState(interaction, context);
      let feature: Feature;
      try {
        feature = featureById(chosen);
      } catch {
        return panelFor('features', interaction, context);
      }
      const answer = await toggleFeature(feature, guildId, context, state);
      // The panel comes back on the page the feature belongs to, because that
      // is the page the manager was reading when they switched it.
      const panel = await panelFor('features', interaction, context, feature.category);
      return { ...panel, content: `${answer.content}\n\n${panel.content}` };
    }

    return panelFor('menu', interaction, context);
  },
};

/** How many of something went, written the way a person counts. */
function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The button that actually removes everything, once a manager has read what will go. */
export const REMOVE_BUTTON = 'setup:removeall';

export const NOTHING_TO_REMOVE_MESSAGE =
  'The bot has nothing set up in this server, so there was nothing to remove.';

/**
 * What a manager reads before anything is deleted.
 *
 * Removal deletes every scheduled event the bot created in the server, unpins
 * the message it pinned, and deletes every row it holds for the server, and
 * none of that can be undone from Discord. So it is asked for twice, and the
 * first answer says what will go rather than only that something will.
 */
export function removalConfirmation(): Reply {
  return {
    content: [
      '**Remove the bot from this server?**',
      '',
      'This deletes every scheduled event the bot created here, unpins the message it pinned, and deletes every row it holds for this server: the kind of server it is, the organizations it follows, the channels it posts in, the features that are on, and the roles it was mapped to.',
      '',
      'Nothing about the people who used the bot here is deleted, because their links, follows and reminders are theirs rather than this server. None of this can be undone, so setting the bot up again means answering the setup panels again.',
    ].join('\n'),
    components: [{
      kind: 'row',
      components: [{
        kind: 'button',
        style: 'danger',
        label: 'Remove everything',
        customId: REMOVE_BUTTON,
      }],
    }],
  };
}

/**
 * Remove everything, which is what the confirmation button does.
 *
 * The headline says what has actually happened. The bot is still in the
 * server, because leaving it is Discord's own action and a server manager
 * takes it from the server settings, and a headline that said the bot had been
 * removed would leave a manager wondering why it is still in the member list.
 */
export async function removeEverything(
  interaction: Interaction,
  context: CommandContext,
): Promise<Reply> {
  const guildId = interaction.guildId!;

  // Everything the bot posted into the server goes before the rows that say
  // where it posted them, because the rows are what says where to look.
  const cleared = context.removeGuildPresence
    ? await context.removeGuildPresence(guildId)
    : null;

  const deleted = await context.guilds.removeGuild(guildId);

  // A hook that cleared nothing is the same as no hook at all here: a server
  // the bot holds no rows for and posted nothing in has nothing to remove,
  // and saying that it has been removed would be a sentence about nothing.
  const clearedSomething = cleared !== null
    && (cleared.scheduledEvents > 0 || cleared.unpinnedMessages > 0);

  if (!deleted.installation && !clearedSomething) {
    return { content: NOTHING_TO_REMOVE_MESSAGE, components: [] };
  }

  const parts = [
    counted(deleted.channels, 'channel binding', 'channel bindings'),
    counted(deleted.followedRsos, 'organization followed', 'organizations followed'),
    counted(deleted.features, 'feature setting', 'feature settings'),
  ];
  if (cleared) {
    parts.unshift(counted(cleared.scheduledEvents, 'scheduled event', 'scheduled events'));
    parts.push(counted(cleared.unpinnedMessages, 'pinned message', 'pinned messages'));
  }

  return {
    content: [
      'The bot no longer posts anything in this server, and every row it held for this server has been deleted. It is still a member of the server, so remove it from the server settings if you want it gone entirely.',
      '',
      `Deleted: ${parts.join(', ')}.`,
      '',
      'Nothing about the people who used the bot here has been deleted, because their links, follows and reminders are theirs rather than this server. Run setup again at any time to start over.',
    ].join('\n'),
    components: [],
  };
}

export const removeCommand: CommandHandler = {
  featureId: removeFeature.id,
  name: `via ${removeFeature.command!.name}`,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const refusal = refuseUnlessManager(interaction);
    if (refusal) return refusal;

    // A server with nothing set up and nothing posted has nothing to confirm,
    // so it is answered rather than asked.
    const installation = await context.guilds.getInstallation(interaction.guildId!);
    if (!installation) return removeEverything(interaction, context);

    return removalConfirmation();
  },
};
