# The Internal Service API and the Web Platform Work for the Discord Bot

**Status**: agreed on 2026-09-04
**Date**: 2026-09-04
**Repository this lands in**: `viaillinois`, the web platform. It is specified here, in the
bot's repository, because the bot is the reason for it and the two designs have to be read
together. When the work begins, this document is the source for the web platform's own
spec and plan under its `docs/superpowers` directory.
**Companion spec**: `2026-09-04-via-discord-bot.md`.

## 1. Summary

The bot never touches the web platform's tables. Everything it knows about VIA, and
everything it does to VIA on a person's behalf, goes through an internal service API that
the web platform serves on the private container network. This document specifies that
API, the account link between a NetID and a Discord account, the outbox through which the
web platform tells the bot what changed, the new tables, and the changes to the Compose
stack and the cutover script that let one deploy carry both services.

## 2. Principles

1. **Authorization is decided here.** The bot presents a Discord user identifier it
   observed. The web platform resolves it to a NetID through its own link table and applies
   the same middleware the dashboard's routes use. The bot never asserts a NetID.
2. **One schema of record.** Every new table is a migration under `server/db/migrations`,
   declared in the Drizzle schema, and covered by the drift check.
3. **The public surface does not change.** The internal API is a separate router with its
   own guard. Nothing about the public API, its budgets or its caching changes for the
   public.
4. **Data access through Drizzle.** This is new data access code, so it is written with
   Drizzle, as the web platform's rules require. Existing raw queries it needs to call are
   called, not rewritten.

## 3. Reaching the API

### Address and guard

The internal router is mounted at `/internal/v1` on the same Express application, because
the web platform serves one port. Two guards keep it internal:

- Every request must carry `Authorization: Bearer <token>`, where the token is
  `BOT_SERVICE_TOKEN`, a long random secret in the stack's `.env` that both containers
  read. A missing or wrong token is answered with a 401 carrying only the error shape, and
  the attempt is recorded as an access denial with reason `internal_unauthorized`. When no
  token is configured at all, the whole prefix answers 404, because a deployment without
  the bot has no internal API.
- The reverse proxy in front of the web platform does not forward `/internal`, so the path
  is unreachable from the internet even with the token. The web platform also refuses the
  path when the request arrived through the proxy, which it can tell from the forwarded
  headers the proxy adds, so a proxy misconfiguration fails closed.

### Acting as a person

A request that does something for a person carries `X-Via-Acting-Discord-User` with that
person's Discord user identifier. Middleware resolves it through `Discord_Links` and sets
`req.user` to the same shape `attachUser` sets from the cookie, so `requireAuth`,
`requireRSOEditor`, `requireRSOAdmin` and `requireGlobalAdmin` work unchanged. An
identifier with no link is answered with 403 and the error code `not_linked`, which the bot
turns into an invitation to link. A request with no acting header runs as the service
itself, which can read public data and the outbox and can do nothing that needs a person.

### Exemptions

The service token identifies the bot, so:

- The public traffic budgets in `publicApiBudget` do not apply to `/internal`.
- Load shedding places `/internal` in the same tier as a signed in write, the last tier
  there is, so it is refused only at the worst level and after everything except the
  health endpoint. When it is refused, the bot receives the same busy answer with the
  same wait, and the refusal is counted under reason `overloaded` with a route the
  availability tab can show.
- The login rate limit does not apply, because nothing under `/internal` logs anyone in.

### Shapes

Requests and answers are JSON. Times leave the API with the campus offset attached, exactly
as the public API sends them, and arrive the same way. Errors use the shape the public API
uses, with one addition: a machine readable `code` beside the sentence, so the bot can
choose its wording without parsing prose. The codes the first release needs are
`unauthorized`, `not_linked`, `forbidden`, `not_found`, `invalid`, `busy` and `conflict`.

Every answer carries `X-Via-Internal-Api-Version`, which is the web platform's version, so
the bot's health endpoint can report which web platform it is talking to.

## 4. Account linking

### Tables

`Discord_Links`

