import { featureById } from '../features/registry.ts';
import { hasPermission, type Interaction, type Reply, type ReplyRow } from '../discord/adapter.ts';
import { MAPPED_ROLES, type MappedRole } from '../guilds/store.ts';
import { ROLES_FEATURE } from '../roles/membership.ts';
import type { CommandContext, CommandHandler, ComponentHandler } from './types.ts';

/**
 * Mapping VIA's membership roles to a server's own Discord roles.
 *
 * This is a server manager's decision rather than a board's, because it is
 * about the server's roles rather than about the organization, which is why it
 * sits behind the Manage Server permission like the rest of setup. What the
 * bot needs to carry it out is the Manage Roles permission and a role of its
 * own above the roles it hands out, and the panel says so rather than letting
 * a manager map a role that could never be given.
 *
 * Mapping a role is what asking for this feature means, so the first mapping
 * switches the feature on. A manager who wanted to think about it first can
 * switch it off again from the features panel, and a mapping that is taken
 * away leaves every role already given exactly where it is, which is the same
 * rule as never removing a role the bot did not grant.
 */

const feature = featureById('roles.membership');

export const NOT_A_MANAGER_MESSAGE =
  'Mapping the membership roles needs the Manage Server permission, which this Discord account does not have here. Ask a server manager to run this command.';

export const GUILD_ONLY_MESSAGE =
  'This maps VIA roles to the roles of one server, so it has to be run inside the server you want to map them in.';

export const NOT_BOUND_MESSAGE =
  'This server is not bound to an organization yet, and membership roles are about the members of one organization. Run the setup command, bind this server to your organization, and then come back.';

export const NO_MANAGE_ROLES_MESSAGE =
  'The bot does not have the Manage Roles permission in this server, so it cannot give anybody a role. Grant it in the server settings, and make sure the bot role sits above the roles you map, then run this command again.';

/** The identifiers the panel carries. */
export const ROLES_BUTTON = {
  map: (role: MappedRole) => `roles:map:${role}`,
  unmap: (role: MappedRole) => `roles:unmap:${role}`,
};

/** How each VIA membership role is written for somebody choosing a Discord role for it. */
const ROLE_LABELS: Record<MappedRole, string> = {
  member: 'Members of the organization',
  editor: 'Editors, who can change its events',
  board: 'The board, who run it',
};

/** The panel: what is mapped now, and a menu of the server's roles for each. */
async function panel(interaction: Interaction, context: CommandContext): Promise<Reply> {
  const guildId = interaction.guildId!;
  const mappings = await context.guilds.listRoleMappings(guildId);
  const enabled = await context.guilds.isFeatureEnabled(guildId, ROLES_FEATURE);

  const lines = [
    '**The Discord roles VIA membership gives out here**',
    '',
    'Choose a Discord role for each VIA membership role you want the bot to give out. The bot gives somebody the role their membership says they have, takes back the roles it gave them and they no longer have, and never touches a role it did not give.',
    '',
  ];
  for (const role of MAPPED_ROLES) {
    const roleId = mappings[role];
    lines.push(`- ${ROLE_LABELS[role]}: ${roleId ? `<@&${roleId}>` : 'no Discord role yet'}`);
  }
  lines.push('');
  lines.push(enabled
    ? 'This is on in this server, and the roles are reconciled once a day as well as whenever a membership changes.'
    : 'This is off in this server until you map a role, and mapping one switches it on.');

  const rows: ReplyRow[] = MAPPED_ROLES.map(role => ({
    kind: 'row' as const,
    components: [{
      kind: 'select' as const,
      selectKind: 'role' as const,
      customId: ROLES_BUTTON.map(role),
      placeholder: `Choose the Discord role for ${ROLE_LABELS[role].toLowerCase()}`,
    }],
  }));

  const mapped = MAPPED_ROLES.filter(role => mappings[role]);
  if (mapped.length > 0) {
    rows.push({
      kind: 'row',
      components: mapped.map(role => ({
        kind: 'button' as const,
        style: 'secondary' as const,
        label: `Stop mapping ${role}`,
        customId: ROLES_BUTTON.unmap(role),
      })),
    });
  }

  return { content: lines.join('\n'), components: rows };
}

/** Whether this person and this server can do any of it, and the sentence when they cannot. */
async function refusal(interaction: Interaction, context: CommandContext): Promise<Reply | null> {
  if (!interaction.guildId) return { content: GUILD_ONLY_MESSAGE, components: [] };
  if (!hasPermission(interaction, 'ManageGuild')) return { content: NOT_A_MANAGER_MESSAGE, components: [] };

  const installation = await context.guilds.getInstallation(interaction.guildId);
  if (!installation || installation.binding !== 'rso' || installation.rsoId === null) {
    return { content: NOT_BOUND_MESSAGE, components: [] };
  }
  return null;
}

/** Whether the bot itself can give a role here, which the panel says before anything else. */
function permissionNotice(interaction: Interaction): string | null {
  const held = interaction.applicationPermissions;
  if (held.includes('ManageRoles') || held.includes('Administrator')) return null;
  return NO_MANAGE_ROLES_MESSAGE;
}

export const rolesCommand: CommandHandler = {
  featureId: feature.id,
  name: `via ${feature.command!.name}`,
  ephemeral: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const refused = await refusal(interaction, context);
    if (refused) return refused;

    const missing = permissionNotice(interaction);
    const built = await panel(interaction, context);
    return missing ? { ...built, content: `${missing}\n\n${built.content}` } : built;
  },
};

export const rolesComponent: ComponentHandler = {
  featureId: feature.id,
  prefix: 'roles:',
  updateInPlace: true,

  async run(interaction: Interaction, context: CommandContext): Promise<Reply> {
    const refused = await refusal(interaction, context);
    if (refused) return refused;

    const guildId = interaction.guildId!;
    const customId = interaction.customId ?? '';

    if (customId.startsWith('roles:map:')) {
      const role = customId.slice('roles:map:'.length) as MappedRole;
      const roleId = interaction.values[0];
      if (!MAPPED_ROLES.includes(role) || !roleId) return panel(interaction, context);

      await context.guilds.setRoleMapping(guildId, role, roleId);
      // Mapping a role is what asking for this feature means, so the first
      // mapping switches it on rather than leaving a manager to find a toggle.
      await context.guilds.setFeatureEnabled(guildId, ROLES_FEATURE, true);

      const built = await panel(interaction, context);
      return {
        ...built,
        content: `${ROLE_LABELS[role]} will be given <@&${roleId}>.\n\n${built.content}`,
      };
    }

    if (customId.startsWith('roles:unmap:')) {
      const role = customId.slice('roles:unmap:'.length) as MappedRole;
      if (!MAPPED_ROLES.includes(role)) return panel(interaction, context);

      await context.guilds.unsetRoleMapping(guildId, role);
      const built = await panel(interaction, context);
      return {
        ...built,
        content: `The bot will no longer give a Discord role for ${ROLE_LABELS[role].toLowerCase()}. Every role it has already given stays where it is, because those roles are the server's now.\n\n${built.content}`,
      };
    }

    return panel(interaction, context);
  },
};
