# Implementation Plan: The Internal Service API and the Web Platform Work

**Spec**: `docs/superpowers/specs/2026-09-04-via-internal-service-api.md`
**Repository**: `viaillinois`, the web platform. When this plan is picked up, copy it and its
spec into that repository's `docs/superpowers` directory and keep the two in step.
**Rules that apply**: the web platform's `CLAUDE.md`. In particular, every task below starts
with a failing test, every schema change is a migration generated from the Drizzle schema,
and new data access is written with Drizzle.

The plan is eight increments. Each is one pull request to `main` with the gate green, and
each leaves the platform deployable, since nothing here is reachable without the bot's
service token except the changes increment 3 makes to events. Nothing is released on its
own: the launch is the web platform tag that first pins a bot tag.

## Increment 1: Tables and migrations

**Goal**: every new table exists, declared in Drizzle and applied by a generated migration.

1. Declare in `server/db/schema/schema.ts`: `Discord_Links`, `Link_Sessions`, `Outbox`,
   `Event_Interest`, `Event_Feedback`, `Personal_Calendars`, with the columns in the spec.
   Add `cancelled_at` and `location_note` to `Events`. Add relations in `relations.ts`.
2. Generate one migration per concern so that each is readable on its own:
   `0009_discord_links.sql`, `0010_outbox.sql`, `0011_event_cancellation_and_location_note.sql`,
   `0012_event_interest_and_feedback.sql`, `0013_personal_calendars.sql`. Each carries the
   explanatory comment block the existing migrations carry, saying why the table exists.
3. Tests, in the `db` project: migrations apply from empty, the drift check passes, and one
   test per constraint that matters: a second `Discord_Links` row for the same NetID is
   refused, a second `Event_Interest` row for the same subject and event is refused, a
   `Discord_Links` row whose NetID has no `Users` row is refused.

**Done when** the `database` job of the gate is green and `GET /health` reports the new
migration version locally.

## Increment 2: The guard and the acting middleware

**Goal**: `/internal/v1` exists, refuses everything without the service token, and can act
as a linked person.

1. `server/middleware/internalGuard.js`. Failing tests first: no header answers 401 with no
   body beyond the error shape, a wrong token answers 401, a request carrying the proxy's
   forwarded headers answers 404 even with the right token, and each refusal is recorded
   through `denialRecorder` with reason `internal_unauthorized`. Then the implementation,
   comparing the token in constant time.
2. `server/middleware/actingUser.js`. Tests: an `X-Via-Acting-Discord-User` header that
   resolves through `Discord_Links` sets `req.user` to the same shape `attachUser` builds,
   including `is_global_admin`; an unknown identifier answers 403 with code `not_linked`;
   no header leaves `req.user` unset. Then a test that `requireRSOEditor` from
   `server/middleware/auth.js` passes for a linked editor and refuses a linked member, using
   the real middleware unchanged.
3. Exemptions. Tests in the existing suites: `publicApiBudget` does not count a request
   under `/internal`; `loadShed` assigns `/internal` a tier above a signed in write and
   refuses it only at the highest level; the login limiter is not mounted on the router.
4. Error shape. A helper that answers `{ error, code }`, and a test that every refusal in
   this increment carries one of the codes the spec lists.
5. Mount the router in `server/app.js` under `/internal/v1`, before the public routers, with
   `X-Via-Internal-Api-Version` set from `APP_VERSION` on every answer.

**Done when** a request with the token and no acting header reaches an empty router and
answers 404 with the version header, and every refusal above is tested.

## Increment 3: Cancellation, the location note and the interest count on the web

**Goal**: the three things a student will notice, done first because they are the only part
of this work the public sees and they should settle before the bot depends on them.

1. Cancellation. Tests on `listEvents` in `server/controllers`: a cancelled event is absent
   from the upcoming feed, present in the archive with a cancelled marker, and its own page
   says it was cancelled. `deleteEvent` is unchanged. A new controller action sets
   `cancelled_at`, gated by `requireRSOEditor`, reachable from the dashboard's event menu.
   Client: the event page and the event card show the state.
