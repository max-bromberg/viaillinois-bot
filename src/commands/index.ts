import { featureById } from '../features/registry.ts';
import {
  answerAutocomplete, applyReply, respond, respondByUpdate, showModal, toInteraction,
  FAILURE_MESSAGE, type Interaction, type Reply,
} from '../discord/adapter.ts';
import { autocompleteSubject, guildSubject, userSubject, type RateTier } from '../ratelimit/windows.ts';
import { describeWait, type CommandContext, type CommandHandler, type ComponentHandler } from './types.ts';
import { linkCommand, linkComponent } from './link.ts';
import { unlinkCommand } from './unlink.ts';
import {
  eventsCommand, eventCommand, rsoCommand, eventsComponent, eventComponent, rsoComponent,
} from './events.ts';
import { setupCommand, configCommand, removeCommand, setupComponent } from './setup.ts';
import {
  followCommand, unfollowCommand, followingCommand, calendarCommand,
  feedSettingsCommand, feedRemindersCommand, feedComponent,
} from './feed.ts';
import {
  midtermsCommand, coursesAddCommand, coursesRemoveCommand, coursesListCommand,
} from './midterms.ts';
import { roomsCommand, courseCommand, buildingCommand } from './campus.ts';
import {
  postponeCommand, cancelCommand, describeCommand, visibilityCommand, repostCommand,
  noteCommand, adminComponent, adminFormComponent,
} from './admin.ts';
import {
  scheduleCommand, schedulerComponent, schedulerAcceptComponent, schedulerNameComponent,
} from './scheduler.ts';
import { rolesCommand, rolesComponent } from './roles.ts';
import { feedbackComponent, feedbackCommentComponent } from './feedback.ts';

export { describeWait } from './types.ts';
export type { CommandContext, CommandHandler, ComponentHandler } from './types.ts';
export { linkCommand, linkComponent } from './link.ts';
export { unlinkCommand, deleteLocalData } from './unlink.ts';

/**
 * The dispatcher.
 *
 * One interaction arrives, one command runs. Before it runs, the command is
 * counted against the person and against the server, and a refusal is a
 * sentence naming the wait rather than silence. A command that is refused is
 * answered straight away rather than acknowledged first, because there is no
 * work to wait for and a thinking state that resolves into a refusal reads
 * worse than a refusal.
 *
 * A server's own switches are kept here as well. Section 5 of the design gives
 * every server a switch for every feature, and Discord has no per server view
 * of a global command, so the command is still in the list in a server that
 * switched it off and the refusal is the bot's to give. Setup and removal are
 * the two that are never refused, because a switch that could stop either
 * would leave a server with no way to switch anything back on.
 *
 * Three kinds of interaction reach a handler. A chat command runs the command
 * of that name. An autocomplete runs the completions of the command being
 * typed, and is answered with a list rather than a message. A button or a menu
 * runs the component handler whose prefix its identifier begins with, which is
 * how the buttons on a card and the panels of setup are answered by the module
 * that posted them. Anything else is left alone rather than answered with a
 * sentence about something nothing has posted.
 */

/** Every command the bot answers, keyed by the name the adapter reports. */
export const handlers: readonly CommandHandler[] = [
  linkCommand,
  unlinkCommand,
  eventsCommand,
  eventCommand,
  rsoCommand,
  setupCommand,
  configCommand,
  removeCommand,
  followCommand,
  unfollowCommand,
  followingCommand,
  feedSettingsCommand,
  feedRemindersCommand,
  calendarCommand,
  midtermsCommand,
  coursesAddCommand,
  coursesRemoveCommand,
  coursesListCommand,
  roomsCommand,
  courseCommand,
  buildingCommand,
  postponeCommand,
  cancelCommand,
  describeCommand,
  visibilityCommand,
  repostCommand,
  noteCommand,
  scheduleCommand,
  rolesCommand,
];

/**
 * Every component the bot answers. The first handler whose prefix the
 * identifier begins with answers it, so the order here matters wherever one
 * prefix sits inside another, which the comments below name.
 */
export const componentHandlers: readonly ComponentHandler[] = [
  linkComponent,
  eventsComponent,
  eventComponent,
  rsoComponent,
  setupComponent,
  feedComponent,
  // The two handlers that may answer with a form come before the ones whose
  // prefixes they sit inside, because the first prefix that matches answers.
  adminFormComponent,
  adminComponent,
  // The button that opens the form comes before the accept button, and both
  // before the handler whose prefix sits inside theirs, because the first
  // prefix that matches answers.
  schedulerNameComponent,
  schedulerAcceptComponent,
  schedulerComponent,
  rolesComponent,
  // The comment handler comes before the one its prefix sits inside, for the
  // same reason the administrative form handler does: the first prefix that
  // matches answers, and only one of the two can open a form.
  feedbackCommentComponent,
  feedbackComponent,
];

