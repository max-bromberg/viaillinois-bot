import { GatewayIntentBits } from 'discord.js';

/**
 * What the bot asks the gateway for, and nothing else.
 *
 * Guilds tells the bot which servers it is in and when it is added or removed.
 * GuildScheduledEvents is how the bot keeps the native scheduled events it
 * creates in step with VIA, including the interest signals people leave on
 * them. Those two are the whole list.
 *
 * Two intents the bot does not ask for are worth naming, because it is not
 * obvious that they are unnecessary. The members intent is privileged, and the
 * bot does not need it: a mapped role is given and taken back through the REST
 * calls, which carry their own answer, and the daily reconciliation reads who
 * is a member of an organization from VIA rather than from Discord. The direct
 * messages intent covers messages sent to the bot, and nothing the bot does
 * reads one: everything a person says to it arrives inside an interaction they
 * deliberately started, which Discord delivers whatever intents the bot holds.
 *
 * The message content intent and the presence intent are privileged, and the
 * bot never asks for either. Message text reaches the bot only inside an
 * interaction a person deliberately started, which Discord delivers as part
 * of that interaction, and the bot uses it there and discards it. This list
 * is the only place the intents are named, and a test reads the bitfield it
 * produces, so an intent cannot be added quietly somewhere else.
 */
export const GATEWAY_INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildScheduledEvents,
] as const;

/** The intents as the single number the gateway identify payload carries. */
export function intentsBitfield(): number {
  return GATEWAY_INTENTS.reduce((field, intent) => field | intent, 0);
}