2. Location note. `updateEvent` accepts `location_note`, the event page shows it beside the
   room, and the dashboard form has the field.
3. Interest count. `getEvent` answers with `interest_count` from `Event_Interest`, the event
   page shows it, and `getRsoStats` includes it per event.
4. Language check on every new string.

**Done when** the three changes are visible in the client, and the `CHANGELOG.md` entry
under Unreleased describes them in the changelog's voice.

## Increment 4: Reading endpoints

**Goal**: everything the bot reads, served under `/internal/v1`, with Drizzle.

1. `server/routes/internal/reading.js` and `server/db/queries/internalReads.ts`. One
   endpoint at a time, each with request level tests first: `GET /rsos`, `GET /rsos/{id}`,
   `GET /events` with the feed's filters and ceilings, `GET /events/{id}` with its series
   and interest count, `GET /events/{id}/calendar` reusing `server/lib/ics.js`,
   `GET /midterms`, `GET /courses` with sections on request, `GET /locations`,
   `GET /locations/free` reusing `server/services/conflictDetector.js`, and
   `GET /buildings/{code}` from `server/lib/buildingCodes.js`.
2. Internal events. Tests: `GET /events` omits `is_private` events with no acting header,
   omits them when the acting person is not a member of that RSO, and includes them when
   they are.
3. Times. A test that every time in every answer carries the campus offset, using the
   helpers in `server/lib/timezone.js`.
4. `GET /rsos/{id}/members` gated by `requireRSOAdmin`, for role reconciliation.
5. Contract fixtures. A test that serialises one answer per endpoint to
   `server/tests/fixtures/internal/*.json` and fails when the committed file differs. Those
   files are what the bot's fake client serves.

**Done when** every endpoint has tests for its filters and its refusals, and the fixtures
directory is committed.

## Increment 5: The outbox

**Goal**: every change the bot needs to hear about writes an entry, and the bot can read
them in order.

1. `server/db/queries/outbox.ts` with `writeOutbox(kind, subject, payload)`, tested in the
   `db` project.
2. The writers, one at a time, each with a `db` test that performs the change through the
   controller and reads the entry: `createEvent`, `createEventSeries`, `updateEvent`
   including the series editing paths, the new cancel action, `deleteEvent`,
   `importEvents` from `server/services/calendarImport.js`, `updateMidtermStatus`,
   `createMidterm`, `deleteMidterm`, `addMember`, `removeMember`, and role changes on a
   membership. Where a controller runs inside a transaction, the entry joins it; where it
   does not, the entry follows the change and a test proves the order.
3. `GET /outbox?after&limit` with the paging ceilings, tested for order, for the `after`
   cursor, and for the limit.
4. A pruning job in the existing poller framework under `server/services`, deleting entries
   older than thirty days, with a test.

**Done when** the payload of every kind matches the shape the bot spec expects, and those
shapes are in the contract fixtures.

## Increment 6: Linking and the account page

**Goal**: a person can link and unlink a Discord account, and linked role facts are pushed.

1. Link sessions. `POST /links/sessions` creates a `Link_Sessions` row and answers with the
   address and expiry. Tests: the address embeds the session id, the expiry is ten minutes
   out, a second call for the same Discord user replaces the first.
2. The page. A Svelte route at `/link/discord/[session]` that requires sign in, explains the
   link, and offers the button. Tests in the client suite for the signed out redirect and
   for the expired session message.
3. The Discord OAuth2 flow in `server/routes/auth.js`: `/auth/discord/start` builds the
   authorization address with a signed `state`, and `/auth/discord/callback` exchanges the
   code, reads the identity, compares it to the session, writes the link, marks the session
   completed, and writes `link.completed`. Tests with the Discord endpoints mocked: a
   mismatched identity is refused, an expired session is refused, a tampered state is
   refused, a NetID already linked elsewhere is relinked and the old row is gone.
