import { ApplicationRoleConnectionMetadataType, Routes, type REST } from 'discord.js';

/**
 * Discord's linked roles.
 *
 * An application can publish a few facts about a person, and any server, whether
 * or not it has installed the bot, can then require one of them for a role of
 * its own through Discord's own verification screen. Section 6.1 of the design
 * names three facts: that the person has a verified NetID, whether they sit on
 * any organization's board, and the date they linked. The first of them solves
 * a problem every organization server already has and currently solves by
 * hand, which is letting only students with a verified NetID into a channel.
 *
 * The bot's part is registering the facts once, at startup. Pushing a person's
 * own values is the web platform's, because the web platform holds the Discord
 * authorization from the link flow and the bot deliberately does not.
 *
 * There is no address the bot can hand somebody to start the verification. A
 * server owner adds a linked role requirement in the server's role settings,
 * and Discord shows the verification to the person from there, so what the bot
 * can usefully say is where to look.
 */

/**
 * The two kinds of requirement the three facts are. Discord numbers them, and
 * the numbers are taken from the library rather than written out here, so that
 * a fact cannot quietly become a different kind of comparison.
 *
 * A date compared as greater than or equal is how Discord expresses "at least
 * this long ago", which is what a server asking for an account linked for a
 * while means.
 */
export const METADATA_TYPE = {
  linkedAtLeastThisLongAgo: ApplicationRoleConnectionMetadataType.DatetimeGreaterThanOrEqual,
  isTrue: ApplicationRoleConnectionMetadataType.BooleanEqual,
} as const;

export interface LinkedRoleFact {
  /** The key the web platform pushes the value under. */
  key: string;
  name: string;
  description: string;
  type: number;
}

/**
 * The three facts, in the order they read in Discord's own screen. The names
 * and descriptions are what a server owner reads while choosing a requirement,
 * so they are written as sentences rather than as field names.
 */
export const LINKED_ROLE_METADATA: readonly LinkedRoleFact[] = [
  {
    key: 'verified_netid',
    name: 'Verified NetID',
    description: 'This person has signed in with an Illinois NetID and linked it to VIA.',
    type: METADATA_TYPE.isTrue,
  },
  {
    key: 'on_board',
    name: 'On an organization board',
    description: 'This person sits on the board of at least one ECE organization on VIA.',
    type: METADATA_TYPE.isTrue,
  },
  {
    key: 'linked_since',
    name: 'Linked since',
    description: 'The date this person linked their Discord account to VIA.',
    type: METADATA_TYPE.linkedAtLeastThisLongAgo,
  },
];

export interface LinkedRoleOptions {
  /** Injected so that a test registers nothing with Discord. */
  rest: REST;
  applicationId: string;
}

/**
 * Register the facts with Discord, replacing whatever was registered before.
 *
 * A failure here is logged and nothing more. The facts are a convenience a
 * server can require for a role, and a bot that refused to start because
 * Discord was slow to accept a metadata schema would be a bot that is down for
 * everything else as well.
 *
 * @returns how many facts were registered, and zero when the call failed
 */
export async function registerLinkedRoleMetadata(options: LinkedRoleOptions): Promise<number> {
  const body = LINKED_ROLE_METADATA.map(fact => ({
    key: fact.key,
    name: fact.name,
    description: fact.description,
    type: fact.type,
  }));

  try {
    await options.rest.put(
      Routes.applicationRoleConnectionMetadata(options.applicationId),
      { body },
    );
    return body.length;
  } catch (err) {
    console.error('registering the linked role facts failed:', (err as Error).message);
    return 0;
  }
}

/**
 * What a person is told about linked roles.
 *
 * There is no address that starts the verification, whatever an authorize
 * address with the role connections scope might suggest: Discord starts it
 * from the server that requires the role, so a person is told where the
 * requirement is set and that linking is what satisfies it.
 */
export function linkedRolesAdvice(): string {
  return [
    'Once this account is linked, VIA can also tell Discord that you have a verified NetID, whether you sit on an organization board, and when you linked.',
    'A server owner can require any of those for a role, under Server Settings and then Roles, by adding a link to VIA under Links.',
    'Discord then asks you to verify when you take the role, and there is nothing further for you to set up here.',
  ].join(' ');
}
