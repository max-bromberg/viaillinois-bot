# Implementation Plan: The VIA Discord Bot

**Spec**: `docs/superpowers/specs/2026-09-04-via-discord-bot.md`
**Depends on**: the web platform plan, `2026-09-04-via-internal-service-api.md`. Increment
1 here can start as soon as web platform increment 2 exists. Everything after that follows
the web platform increment it names.
**Rules that apply**: this repository's `CLAUDE.md`. Every task starts with a failing test.

The plan follows the six increments in section 13 of the spec. Each is a set of pull
requests to `main` with the gate green, and each is exercised against the test Discord
server before it is called done. The bot's first tag is cut when increment 6 is done, and
the launch is the web platform cutover that pins it.

## Increment 1: Foundation

**Goal**: a bot that connects, answers a link command, migrates its own database, reports
health, and passes a gate that has every job the web platform's has.

1. **Scaffold.** `package.json` with Node 20 and ESM, `tsconfig.json` for type checking
   only, `vitest.config.ts` with the `unit` and `db` projects, `docker-compose.test.yml`
   with a throwaway MySQL, `Dockerfile`, `.env.example`, `CHANGELOG.md`, and
   `scripts/check-language.js`, `scripts/version.js` and `scripts/bump-version.sh` carried
   over from the web platform with their tests, reduced to one manifest. The first test in
   the repository is the language check's own suite.
2. **The gate.** `.github/workflows/gate.yml` with `quality`, `database` and `security`
   jobs mirroring the web platform's, plus type checking in `quality`. Enable branch
   protection on `main` requiring all three.
3. **Configuration.** `src/config.ts` reads and validates every variable at startup and
   refuses to start with a sentence naming the missing one. Tested.
4. **Database.** `src/db/client.ts` with Drizzle over one pool, `src/db/schema.ts` with
   every table in section 7 of the spec, `src/db/migrate.ts` mirroring the web platform's,
   and `0000_baseline.sql` generated from the schema. `db` tests: migrations apply from
   empty, the drift check passes.
5. **Health.** `src/health.ts`, a small HTTP listener answering `GET /health` with version,
   migration version, gateway state, database state and web platform state. Tests for each
   503 case.
6. **The web platform client.** `src/via/client.ts` as an interface, `src/via/http.ts` as
   the real implementation with the service token, acting header, request identifier and
   busy handling, and `src/via/fake.ts` serving the fixtures copied from the web platform's
   `server/tests/fixtures/internal`. Tests: the busy answer is retried after the named
   wait and not before, `not_linked` becomes a typed error, every request carries the
   token.
7. **The gateway.** `src/discord/client.ts` with the intents in the spec and nothing more,
   asserted by a test that reads the intent bitfield. `src/discord/adapter.ts` turning a
   library interaction into a plain object and a plain response into library calls, with
   tests on both directions. `src/discord/registerCommands.ts` building the command list
   from the feature registry.
8. **The feature registry.** `src/features/registry.ts` with the type in section 5 of the
   spec and, for now, the two identity features. Tests: every feature has a description
   that passes the language check, every proactive feature names a channel purpose, and
   identifiers are unique.
9. **Linking.** `/link` and `/unlink`, in every context. `/link` asks the web platform for a
   session and answers ephemerally with the address; the outbox consumer is not built yet,
   so this increment polls the link endpoint for a minute after handing out the address
   and confirms in a direct message when it resolves. `/unlink` calls the web platform and
   deletes local rows. Tests against plain interaction objects and the fake client.
10. **Rate windows.** `src/ratelimit/windows.ts` over `Rate_Windows`, with the unlinked,
    linked and per server limits as configuration. `db` tests for the sliding window.

**Done when** a developer runs `npm run dev` with the development Discord application, the
bot appears online in the test server, `/link` completes against a local web platform, and
the gate is green.

## Increment 2: Reading and announcing

**Goal**: servers can be set up, students can read events, and the bot posts on its own.
Follows web platform increments 4 and 5.

1. **Server records.** `Guild_Installations`, `Guild_Features`, `Guild_Channels` and
   `Guild_Followed_Rsos` through `src/guilds/store.ts`, `db` tested. The gateway's guild
   create and delete events create and clean up rows, tested through the adapter.
2. **Setup and configuration.** `/via setup` and `/via config` as the panels in section 5
   of the spec: kind, binding with autocomplete over the RSO list, channels with select
   menus, and the feature list with toggles grouped by category and blocked features
   explained. Binding to an RSO calls the web platform's confirm endpoint. Tests for every
   panel transition, for the refusal of a non manager, and for the refusal of an
   unconfirmed binding. `/via remove` deletes what section 5 says it deletes.
3. **Event commands.** `/events` with the RSO, window and internal options, paged, with
   the card button; `/event` with autocomplete over titles and RSO names, answering the
   card with Remind me, Interested, Add to calendar and Open on VIA; `/rso` with the
   Follow button. Card rendering in `src/render/eventCard.ts`, tested for the campus time
   with the relative timestamp beside it and for the language check on every string.
   Remind me and Interested check the link and offer the Link button when there is none.
4. **Deliveries.** `src/delivery/deliveries.ts` over `Deliveries`: intend, post, record,
   with the key of outbox entry, target and purpose. `db` tests for the retry after a
   crash before the post and the skip after a crash after it.
5. **The outbox consumer.** `src/outbox/consumer.ts` polling with the cursor in
   `Outbox_Cursor`, routing each kind to a handler, advancing the cursor only after every
   delivery is recorded. Tests with the fake client serving a sequence of entries,
   including a crash mid entry and a restart.
