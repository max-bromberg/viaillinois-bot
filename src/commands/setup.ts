import {
  features as allFeatures, featureById, CHANNEL_PURPOSES,
  type ChannelPurpose, type DiscordPermission, type Feature, type FeatureCategory,
} from '../features/registry.ts';
import { hasPermission, type Interaction, type Reply, type ReplyRow } from '../discord/adapter.ts';
import { ViaBusyError, ViaError } from '../via/client.ts';
import type { GuildBinding, GuildInstallation, GuildKind } from '../guilds/store.ts';
import { describeWait, type CommandContext, type CommandHandler, type ComponentHandler } from './types.ts';

/**
 * Setup, configuration and removal.
 *
 * Server owner control is a stated goal of the design, so this is a first
 * class part of the bot rather than a settings afterthought. It is four
 * panels, in the order the design lists them: what kind of server this is,
 * what it speaks for, which channels the bot may post in, and which features
 * are on. Every panel is one ephemeral message that is edited in place, so a
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
export type SetupStep = 'kind' | 'binding' | 'channels' | 'features' | 'menu' | 'done';

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

/** How a channel purpose is written for somebody who has to choose a channel for it. */
export const PURPOSE_LABELS: Record<ChannelPurpose, string> = {
  announcements: 'announcements',
  digest: 'the weekly digest',
  reminders: 'reminders',
  exams: 'exam notices',
  thisweek: 'the this week message',
};

/** How a category of feature is written at the head of its group. */
const CATEGORY_LABELS: Record<FeatureCategory, string> = {
  command: 'Commands',
  proactive: 'Proactive posts',
  roles: 'Roles',
  administration: 'Administration',
};

const CATEGORY_ORDER: FeatureCategory[] = ['command', 'proactive', 'roles', 'administration'];

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
    return `the bot does not have the ${permissionName(missingPermission)} permission here`;
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
      '**Step 1 of 4: what kind of server is this?**',
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
      '**Step 2 of 4: which organizations does this server follow?**',
      '',
      `This server currently follows ${describeBinding(state.installation, rsoName)}.`,
      '',
      'Binding a server to one organization needs a VIA account on that organization board, because it is a claim about who this server speaks for. Following all of ECE or a chosen set needs nothing beyond the Manage Server permission.',
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
    lines.push('', `Discord shows at most ${MAX_MENU_OPTIONS} organizations in one menu, so the rest are not listed here. Run the setup command with the organization option to reach any of them by name.`);
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
    '**Step 3 of 4: which channels may the bot post in?**',
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
}

/**
 * The feature list, grouped by category, each feature showing whether it is on
 * and, when something stops it working, what that is. The menu beneath it
 * toggles one feature, because Discord has no switch of its own and a menu is
 * the nearest thing to a row of them.
 */