| Column | Type | Notes |
|---|---|---|
| `discord_user_id` | varchar(32) | Primary key. Discord snowflakes are decimal strings and must never be stored as a JavaScript number. |
| `net_id` | varchar(20) | Foreign key to `Users`, unique, so one NetID has one Discord account |
| `linked_at` | datetime | |
| `discord_authorization` | varbinary | The Discord refresh token from the link flow, encrypted with `DISCORD_LINK_KEY`, present only while linked roles are enabled for the person. See section 5. |

`Link_Sessions`

| Column | Type | Notes |
|---|---|---|
| `session_id` | char(43) | Primary key, a random URL safe token |
| `discord_user_id` | varchar(32) | The account the bot observed asking to link |
| `created_at` | datetime | |
| `expires_at` | datetime | Ten minutes after creation |
| `completed_at` | datetime, null | Set when the link is made |

### Flow

1. The bot calls `POST /internal/v1/links/sessions` with the Discord user identifier. The
   web platform creates a `Link_Sessions` row and answers with the address
   `https://viaillinois.com/link/discord/<session_id>` and its expiry.
2. The person opens the address. If they are not signed in, the web platform sends them
   through the existing NetID sign in and returns them to the same address.
3. The page explains what linking does and offers one button, which starts Discord's OAuth2
   authorization with the `identify` scope and, if the person accepts the optional linked
   roles step, the `role_connections.write` scope. The `state` parameter is the session
   identifier, signed.
4. Discord returns to `/auth/discord/callback`. The web platform exchanges the code, reads
   the Discord user identifier from the `identify` answer, and checks that it matches the
   one the session was opened for. A mismatch means somebody opened another person's link
   address, and it is refused.
5. The web platform writes the `Discord_Links` row, replacing any earlier link for either
   side, marks the session completed, pushes the linked role facts if the scope was
   granted, and writes a `link.completed` outbox entry. The page confirms and tells the
   person to return to Discord, where the bot has already sent them a direct message.

### Unlinking

`DELETE /internal/v1/links/{discordUserId}` from the bot, or the account page on the
website, deletes the row and writes `link.revoked`. The bot deletes what it holds for that
account when it sees the entry. The web platform also clears the person's linked role facts
on Discord if it still holds an authorization.

### Lookup

`GET /internal/v1/links/{discordUserId}` answers with the NetID, the person's display name,
their global administrator flag and their memberships with roles, or 404. The bot caches
this in memory for a minute, and drops the cache entry on `link.revoked` and
`membership.changed`.

## 5. Linked roles

Discord's linked roles feature lets an application publish up to a handful of facts per
person, which servers can require for a role. The web platform pushes three: `verified`,
which is true for every linked person, `board`, which is true when the person is a board
member of any RSO, and `linked_since`, a date.

Pushing requires a Discord access token for the person, obtained from the refresh token
kept in `Discord_Links`, encrypted at rest with `DISCORD_LINK_KEY`. The web platform
refreshes and re-pushes when a link is made and whenever `RSO_Memberships` changes for that
person. A person who declined the linked roles step has no authorization stored and no
facts pushed, and can add it later from the account page. This is the one secret the web
platform keeps on a person's behalf, and the open question in the bot spec records the
alternative of not keeping it.

## 6. Endpoints

Every endpoint below is served under `/internal/v1`. "Acting" means the request must carry
the acting header and the web platform applies the named middleware. Paging uses the same
ceilings and cursor shape as the public API.

### Links and identity

| Method and path | Acting | Purpose |
|---|---|---|
| `POST /links/sessions` | no | Open a link session, answer with the address and expiry |
| `GET /links/{discordUserId}` | no | Resolve a link |
| `DELETE /links/{discordUserId}` | no | Unlink |
| `POST /guilds/bindings/confirm` | yes, `requireRSOAdmin` on the RSO | Confirm that the acting person may bind a server to this RSO |

### Reading

| Method and path | Acting | Purpose |
|---|---|---|
| `GET /rsos` | no | Every RSO, for autocomplete and community server setup |
| `GET /rsos/{id}` | no | One RSO with its next events |
| `GET /rsos/{id}/members` | yes, `requireRSOAdmin` | Membership with roles, for role reconciliation in a bound server |
| `GET /events` | optional | Upcoming events with the feed's filters: RSO set, window, and whether to include internal events, which are included only when the acting person is a member of that RSO |
| `GET /events/{id}` | optional | One event, with its series if any, and its interest count |
| `GET /events/{id}/calendar` | no | The event as `.ics` |
| `GET /midterms` | no | Confirmed and pending midterms, filtered by course or by window |
| `GET /courses` | no | Course search for autocomplete, with sections on request |
| `GET /locations` | no | Location search for autocomplete |
| `GET /locations/free` | no | Rooms in a building free for a window, from the conflict detector |
| `GET /buildings/{code}` | no | Building name and address from the building code table |

