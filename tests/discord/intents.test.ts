import { describe, it, expect } from 'vitest';
import { GatewayIntentBits, IntentsBitField } from 'discord.js';
import { GATEWAY_INTENTS, intentsBitfield } from '../../src/discord/intents.ts';

/**
 * The privacy rule in CLAUDE.md is about what the bot asks Discord for, and
 * what it asks for is this list. A test that reads the bitfield is the only
 * place the rule can be enforced, because an intent added anywhere else in
 * the code would otherwise be invisible until a privileged intent review.
 */
describe('the gateway intents', () => {
  it('asks for the four intents the design names and no others', () => {
    expect([...GATEWAY_INTENTS].sort()).toEqual([
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildScheduledEvents,
      GatewayIntentBits.Guilds,
    ].sort());
  });

  it('builds a bitfield holding exactly those four bits', () => {
    const expected = GatewayIntentBits.Guilds
      | GatewayIntentBits.GuildScheduledEvents
      | GatewayIntentBits.GuildMembers
      | GatewayIntentBits.DirectMessages;
    expect(intentsBitfield()).toBe(expected);
  });

  it('never asks for the message content intent', () => {
    expect(intentsBitfield() & GatewayIntentBits.MessageContent).toBe(0);
  });

  it('never asks for the presence intent', () => {
    expect(intentsBitfield() & GatewayIntentBits.GuildPresences).toBe(0);
  });

  it('holds nothing beyond the four, bit by bit', () => {
    const field = new IntentsBitField(intentsBitfield());
    expect(field.toArray().sort()).toEqual(
      ['DirectMessages', 'GuildMembers', 'GuildScheduledEvents', 'Guilds'].sort()
    );
  });
});