export const UNKNOWN_COMMAND_MESSAGE =
  'This bot does not answer that command. The command list may have changed since Discord last refreshed it, so please try again in a few minutes.';

/**
 * What somebody reads when a server manager has switched off the feature they
 * just reached for.
 *
 * Section 5 of the design gives every server a switch for every feature, and
 * Discord has no per server view of a global command, so the command is still
 * offered in the list and the switch is kept here instead. The sentence names
 * the command that puts it back, because the person who ran it is usually not
 * the person who switched it off.
 */
export const FEATURE_OFF_MESSAGE =
  'A server manager has switched this off in this server. Ask them to switch it back on with the config command.';

/**
 * The two features a server switch never refuses. Setting the bot up is how a
 * manager switches anything on again, and removing it is how they get the bot
 * out of a server, so a switch that could stop either would be a server with
 * no way back.
 */
export const ALWAYS_ANSWERED: readonly string[] = ['setup.configure', 'setup.remove'];

export const USER_LIMIT_MESSAGE = 'You have run too many VIA commands in the last hour.';
export const GUILD_LIMIT_MESSAGE = 'This server has run too many VIA commands in the last hour.';

/**
 * Which limit a command is counted against. A command anybody may run is
 * counted against the tighter limit, and a command only a linked person may
 * run against the wider one, because a linked person is accountable through a
 * NetID. This follows the tier the registry declares rather than a lookup of
 * whether the person is linked, so that no command costs a call to the web
 * platform before it has decided to make one.
 */
export function tierOf(handler: CommandHandler | ComponentHandler): RateTier {
  return featureById(handler.featureId).tier === 'read' ? 'unlinked' : 'linked';
}

/**
 * Whether a server has switched this feature off. A person in the bot's own
 * direct messages, or in a group direct message, is in no server, and there is
 * then nobody who could have switched anything off.
 */
export async function switchedOffHere(
  handler: { featureId: string },
  interaction: Pick<Interaction, 'guildId'>,
  guilds: CommandContext['guilds'],
): Promise<boolean> {
  if (!interaction.guildId) return false;
  if (ALWAYS_ANSWERED.includes(handler.featureId)) return false;
  return !(await guilds.isFeatureEnabled(interaction.guildId, handler.featureId));
}

/**
 * Whether the answer is shown only to the person who asked.
 *
 * The handler chooses, except in one case that overrules it. Section 6.8 of
 * the design publishes the application with both installation contexts, so
 * somebody who installed the bot to their own account can use it in a server
 * that has not installed it. The bot was not invited into that server's
 * channels, so its answer there is shown to the person who asked and to
 * nobody else. Everywhere else the handler's own choice stands, and a
 * component handler that says nothing answers only the person, which is what
 * a button on a message a whole channel reads has to do.
 */
export function answersOnlyThePerson(
  handler: { ephemeral?: boolean },
  interaction: Pick<Interaction, 'installedInServer'>,
): boolean {
  return handler.ephemeral !== false || !interaction.installedInServer;
}

/**
 * Answer something that may want to open a form.
 *
 * Discord takes a form only as the first thing an application says about an
 * interaction, so nothing may be acknowledged before the handler has run. That
 * costs the three second window rather than the fifteen minute one, which is
 * why the handlers that open a form make one call to fill the boxes in and no
 * more. A handler that answers with a message instead is answered here as
 * well, because by then the acknowledgement is no longer available.
 */
async function answerOrShowModal(
  raw: unknown,
  ephemeral: boolean,
  produce: () => Promise<Reply>,
): Promise<void> {
  let reply: Reply;
  try {
    reply = await produce();
  } catch (err) {
    console.error('interaction failed:', (err as Error).message);
    await applyReply(raw, { content: FAILURE_MESSAGE, ephemeral });
    return;
  }

  if (reply.modal) {
    await showModal(raw, reply.modal);
    return;
  }
  await applyReply(raw, { ...reply, ephemeral });
}

