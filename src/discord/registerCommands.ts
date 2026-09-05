import {
  ApplicationCommandOptionType, ApplicationCommandType, ApplicationIntegrationType,
  InteractionContextType, Routes, type REST,
} from 'discord.js';
import {
  features as allFeatures,
  type CommandOptionKind, type Feature, type FeatureCommand, type FeatureCommandOption,
  type InteractionContext,
} from '../features/registry.ts';

/**
 * The application commands, built from the feature registry.
 *
 * A change to the registry is a change to the commands, which is the point of
 * having a registry: there is no second list to keep in step. Student
 * commands sit at the top level, so a student types `/events`, and everything
 * for setup and for boards sits under one group, so a manager types
 * `/via setup` and a board member `/via postpone`. Which of the two a command
 * belongs to follows from its tier rather than from a separate declaration.
 *
 * The commands are registered globally, once, at startup. Whether a server
 * has a feature switched on is decided when the command runs, because Discord
 * has no per server view of a global command, and a server that switched a
 * feature off gets a sentence saying so rather than a command that vanishes.
 */

/** The one group everything for setup and for boards sits under. */
export const VIA_GROUP = 'via';

/** What Discord shows beside the group name. */
export const VIA_GROUP_DESCRIPTION = 'Set up VIA in this server and run your organization events.';

/** The tiers whose commands sit under the group rather than at the top level. */
const GROUPED_TIERS = new Set(['editor', 'manager']);

const CONTEXT_VALUES: Record<InteractionContext, InteractionContextType> = {
  guild: InteractionContextType.Guild,
  botDm: InteractionContextType.BotDM,
  privateChannel: InteractionContextType.PrivateChannel,
};

/** The order Discord lists them in, which keeps the built list stable. */
const CONTEXT_ORDER: InteractionContext[] = ['guild', 'botDm', 'privateChannel'];

export interface CommandChoiceJson {
  name: string;
  value: string;
}

export interface CommandOptionJson {
  type: ApplicationCommandOptionType;
  name: string;
  description: string;
  required?: boolean;
  autocomplete?: boolean;
  choices?: CommandChoiceJson[];
  /** A subcommand carries the options of the command it stands for. */
  options?: CommandOptionJson[];
}

export interface CommandJson {
  type: ApplicationCommandType;
  name: string;
  description: string;
  contexts: InteractionContextType[];
  integration_types: ApplicationIntegrationType[];
  options?: CommandOptionJson[];
}

/** The option types Discord numbers, for the kinds a feature may declare. */
const OPTION_TYPES: Record<CommandOptionKind, ApplicationCommandOptionType> = {
  string: ApplicationCommandOptionType.String,
  boolean: ApplicationCommandOptionType.Boolean,
};

/**
 * Any feature that declares a command becomes one, whichever category it is
 * in. Setup and removal are administration rather than command, because that
 * is what a server manager reads them as in the setup panel, and they are
 * still typed as commands.
 */
function commandFeatures(features: readonly Feature[]): Feature[] {
  return features.filter(feature => feature.command);
}

/**
 * The names one feature is reached by, the declared one first. A feature with
 * two names becomes two commands over one implementation, which is how setup
 * and config open the same panels.
 */
function namesOf(command: FeatureCommand): { name: string; description: string }[] {
  return [
    { name: command.name, description: command.description },
    ...(command.alternateNames ?? []).map(alternate => ({ ...alternate })),
  ];
}

function optionJson(option: FeatureCommandOption): CommandOptionJson {
  const built: CommandOptionJson = {
    type: OPTION_TYPES[option.kind],
    name: option.name,
    description: option.description,
    required: Boolean(option.required),
  };
  if (option.autocomplete) built.autocomplete = true;
  if (option.choices) built.choices = option.choices.map(choice => ({ ...choice }));
  return built;
}

function optionsJson(command: FeatureCommand): CommandOptionJson[] | undefined {
  if (!command.options || command.options.length === 0) return undefined;

  // Discord refuses a whole command whose required options do not come first,
  // and refuses it at startup with a message about an option index. Catching
  // it here names the command instead.
  const firstOptional = command.options.findIndex(option => !option.required);
  const lastRequired = command.options.map(option => Boolean(option.required)).lastIndexOf(true);
  if (firstOptional !== -1 && lastRequired > firstOptional) {
    throw new Error(`The command ${command.name} has a required option after an optional one, which Discord refuses.`);
  }

  return command.options.map(optionJson);
}

function contextsOf(features: readonly Feature[]): InteractionContextType[] {
  const named = new Set<InteractionContext>();
  for (const feature of features) for (const context of feature.contexts) named.add(context);
  return CONTEXT_ORDER.filter(context => named.has(context)).map(context => CONTEXT_VALUES[context]);
}

/**
 * A feature at the read or linked tier can be used by a person who installed
 * the bot to their own account, in a server that has not installed it. A
 * feature that acts on a server cannot, because there is no server to act on.
 */
function integrationTypesOf(features: readonly Feature[]): ApplicationIntegrationType[] {
  const userInstallable = features.every(feature => feature.tier === 'read' || feature.tier === 'linked');
  return userInstallable
    ? [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall]
    : [ApplicationIntegrationType.GuildInstall];
}

/** Build the whole global command list from the registry. */
export function buildCommands(features: readonly Feature[] = allFeatures): CommandJson[] {
  const declared = commandFeatures(features);

  const seen = new Set<string>();
  for (const feature of declared) {
    for (const { name } of namesOf(feature.command!)) {
      if (seen.has(name)) throw new Error(`There is more than one command named ${name}.`);
      seen.add(name);
    }
  }

  const topLevel = declared.filter(feature => !GROUPED_TIERS.has(feature.tier));
  const grouped = declared.filter(feature => GROUPED_TIERS.has(feature.tier));

  const commands: CommandJson[] = topLevel.flatMap(feature =>
    namesOf(feature.command!).map(({ name, description }) => {
      const command: CommandJson = {
        type: ApplicationCommandType.ChatInput,
        name,
        description,
        contexts: contextsOf([feature]),
        integration_types: integrationTypesOf([feature]),
      };
      const options = optionsJson(feature.command!);
      if (options) command.options = options;
      return command;
    }));

  if (grouped.length > 0) {
    commands.push({
      type: ApplicationCommandType.ChatInput,
      name: VIA_GROUP,
      description: VIA_GROUP_DESCRIPTION,
      contexts: contextsOf(grouped),
      integration_types: integrationTypesOf(grouped),
      options: grouped.flatMap(feature =>
        namesOf(feature.command!).map(({ name, description }) => {
          const subcommand: CommandOptionJson = {
            type: ApplicationCommandOptionType.Subcommand,
            name,
            description,
          };
          const options = optionsJson(feature.command!);
          if (options) subcommand.options = options;
          return subcommand;
        })),
    });
  }

  return commands;
}

export interface PutCommandsOptions {
  rest: REST;
  applicationId: string;
  commands: CommandJson[];
}

/**
 * Replace the global command list. One put replaces everything, so a command
 * removed from the registry is removed from Discord by the same call that
 * adds a new one, and there is no separate cleanup to forget.
 */
export async function putCommands({ rest, applicationId, commands }: PutCommandsOptions): Promise<number> {
  await rest.put(Routes.applicationCommands(applicationId), { body: commands });
  return commands.length;
}
