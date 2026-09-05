/**
 * The web platform client.
 *
 * Every piece of VIA data the bot reads or writes goes through the internal
 * service API, and every call to that API goes through this interface. Two
 * implementations exist: the real one over HTTP in `http.ts`, and the in
 * memory one in `fake.ts` that serves the recorded shapes under
 * `tests/fixtures/internal`. Commands are written against the interface, so
 * almost every test needs neither the web platform nor Discord.
 *
 * The interface grows one increment at a time. The first increment needs the
 * three link endpoints and a health check, which is what is here.
 */

/**
 * The machine readable codes the internal service API answers refusals with,
 * from section 3 of the companion specification, and one code of the bot's
 * own for the case where nothing answered at all.
 */
export const VIA_ERROR_CODES = [
  'unauthorized',
  'not_linked',
  'forbidden',
  'not_found',
  'invalid',
  'busy',
  'conflict',
  'unreachable',
] as const;

export type ViaErrorCode = (typeof VIA_ERROR_CODES)[number];

/**
 * A refusal from the web platform, or a failure to reach it.
 *
 * The message is the sentence the web platform wrote, which is fit to show a
 * person, and the code is what the bot branches on, so no caller ever has to
 * read prose to tell a missing link from a missing event.
 */
export class ViaError extends Error {
  readonly status: number;
  readonly code: ViaErrorCode;
  readonly requestId: string | null;

  constructor(message: string, status: number, code: ViaErrorCode, requestId: string | null = null) {
    super(message);
    this.name = 'ViaError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

/**
 * The web platform is shedding load and named a wait. The bot honours the
 * wait and does not retry inside it, so this is thrown only after one retry
 * has already been made and refused.
 */
export class ViaBusyError extends ViaError {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number, requestId: string | null = null) {
    super(message, 503, 'busy', requestId);
    this.name = 'ViaBusyError';
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The three membership roles the web platform keeps in RSO_Memberships. */
export type MembershipRole = 'member' | 'editor' | 'board';

/** One RSO a linked person belongs to, with the role they hold in it. */
export interface Membership {
  rsoId: number;
  rsoName: string;
  role: MembershipRole;
}

/**
 * A link session the person opens in a browser to sign in with their NetID
 * and authorize the bot's Discord application. It expires ten minutes after
 * the web platform created it.
 */
export interface LinkSession {
  sessionId: string;
  address: string;
  expiresAt: string;
}

/**
 * A resolved link. The bot holds this only for as long as it is answering the
 * interaction that asked for it: the NetID belongs to the web platform, and
 * nothing here is written to the bot's database.
 */
export interface LinkedAccount {
  discordUserId: string;
  netId: string;
  displayName: string;
  isGlobalAdmin: boolean;
  linkedAt: string;
  memberships: Membership[];
}

export interface ViaClient {
  /** Open a link session for a Discord account and get the address it opens. */
  openLinkSession(discordUserId: string): Promise<LinkSession>;
  /** The account a Discord user is linked to, or null when there is no link. */
  getLink(discordUserId: string): Promise<LinkedAccount | null>;
  /** Remove the link, answering whether there was one to remove. */
  unlink(discordUserId: string): Promise<boolean>;
  /** Whether the web platform answers. */
  health(): Promise<boolean>;
}

/**
 * The answers arrive as JSON in the web platform's spelling, which is snake
 * case, and the bot reads them in its own, which is camel case. Both the HTTP
 * implementation and the fake go through these two functions, so the fixtures
 * are exercised by the same code that reads the real answers.
 */
export function parseLinkSession(body: unknown): LinkSession {
  const raw = body as Record<string, unknown>;
  return {
    sessionId: String(raw.session_id ?? ''),
    address: String(raw.address ?? ''),
    expiresAt: String(raw.expires_at ?? ''),
  };
}

export function parseLinkedAccount(body: unknown): LinkedAccount {
  const raw = body as Record<string, unknown>;
  const memberships = Array.isArray(raw.memberships) ? raw.memberships : [];
  return {
    discordUserId: String(raw.discord_user_id ?? ''),
    netId: String(raw.net_id ?? ''),
    displayName: String(raw.display_name ?? ''),
    isGlobalAdmin: Boolean(raw.is_global_admin),
    linkedAt: String(raw.linked_at ?? ''),
    memberships: memberships.map(entry => {
      const row = entry as Record<string, unknown>;
      return {
        rsoId: Number(row.rso_id),
        rsoName: String(row.rso_name ?? ''),
        role: String(row.role ?? 'member') as MembershipRole,
      };
    }),
  };
}