export function renderFeatureList(state: FeatureListState): Reply {
  const lines = [
    '**Step 4 of 4: features**',
    '',
    'Choose a feature to switch it on or off. A feature that cannot work says why underneath.',
  ];

  for (const category of CATEGORY_ORDER) {
    const inCategory = state.features.filter(feature => feature.category === category);
    if (inCategory.length === 0) continue;
    lines.push('', `**${CATEGORY_LABELS[category]}**`);
    for (const feature of inCategory) {
      const on = state.enabled[feature.id] ?? feature.defaultEnabled;
      const blocked = blockedReason(feature, state);
      lines.push(`- ${on ? 'on' : 'off'}: ${feature.description}`);
      if (blocked) lines.push(`  This cannot work here because ${blocked}.`);
    }
  }

  const options = state.features.slice(0, MAX_MENU_OPTIONS).map(feature => {
    const on = state.enabled[feature.id] ?? feature.defaultEnabled;
    return {
      label: `${on ? 'Switch off' : 'Switch on'}: ${feature.id}`.slice(0, 100),
      value: feature.id,
      description: feature.description.slice(0, 100),
    };
  });

  const rows: ReplyRow[] = [];
  if (options.length > 0) {
    rows.push({
      kind: 'row',
      components: [{
        kind: 'select',
        selectKind: 'string',
        customId: 'setup:feature',
        placeholder: 'Choose a feature to switch on or off',
        options,
      }],
    });
  }
  rows.push({
    kind: 'row',
    components: [stepButton('Back', 'channels'), stepButton('Done', 'done', 'primary')],
  });

  return { content: lines.join('\n'), components: rows };
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

/** The panel for a named step, read fresh from the server's rows. */
async function panelFor(step: SetupStep, interaction: Interaction, context: CommandContext): Promise<Reply> {
  const state = await readState(interaction, context);

  if (step === 'done') return { content: DONE_MESSAGE, components: [] };
  if (step === 'kind') return kindPanel(state);
  if (step === 'binding') return bindingPanel(state, await boundRsoName(state, context));
  if (step === 'channels') return channelsPanel(state, null);
  if (step === 'features') {
    return renderFeatureList({
      features: allFeatures,
      enabled: await context.guilds.listFeatureChanges(interaction.guildId!),
      channels: state.channels,
      permissions: state.permissions,
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

  await context.guilds.setBinding(interaction.guildId!, { binding: 'rso', rsoId });
  const state = await readState(interaction, context);
  return {
    ...channelsPanel(state, null),
    content: `This server is now bound to ${rso.name}.\n\n${channelsPanel(state, null).content}`,
  };
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
        content: `${feature.description}\n\nThis cannot be switched on here because ${blocked}. Fix that first and then switch it on.`,
      };
    }
  }

  await context.guilds.setFeatureEnabled(guildId, feature.id, !enabled);
  return {
    content: `${feature.description}\n\nThis is now ${enabled ? 'off' : 'on'} in this server.`,
  };
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

  async autocomplete(interaction: Interaction, context: CommandContext) {
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

    if (customId.startsWith('setup:step:')) {
      return panelFor(customId.slice('setup:step:'.length) as SetupStep, interaction, context);
    }

    if (customId === 'setup:kind') {
      await readState(interaction, context);
      await context.guilds.setKind(guildId, chosen as GuildKind);
      return panelFor('binding', interaction, context);
    }

    if (customId === 'setup:binding') {
      const state = await readState(interaction, context);
      const binding = chosen as GuildBinding;

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
          heading: '**Step 2 of 4: which organizations does this server follow?**',
          explanation: 'Choose every organization this server should hear about. Choosing again replaces the whole set.',
          customId: 'setup:followed',
          rsos,
          chosen: state.followedRsos,
          multiple: true,
        });
      }

      return rsoMenuPanel({
        heading: '**Step 2 of 4: which organization does this server speak for?**',
        explanation: 'Binding a server to an organization needs a VIA account on that organization board, so VIA is asked to confirm it when you choose.',
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

    if (customId === 'setup:purpose') {
      const state = await readState(interaction, context);
      return channelsPanel(state, chosen as ChannelPurpose);
    }

    if (customId.startsWith('setup:channel:')) {
      const purpose = customId.slice('setup:channel:'.length) as ChannelPurpose;
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
      const purpose = customId.slice('setup:unbind:'.length) as ChannelPurpose;
      await readState(interaction, context);
      await context.guilds.unbindChannel(guildId, purpose);
      const state = await readState(interaction, context);
      const panel = channelsPanel(state, purpose);
      return {
        ...panel,
        content: `The bot will no longer post ${PURPOSE_LABELS[purpose]} anywhere.\n\n${panel.content}`,
      };
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
      const panel = await panelFor('features', interaction, context);
      return { ...panel, content: `${answer.content}\n\n${panel.content}` };
    }

    return panelFor('menu', interaction, context);
  },
};

/** How many of something went, written the way a person counts. */
function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export const removeCommand: CommandHandler = {
  featureId: removeFeature.id,
  name: `via ${removeFeature.command!.name}`,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const refusal = refuseUnlessManager(interaction);
    if (refusal) return refusal;

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
      return { content: 'The bot has nothing set up in this server, so there was nothing to remove.' };
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
        'The bot has been removed from this server.',
        '',
        `Deleted: ${parts.join(', ')}.`,
        '',
        'Nothing about the people who used the bot here has been deleted, because their links, follows and reminders are theirs rather than this server. Invite the bot again and run setup to start over.',
      ].join('\n'),
    };
  },
};