### Acting on events

| Method and path | Acting | Purpose |
|---|---|---|
| `POST /events/{id}/postpone` | `requireRSOEditor` | New start and end, optional reason |
| `POST /events/{id}/cancel` | `requireRSOEditor` | Cancel |
| `PATCH /events/{id}` | `requireRSOEditor` | Description, `is_private`, location note |
| `PUT /events/{id}/interest` | optional | Set or clear interest, by NetID when acting, by hash otherwise |
| `POST /events/{id}/feedback` | `requireAuth` | A rating and optional comment |
| `POST /scheduler/recommend` | `requireRSOEditor` | The same call the dashboard makes |
| `POST /events/series` | `requireRSOEditor` | Create a series from an accepted recommendation, the same call the dashboard makes |

Cancellation is a new state for events. Today an event is either present or deleted, and a
cancelled event that disappears from the feed cannot tell the students who planned to
attend that it was cancelled rather than mistyped. The migration adds a nullable
`cancelled_at` to `Events`, the feed excludes cancelled events by default and shows them in
the archive, and the outbox distinguishes `event.cancelled` from `event.deleted`.

The location note is a new nullable text column on `Events`, shown on the event page beside
the room. It is small, but it is the kind of thing a board changes at the door, and it
exists on the web platform first so that the website shows the same note the bot shows.

### Personal calendar

| Method and path | Acting | Purpose |
|---|---|---|
| `POST /calendars/personal` | `requireAuth` | Create or rotate the person's calendar token, given the RSO set they follow |
| `GET /calendar/personal/{token}.ics` | public, token guarded | Served on the public surface, because a phone's calendar application fetches it |

The token is stored hashed in `Personal_Calendars`, with the RSO set, and the bot updates
the set whenever the person's follows change.

### The outbox

| Method and path | Acting | Purpose |
|---|---|---|
| `GET /outbox?after={id}&limit={n}` | no | Entries with an identifier greater than `after`, in order |

The bot keeps its own cursor. The web platform does not track what the bot has read, which
keeps this endpoint stateless and lets a second consumer appear later without a change.

## 7. The outbox table

`Outbox`

| Column | Type | Notes |
|---|---|---|
| `outbox_id` | bigint, auto increment | Primary key, and the cursor |
| `kind` | varchar(40) | One of the kinds below |
| `subject_type` | varchar(20) | `event`, `series`, `midterm`, `membership`, `link` |
| `subject_id` | varchar(40) | The identifier of the subject |
| `rso_id` | int, null | Set for anything that belongs to an RSO, so the bot can route without a lookup |
| `payload` | json | A snapshot of the subject after the change, and for updates the fields that changed |
| `created_at` | datetime | |

Kinds: `event.created`, `event.updated`, `event.cancelled`, `event.deleted`,
`series.created`, `series.updated`, `series.deleted`, `midterm.confirmed`,
`midterm.updated`, `midterm.cancelled`, `membership.changed`, `link.completed`,
`link.revoked`.

An entry is written in the same transaction as the change it describes where the code path
has a transaction, and immediately after the change otherwise, so that an entry never
describes a change that did not happen. Entries are pruned after thirty days. A bot that has
been away longer than that reconciles from the reading endpoints instead, which its health
endpoint reports.

The writers are the existing controllers: events, series, calendar import, midterms and
RSO membership. Each gains one call, tested by asserting the entry that a request produces.

## 8. Other new tables

`Event_Interest`

| Column | Type | Notes |
|---|---|---|
| `event_id` | int | Foreign key to `Events` |
| `subject` | varchar(64) | A NetID, or `h:` followed by a salted hash of a Discord identifier |
| `source` | varchar(20) | `discord_event`, `discord_button`, or `web` for a later web control |
| `created_at` | datetime | |