6. **Announcements.** Handlers for `event.created`, `series.created`, `event.updated`,
   `event.cancelled` and `event.deleted`: post to the announcements channel of every server
   that follows the RSO, edit in place on change, reply with a notice on a move or a
   cancellation. A series is one announcement. Tests per kind, per server kind.
7. **Native scheduled events.** `src/mirror/scheduledEvents.ts`: create, update and delete
   Discord scheduled events for occurrences inside the server's window, mapped in
   `Event_Mirrors`, rolled forward by a daily job. Interest from the gateway's scheduled
   event user events is sent to the web platform by NetID when linked and by Discord
   identifier otherwise. Tests for the window edge, for a series, and for a server whose
   Manage Events permission was removed, which disables the feature and tells the manager.

**Done when** creating an event on a local web platform announces it in the test server
and it appears in the server's Events tab within seconds.

## Increment 3: The feed

**Goal**: the personal feed in direct messages, and the timed posts in servers.

1. **Time.** `src/jobs/clock.ts` as an injected clock in campus time, and
   `src/jobs/scheduler.ts` running jobs at their hour with a last run record, so a missed
   hour runs once on return. Tests at fixed instants, including the missed hour.
2. **Following.** `/follow`, `/unfollow`, `/following` over `Subscriptions`, in direct
   messages and under user installation. The Follow button on the RSO card does the same.
3. **Preferences.** `/feed settings` opening a panel over `User_Preferences`: digest day and
   hour, reminder lead time, feedback and direct message switches.
4. **Personal digest and reminders.** Jobs that send the weekly direct message for
   followed RSOs and the reminders in `Reminders`, through `Deliveries`. Every direct
   message carries the switch that stops that kind. Tests for the content, the timing, the
   idempotency, and the opt out.
5. **Personal calendar.** `/calendar` creating or rotating the token through the web
   platform and answering with the address, with the followed set sent again whenever it
   changes.
6. **Server digests and reminders.** The weekly digest and the day of reminders in the
   bound channels, with the pinning option, and the living this week message posted once,
   pinned, and edited in place by a job and by the outbox handlers. Tests for grouping by
   day, for the edit in place, and for a server that removed the channel.

**Done when** a linked developer account receives a digest and a reminder from the test
stack at the configured times.

## Increment 4: Campus and midterms

**Goal**: everything a student asks about that is not an event. Follows web platform
increment 4.

1. `/midterms` with course autocomplete, answering confirmed and pending exams.
2. `/courses add`, `/courses remove` and `/courses` over `User_Courses`, and the exam
   reminder job with the midterm outbox handlers for changes to a followed course's exams.
3. Exams this week for community servers, on the bound channel and day.
4. `/rooms` for free rooms with building autocomplete and a window, `/course` for
   sections, `/building` for a code. Rendering tested for the language check and for an
   empty answer that says so in a sentence.

**Done when** each command answers correctly against the fixtures and against a local web
platform with polled data.

## Increment 5: Boards

**Goal**: the scheduler and the allowed administrative actions from Discord, and roles.
Follows web platform increments 6 and 7.

1. **Editor checks.** Every action here calls the web platform with the acting header and
   turns `forbidden` and `not_linked` into the sentences the spec describes. One shared
   test helper covers the three outcomes for every action.
2. **Administrative actions.** `/via postpone`, `/via cancel`, `/via describe`,
   `/via visibility`, `/via repost` and `/via note`, each also a button on the event card
   and the announcement, shown only to linked viewers. Modals for postpone, describe and
   note, pre-filled from the event. Tests for each action's modal, its call, and the
   change announcement that follows through the outbox.
3. **The scheduler.** `/via schedule` calling the recommend endpoint and rendering the
   recommendations with scores, clear weeks and reasons; the Poll button opening a native
   Discord poll over the top candidates in a chosen channel; the poll close event posting
   the result with Accept; Accept re-checking the recommendation, showing any difference,
   and creating the series. Tests for a stale recommendation and for a poll whose channel
   was deleted.
4. **Membership roles.** `/via roles` mapping VIA roles to Discord roles, the
   `membership.changed` handler, the daily reconciliation from the members endpoint, and
   the rule that the bot never removes a role it did not grant, tested against a server
   fixture where a person holds a mapped role granted by hand.
5. **Linked roles.** Register the metadata schema at startup when configured, and offer
   the Discord verification address in `/link`'s answer. The push is the web platform's.

**Done when** a board member on the test server can postpone an event and watch the
announcement change, and can run the scheduler through a poll to a created series.

## Increment 6: Closing the loop

**Goal**: feedback, user installation, and the housekeeping that keeps the bot healthy.

1. **Feedback.** The morning after job selects linked people who marked interest or set a
   reminder, respects both the personal switch and the RSO's switch, sends one message
   with five buttons and the comment modal, and records the answer through the web
   platform. Tests for selection, for both switches, for idempotency, and for a person who
   unlinked in between.
2. **User installation.** Mark every Read and Linked feature for the user installation
   context in the registry, register the application with both contexts, and make answers
   ephemeral in servers that have not installed the bot. Tests on the generated command
   list and on the ephemeral rule.
3. **Housekeeping.** Pruning of `Deliveries` and `Rate_Windows` after ninety days,
   reconciliation from the reading endpoints when the outbox cursor is older than the
   outbox's retention, and the health endpoint reporting both. Tests for each.
4. **Documentation.** `docs/development.md` for running against the development
   application, `docs/deployment.md` rewritten as the procedure, and the README's status
   updated.
5. **Release.** `scripts/bump-version.sh minor` to `v0.1.0`, the gate green on the tag, and
   the tag written to `deploy/bot-release` on the web platform for the launch cutover.

**Done when** the launch cutover brings up all three containers on the server and the
first RSO server completes setup.
