import { readFileSync } from 'node:fs';
import {
  parseLinkSession, parseLinkedAccount,
  type ViaClient, type LinkSession, type LinkedAccount,
} from './client.ts';

/**
 * The in memory web platform client.
 *
 * Commands are written against the ViaClient interface, so their tests run
 * against this rather than against HTTP. The answers it serves are the
 * recorded shapes under tests/fixtures/internal, read through the same two
 * parsers the HTTP implementation uses, so a fixture that stops matching the
 * web platform breaks the fake as well as the real client.
 *
 * The seeding helpers are what tests reach for: seedLink puts a link in
 * place, and seedLink with afterLookups makes a link that resolves only after
 * a few lookups, which is what the link command polls for.
 *
 * This module reads the fixtures from the test tree, which the container
 * image does not carry, and nothing under src imports it. Were something ever
 * to import it in a deployed bot, it would fail at startup rather than serve
 * invented answers to real people, which is the failure worth having.
 */

const FIXTURES = new URL('../../tests/fixtures/internal/', import.meta.url);

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8'));
}

/** The recorded session, whose address and expiry shape every answer follows. */
const SESSION_TEMPLATE = parseLinkSession(fixture('links.session.json'));
/** The recorded link, whose fields fill in whatever a test does not name. */
const LINK_TEMPLATE = parseLinkedAccount(fixture('links.link.json'));

export interface OpenedSession {
  discordUserId: string;
  session: LinkSession;
}

export interface SeedTiming {
  /** The link answers with nothing for this many lookups before it resolves. */
  afterLookups?: number;
}

export interface FakeViaClient extends ViaClient {
  /** Every session the fake was asked to open, in order. */
  readonly sessions: OpenedSession[];
  /** Put a link in place, filling anything unnamed from the recorded answer. */
  seedLink(discordUserId: string, overrides?: Partial<LinkedAccount>, timing?: SeedTiming): LinkedAccount;
  /** Remove a link without going through the unlink call. */
  removeLink(discordUserId: string): void;
  /** Whether the web platform answers its health endpoint. */
  setHealthy(healthy: boolean): void;
  /** Make the next call, whichever it is, throw the given error. */
  failNextWith(error: Error): void;
  /** Forget every link, session and instruction. */
  reset(): void;
}

interface SeededLink {
  account: LinkedAccount;
  unresolvedLookups: number;
  lookups: number;
}

export function createFakeViaClient(): FakeViaClient {
  const links = new Map<string, SeededLink>();
  const sessions: OpenedSession[] = [];
  let healthy = true;
  let nextFailure: Error | null = null;
  let sessionCounter = 0;

  /** One instruction, one failure, so a test can assert on the recovery too. */
  function throwIfInstructed(): void {
    if (!nextFailure) return;
    const failure = nextFailure;
    nextFailure = null;
    throw failure;
  }

  return {
    sessions,

    seedLink(discordUserId, overrides = {}, timing = {}) {
      const account: LinkedAccount = {
        ...LINK_TEMPLATE,
        discordUserId,
        ...overrides,
        memberships: overrides.memberships ?? LINK_TEMPLATE.memberships.map(m => ({ ...m })),
      };
      links.set(discordUserId, {
        account,
        unresolvedLookups: timing.afterLookups ?? 0,
        lookups: 0,
      });
      return account;
    },

    removeLink(discordUserId) {
      links.delete(discordUserId);
    },

    setHealthy(value) {
      healthy = value;
    },

    failNextWith(error) {
      nextFailure = error;
    },

    reset() {
      links.clear();
      sessions.length = 0;
      healthy = true;
      nextFailure = null;
      sessionCounter = 0;
    },

    async openLinkSession(discordUserId) {
      throwIfInstructed();
      sessionCounter += 1;
      const sessionId = `${SESSION_TEMPLATE.sessionId.slice(0, 40)}${String(sessionCounter).padStart(3, '0')}`;
      const session: LinkSession = {
        sessionId,
        address: `https://viaillinois.com/link/discord/${sessionId}`,
        expiresAt: SESSION_TEMPLATE.expiresAt,
      };
      sessions.push({ discordUserId, session });
      return session;
    },

    async getLink(discordUserId) {
      throwIfInstructed();
      const seeded = links.get(discordUserId);
      if (!seeded) return null;
      seeded.lookups += 1;
      if (seeded.lookups <= seeded.unresolvedLookups) return null;
      return seeded.account;
    },

    async unlink(discordUserId) {
      throwIfInstructed();
      return links.delete(discordUserId);
    },

    async health() {
      throwIfInstructed();
      return healthy;
    },
  };
}