Primary key on `event_id` and `subject`. The salt is `DISCORD_INTEREST_SALT` in `.env`. The
interest count appears on the event page and in the RSO statistics, replacing the count the
removed RSVPs used to give, and it is one of the signals the scheduler may weigh later.

`Event_Feedback`

| Column | Type | Notes |
|---|---|---|
| `event_id` | int | Foreign key to `Events` |
| `net_id` | varchar(20) | Foreign key to `Users` |
| `rating` | tinyint | One to five |
| `comment` | text, null | |
| `created_at` | datetime | |

Primary key on `event_id` and `net_id`. The RSO statistics page shows the average, the
count, and the comments to board members, and never who gave which rating.

`Personal_Calendars`

| Column | Type | Notes |
|---|---|---|
| `net_id` | varchar(20) | Primary key, foreign key to `Users` |
| `token_hash` | char(64) | |
| `rso_ids` | json, null | Null means every RSO |
| `rotated_at` | datetime | |

## 9. Changes to the stack and the cutover

### Compose

`docker-compose.yml` gains a `via-bot` service: built from `../viaillinois-bot`, on both the
default `internal` network and `via_internal`, with `TZ` set to campus time, memory and
processor ceilings, `depends_on` the database being healthy and the web platform being
started, one host port for its health endpoint, and the environment it needs:
`DB_HOST`, `DB_PORT`, `BOT_DB_USER`, `BOT_DB_PASSWORD`, `BOT_DB_NAME`, `VIA_INTERNAL_URL`
which is `http://via:3001`, `BOT_SERVICE_TOKEN`, `DISCORD_TOKEN`, `DISCORD_APPLICATION_ID`,
and `DISCORD_PUBLIC_KEY`. The web platform's service gains `BOT_SERVICE_TOKEN`,
`DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_LINK_KEY` and
`DISCORD_INTEREST_SALT`. The database service creates the `via_bot` database and its
account on first start through an initialisation script, and the compose file tests cover
all of it.

### Pinning the bot

`deploy/bot-release` holds one line, the bot tag to deploy. The cutover script reads it,
fetches the sibling checkout to that tag, and refuses a dirty or missing sibling tree with
the same sentence it uses for its own.

### The cutover

The steps become, in order, with the same rule that everything that can fail cheaply runs
before the maintenance window opens:

1. Refuse a dirty tree, check out the web platform tag, read and check out the bot tag.
2. Build both images.
3. Back up both databases and prove both backups restore. The backup and restore scripts
   take the database name, so this is the same code run twice.
4. Stop both application containers.
5. Migrate the web platform, then migrate the bot.
6. Start the web platform, wait for its health, then start the bot and wait for its health.
7. On any failure after the window opens: restore both databases, check out both previous
   tags, start both previous images.

The bot's health depends on the web platform's, so the order in step 6 is not optional.
`HEALTH_URL` gains a sibling, `BOT_HEALTH_URL`, with a default.

The web platform's `docs/deployment.md` is updated to describe all of this, and this
repository's `docs/deployment.md` points at it.

## 10. Tests

- Each endpoint has request level tests in the web platform's `unit` project with the
  database queries mocked, and the endpoints that decide authorization have a test per
  refusal: no token, wrong token, request through the proxy, acting identifier with no
  link, acting person who is a member but not an editor.
- The outbox writers are tested in the `db` project by performing the change and reading
  the entry.
- A contract test writes the JSON shape of every answer to fixtures that the bot's
  repository copies, so a change to a shape is a deliberate change to a committed file.
- The compose file tests cover the new service, and the cutover script's tests cover the
  pin file and the two health gates.

## 11. Sequence

This work is the first increment of the delivery sequence in the bot spec. It ships with
the bot, in one cutover, rather than as a release of its own: the first tag of the web
platform that pins a bot tag in `deploy/bot-release` is the launch of both. The increments
here still merge to `main` as they are completed, because nothing in them is reachable
without the bot's service token, apart from the cancelled state, the location note and the
interest count, which are small enough to travel with a fix release if one is needed in
between.

The order within it: tables and migrations, the guard and acting middleware, the reading
endpoints, the outbox and its writers, linking and the account page, the acting endpoints,
the personal calendar, then the stack and cutover changes.