export function createDispatcher(context: CommandContext): (raw: unknown) => Promise<void> {
  const byName = new Map(handlers.map(handler => [handler.name, handler]));

  /**
   * Count the interaction against the person and against the server, and
   * answer with the sentence naming the wait when either refuses. A refusal is
   * answered straight away rather than acknowledged first, because there is no
   * work to wait for and a thinking state that resolves into a refusal reads
   * worse than a refusal.
   */
  async function withinLimits(interaction: Interaction, tier: RateTier, raw: unknown): Promise<boolean> {
    const person = await context.rateWindows.consume(userSubject(interaction.userId), tier);
    if (!person.allowed) {
      await applyReply(raw, {
        content: `${USER_LIMIT_MESSAGE} Please try again ${describeWait(person.retryAfterSeconds)}.`,
        ephemeral: true,
      });
      return false;
    }

    if (interaction.guildId) {
      // Something the server ceiling refuses has still been sent by the
      // person, so it stays counted against them.
      const server = await context.rateWindows.consume(guildSubject(interaction.guildId), 'guild');
      if (!server.allowed) {
        await applyReply(raw, {
          content: `${GUILD_LIMIT_MESSAGE} Please try again ${describeWait(server.retryAfterSeconds)}.`,
          ephemeral: true,
        });
        return false;
      }
    }
    return true;
  }

  /**
   * An autocomplete fires on every keystroke and expires in three seconds, so
   * it is not counted against the command limit: counting it there would
   * refuse a person for typing a name. It is counted against a window of its
   * own instead, over a minute and against a subject of its own, because every
   * completion is a read and a cache entry keyed by whatever was typed, and a
   * script firing one in a loop must not be able to ask for those without
   * bound. The limit is wide enough that nobody reaches it by typing.
   *
   * A refusal is answered with no completions rather than with a sentence,
   * because Discord takes a list here and nothing else, and so is a failure,
   * because there is nobody waiting on a sentence either.
   */
  async function complete(interaction: Interaction, raw: unknown): Promise<void> {
    const handler = interaction.commandName ? byName.get(interaction.commandName) : undefined;
    if (!handler?.autocomplete) {
      await answerAutocomplete(raw, []);
      return;
    }

    const typing = await context.rateWindows.consume(
      autocompleteSubject(interaction.userId),
      'autocomplete',
    );
    if (!typing.allowed) {
      await answerAutocomplete(raw, []);
      return;
    }
    try {
      await answerAutocomplete(raw, await handler.autocomplete(interaction, context));
    } catch (err) {
      console.error('completing an option failed:', (err as Error).message);
      await answerAutocomplete(raw, []);
    }
  }

  /**
   * Refuse a feature this server switched off, with the sentence that names
   * the way to put it back. It is answered straight away rather than
   * acknowledged first, for the same reason a rate limit refusal is: there is
   * no work to wait for.
   */
  async function refusedByTheServer(
    handler: { featureId: string },
    interaction: Interaction,
    raw: unknown,
  ): Promise<boolean> {
    if (!(await switchedOffHere(handler, interaction, context.guilds))) return false;
    await applyReply(raw, { content: FEATURE_OFF_MESSAGE, ephemeral: true });
    return true;
  }

  return async function dispatch(raw: unknown): Promise<void> {
    const interaction: Interaction = toInteraction(raw);

    if (interaction.kind === 'autocomplete') {
      await complete(interaction, raw);
      return;
    }

    // A form sent back is routed exactly as the button that opened it was,
    // because Discord gives it the identifier the form was built with.
    if (interaction.kind === 'button' || interaction.kind === 'select' || interaction.kind === 'modal') {
      const customId = interaction.customId ?? '';
      const handler = componentHandlers.find(one => customId.startsWith(one.prefix));
      // A component nothing answers is left alone. It was posted by a version
      // of the bot that is no longer running, and a sentence about a button
      // that no longer exists helps nobody.
      if (!handler) return;

      if (await refusedByTheServer(handler, interaction, raw)) return;
      if (!(await withinLimits(interaction, tierOf(handler), raw))) return;

      // A handler that may open a form is run before anything is
      // acknowledged, because Discord takes a form only as the first thing
      // said about an interaction. A form sent back is a new interaction, so
      // the answer to one is acknowledged like any other.
      if (handler.opensModal && interaction.kind !== 'modal') {
        await answerOrShowModal(
          raw,
          answersOnlyThePerson(handler, interaction),
          () => handler.run(interaction, context),
        );
        return;
      }

      if (handler.updateInPlace) {
        await respondByUpdate(raw, () => handler.run(interaction, context));
        return;
      }
      await respond(
        raw,
        { ephemeral: answersOnlyThePerson(handler, interaction) },
        () => handler.run(interaction, context),
      );
      return;
    }

    if (interaction.kind !== 'chatCommand') return;

    const handler = interaction.commandName ? byName.get(interaction.commandName) : undefined;
    if (!handler) {
      await applyReply(raw, { content: UNKNOWN_COMMAND_MESSAGE, ephemeral: true });
      return;
    }

    if (await refusedByTheServer(handler, interaction, raw)) return;
    if (!(await withinLimits(interaction, tierOf(handler), raw))) return;

    if (handler.opensModal) {
      await answerOrShowModal(
        raw,
        answersOnlyThePerson(handler, interaction),
        () => handler.run(interaction, context),
      );
      return;
    }

    await respond(
      raw,
      { ephemeral: answersOnlyThePerson(handler, interaction) },
      () => handler.run(interaction, context),
    );
  };
}