4. Linked roles. `server/services/linkedRoles.js`: registers the metadata schema once at
   startup when `DISCORD_CLIENT_ID` is set, pushes the three facts on link, refreshes the
   token from the encrypted `discord_authorization` column and re-pushes on
   `membership.changed`. Encryption in `server/lib/secretBox.js` with `DISCORD_LINK_KEY`,
   tested for round trip and for refusing a wrong key.
5. Unlinking. `DELETE /links/{discordUserId}` and the account page's control both delete the
   row, clear the facts if an authorization is held, and write `link.revoked`.
6. `GET /links/{discordUserId}` with the person's memberships, tested for the 404.

**Done when** a developer can link a test Discord account end to end against a local stack
with a development Discord application.

## Increment 7: Acting endpoints and the personal calendar

**Goal**: every action the bot performs for a person, and the calendar subscription.

1. `server/routes/internal/acting.js`. Each endpoint reuses the controller function the
   dashboard route calls, so the behaviour cannot drift: `POST /events/{id}/postpone`,
   `POST /events/{id}/cancel`, `PATCH /events/{id}` for description, `is_private` and
   `location_note`, `POST /scheduler/recommend` calling the same function as
   `server/routes/scheduler.js`, and `POST /events/series` calling `createEventSeries`.
   Tests per endpoint: a linked editor succeeds, a linked member is refused with
   `forbidden`, an unlinked identifier is refused with `not_linked`, and the change is
   recorded as the acting person.
2. `PUT /events/{id}/interest`: with an acting header the subject is the NetID, without one
   the body carries the Discord identifier and the subject is `h:` plus its salted hash
   from `DISCORD_INTEREST_SALT`. Tests: idempotent set, clear, and that the hash never
   appears in any answer.
3. `POST /events/{id}/feedback` with `requireAuth`, one row per person per event, tested for
   the rating range and for the replace on a second submission. `getRsoStats` gains the
   average, the count and the comments, never the raters.
4. `POST /guilds/bindings/confirm` with `requireRSOAdmin`, answering yes or a refusal.
5. Personal calendar. `POST /calendars/personal` creates or rotates the token and stores the
   hash and the RSO set; `GET /calendar/personal/{token}.ics` on the public router, exempt
   from the row budget in the same way the term calendar is, answering the followed RSOs'
   events through `server/lib/ics.js`. Tests: a rotated token invalidates the old one, an
   unknown token answers 404 with nothing else.

**Done when** every acting endpoint is tested for all three outcomes and the calendar
subscribes in a real calendar application from a developer's machine.

## Increment 8: The stack and the cutover

**Goal**: one cutover deploys both services.

1. `docker-compose.yml` gains the `via-bot` service as the spec describes, and the database
   service gains an initialisation script under `server/db/init/` that creates the `via_bot`
   database and its account from `BOT_DB_USER` and `BOT_DB_PASSWORD`. Extend
   `scripts/tests/composeFile.test.js` first: the service exists, it is on both networks,
   it has ceilings, it sets `TZ`, it depends on the database and on the web platform, it
   exposes one port, and it never receives the web platform's database account.
2. `deploy/bot-release` with the first bot tag, and a test in `scripts/tests` that the file
   holds exactly one `v*` tag.
3. `scripts/cutover.sh`: read the pin, refuse a missing or dirty sibling checkout, fetch and
   check out the bot tag, build both images before the window, back up both databases and
   verify both, stop both, migrate the web platform then the bot, start the web platform
   and gate on `HEALTH_URL`, start the bot and gate on `BOT_HEALTH_URL`, and roll back both
   on failure. The backup and restore scripts under `server/db/backup` take the database
   name. Extend the cutover's tests for the ordering and for each new refusal.
4. `.env.example` and `docs/deployment.md` describe the new variables and the procedure.
   The README's stack table gains the bot.
5. The gate's `database` job runs the initialisation script against the throwaway
   database so a broken script fails in CI rather than on the server.

**Done when** a local cutover against `docker-compose.dev.yml` brings up all three
containers and both health endpoints answer.
