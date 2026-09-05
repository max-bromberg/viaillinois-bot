import { describe, it, expect } from 'vitest';
import { GatewayIntentBits, IntentsBitField } from 'discord.js';
import { GATEWAY_INTENTS, intentsBitfield } from '../../src/discord/intents.ts';

/**
 * The privacy rule in CLAUDE.md is about what the bot asks Discord for, and
 * what it asks for is this list. A test that reads the bitfield is the only
 * place the rule can be enforced, because an intent added anywhere else in
 * the code would otherwise be invisible until a privileged intent review.
 *
 * Two intents the bot once asked for are gone. The members intent is
 * privileged and the bot never needed it: a role is given and taken back
 * through the REST calls, and the daily reconciliation reads who is a member
 * from VIA rather than from Discord. The direct messages intent covers
 * messages sent to the bot, and nothing the bot does reads one: everything a
 * person says to it arrives inside an interaction they started, which Discord
 * delivers whatever intents the bot holds.
 */
describe('the gateway intents', () => {
  it('asks for the two intents the design names and no others', () => {
    expect([...GATEWAY_INTENTS].sort()).toEqual([
      GatewayIntentBits.GuildScheduledEvents,
      GatewayIntentBits.Guilds,
    ].sort());
  });

  it('builds a bitfield holding exactly those two bits', () => {
    const expected = GatewayIntentBits.Guilds | GatewayIntentBits.GuildScheduledEvents;
    expect(intentsBitfield()).toBe(expected);
  });

  it('never asks for the message content intent', () => {
    expect(intentsBitfield() & GatewayIntentBits.MessageContent).toBe(0);
  });

  it('never asks for the presence intent', () => {
    expect(intentsBitfield() & GatewayIntentBits.GuildPresences).toBe(0);
  });

  /**
   * The members intent is privileged, and a bot that asks for a privileged
   * intent it does not need is a bot that has to justify it in a review.
   */
  it('never asks for the members intent, because nothing reads it', () => {
    expect(intentsBitfield() & GatewayIntentBits.GuildMembers).toBe(0);
  });

  it('never asks for the direct messages intent, because nothing reads one', () => {
    expect(intentsBitfield() & GatewayIntentBits.DirectMessages).toBe(0);
  });

  it('holds nothing beyond the two, bit by bit', () => {
    const field = new IntentsBitField(intentsBitfield());
    expect(field.toArray().sort()).toEqual(['GuildScheduledEvents', 'Guilds'].sort());
  });
});
