# VIA Discord Bot

**Status**: agreed on 2026-09-04, see section 14 and `docs/decisions.md`
**Date**: 2026-09-04
**Companion spec**: `2026-09-04-via-internal-service-api.md`, which covers the work on the
web platform side that this design depends on.

## 1. Summary

VIA (Virtually Integrated Agenda) is the event management platform for the Electrical and
Computer Engineering department's Registered Student Organizations at the University of
Illinois Urbana-Champaign. It runs at viaillinois.com. Most of those organizations actually
run inside Discord, and the students who would discover their events are already there.

The bot puts VIA inside those servers, inside the ECE community servers, and inside each
student's direct messages, so that VIA exists in Discord and on the website at the same
time. A student sees the same upcoming events, the same midterm schedule and the same
scheduler in whichever place they happen to be. A board sees its events announced where
its members already read, and can do the smaller day to day work of running events without
leaving Discord.

The bot is a public service to the ECE community, maintained to the same production
standards as the web platform.

## 2. Goals and principles

1. **Parity.** Anything a student can read on the website they can read through the bot.
   Anything the website tells people, the bot can tell the servers and the people who asked
   to be told.
2. **Server owners decide.** Every feature can be enabled or disabled per server. Every
   proactive feature posts only to a channel the server chose. Nothing proactive happens in
   a server until that server sets it up.
3. **Identity by link.** A Discord account becomes a VIA account by linking to a NetID
   through viaillinois.com. Linked people can act. Unlinked people can read.
4. **The web platform owns VIA.** The bot reads and writes VIA data through an internal
   service API and never through the web platform's tables. Authorization for anything a
   person does through the bot is decided by the web platform.
5. **Privacy by construction.** The bot never requests privileged gateway intents and never
   stores message content. It stores identifiers and preferences, nothing more.
6. **Production standards.** Test driven development, a release gate, migrations as the
   schema of record, and deploys only through the web platform's cutover script.

## 3. Audiences and environments

The bot serves two groups, and nobody else for now: RSO boards and members, and students
discovering events. It serves them in four environments.

**RSO servers.** A server bound to one RSO. Announcements, digests, reminders and native
scheduled events for that RSO's events. Members of that RSO on VIA can be given a role. The
board can perform the allowed administrative actions on its own events.

**Community servers.** A server for ECE at large, such as a department wide student server
or a class year server. Bound to all of ECE, or to a chosen set of RSOs. The same
announcements and digests, drawn from every followed RSO, plus the midterm schedule.

**Direct messages.** The bot's direct messages are VIA's primary way of reaching a linked
person: a personal feed of the RSOs they follow, reminders for events they asked about,
exam reminders for their courses, and one tap feedback after an event they showed interest
in. A person can only receive direct messages once linked and only about things they opted
into.

**User installation.** Discord lets a person install an application to their own account
rather than to a server. Someone who does that can use the bot's read commands and their
personal feed commands in any server they are in, in group direct messages, and in their
direct messages with the bot, whether or not that server has installed the bot.

## 4. Identity and permission tiers

### Linking

A person links by running the link command anywhere the bot answers. The bot asks the web
platform to open a link session and hands the person a single use address on
viaillinois.com that expires in a few minutes. On that page the person signs in with their
NetID, which the web platform already does through Azure AD, and then authorizes the bot's
Discord application through Discord's own OAuth2 consent screen, which proves they control
the Discord account. The web platform records the link. The bot learns of it through the
outbox described in section 8 and confirms it to the person in a direct message.

The link is a row the web platform owns, between one NetID and one Discord user identifier.
A NetID can be linked to one Discord account at a time, and a Discord account to one NetID.
Linking a second Discord account replaces the first. Either side can unlink: the bot's
unlink command, or the account page on the website. Unlinking deletes the link and every
subscription and preference the bot held for that Discord account.

### Acting as a person

When a linked person does something through the bot, the bot calls the internal service
API with the Discord user identifier it observed in the interaction. It never asserts a
NetID. The web platform resolves the identifier to a NetID through its own link table and
then applies exactly the rules the dashboard applies: the board and editor roles from
`RSO_Memberships`, and the global administrator flag from `Users`. The bot cannot
impersonate a NetID it has no link for, and a rule change on the web platform applies to
Discord the moment it deploys.

### Tiers

| Tier | Who | What they can do |
|---|---|---|
| Read | Any Discord user, linked or not | Look up events, midterms, rooms, courses and buildings |
| Linked | A Discord account linked to a NetID | Everything in Read, plus follow RSOs, receive direct messages, set reminders, mark interest, give feedback, add courses |
| Editor | A linked person whose NetID is an editor or board member of the RSO an event belongs to, as the web platform decides | Everything in Linked, plus the allowed administrative actions on that RSO's events, the scheduler and its polls |
| Server manager | A Discord user with the Manage Server permission in a given server | Set up, configure and remove the bot in that server |

Global administrators of VIA are editors everywhere, as on the web platform. Server
manager is a Discord permission, not a VIA role: the person who manages an RSO's server is
often not on its board, and setting up the bot should not require them to be. Binding a
server to an RSO is the one setup step that also requires the VIA side, because binding is a
claim about who the server speaks for: it needs a server manager who is also linked and is
a board member of that RSO, or a global administrator.

### What stays on the web

Creating and deleting events, importing calendars, managing an RSO's details and membership,
managing midterms, and everything on the administration page stay in the web dashboard.
The bot links to the right page rather than reimplementing any of it.

## 5. Server configuration

Server owner control is a stated goal, so configuration is a first class part of the design
rather than a settings afterthought.

### The feature registry

Every capability the bot has is a named feature in a registry the bot ships with. A feature
declares:

- an identifier and a description a server manager will read,
- its category: command, proactive, roles, or administration,
- its default state on installation,
- the Discord permissions it needs, so setup can tell the manager which grant is missing,
- the channel purposes it needs, if it posts,
- the tier required to use it.

Per server state is stored in `Guild_Features`: one row per feature that a server has
changed from the default, holding whether it is enabled. Channel bindings are stored in
`Guild_Channels`: one row per purpose the server has assigned a channel to. Purposes are
announcements, digest, reminders, exams, and the living this week message. A feature whose
purpose has no channel cannot be enabled, and setup says so.

### Defaults

On installation, read commands are enabled, and nothing else is. No channel is bound, so
nothing is posted, no scheduled event is created, and no role is touched, until a server
manager runs setup. This is deliberate: a bot that starts posting the moment it is invited
is a bot that gets removed.

### Setup

The setup command walks a server manager through, in order: the server's kind, which is an
RSO server or a community server; the binding, which is one RSO, all of ECE, or a chosen set
of RSOs, with autocomplete over RSO names; the channels, one select menu per purpose; and
then a feature list with toggles, grouped by category, showing which features are blocked
by a missing permission or channel. Every step is a Discord component interaction, and the
whole thing can be re-run or changed piecemeal later through a configuration command that
opens the same panels. The panels are ephemeral, so only the manager sees them.

Binding a server to an RSO requires, in addition to Manage Server, that the person is
linked and is a board member of that RSO or a global administrator. The web platform makes
that decision when the bot asks it to confirm the binding. A server can be bound to one RSO
at a time, and an RSO can have many servers.

### Discord's own controls

Discord lets a server restrict which roles and channels each application command may be
used in, through its integration settings. The bot leans on this rather than duplicating
it: a server that wants the events command only in one channel sets that there. The bot's
own configuration is for what Discord cannot express, which is what the bot does on its own
initiative and where.

### Removal

A server manager can remove the bot's presence with one command, which deletes every
scheduled event the bot created, unpins the living message, and deletes the server's rows.
Kicking the bot does the same on the next gateway notice. Nothing about the people who used
the bot in that server is deleted, because their links and subscriptions are theirs, not
the server's.

## 6. The first release

Horizon one, as agreed, is the scope of the first public release. It is listed here by
group. Each feature names its registry identifier, the tier it needs, and the internal
service API it depends on. The API itself is specified in the companion document.

### 6.1 Linking and roles

**Account linking** (`identity.link`). The link and unlink commands and the flow in section
4. Available everywhere, including user installation and direct messages. Depends on the
link session and link lookup endpoints and on the `link.completed` and `link.revoked`
outbox kinds.

**Linked roles** (`roles.linked`). Discord's linked roles let an application publish a small
set of facts about a person, which a server can then require for a role in its own role
settings, using Discord's own verification screen. The bot registers three facts: that the
person has a verified NetID, whether they sit on any RSO board, and the date they linked.
Any server, whether or not it has run setup, can then require a verified NetID for a role,
which is a problem every RSO server already has and currently solves by hand. The facts are
pushed by the web platform when a link is made and whenever a membership changes, because
the web platform holds the Discord authorization from the link flow. The bot's part is
registering the metadata schema once, at startup.

**Membership roles** (`roles.membership`). In a server bound to an RSO, the server manager
can map VIA's three membership roles, member, editor and board, to Discord roles. The bot
assigns and removes those roles as memberships change, driven by the `membership.changed`
outbox kind, and reconciles the whole server once a day. The bot only ever touches roles it
was mapped to, and it never removes a role it did not grant. Requires the Manage Roles
permission and a bot role above the mapped roles.

### 6.2 Reading events

**Upcoming events** (`events.list`, Read). Lists what is coming up, with options for an RSO
(autocomplete), a window (today, this week, next week, this month), and whether to include
events marked internal, which are shown only to linked members of that RSO. The answer is
one message with compact rows, a page control, and a button on each row that opens the
event card. Times are shown as the campus wall clock, as on the website, with Discord's
relative timestamp beside it so a reader in another zone still knows how far away it is.

**Event card** (`events.detail`, Read). One event, found by autocomplete over titles and
RSO names. The card shows title, RSO, when, where with a link to the room, description, and
buttons: Remind me, Interested, Add to calendar, and Open on VIA. Remind me and Interested
need a link and say so gently if there is none, with a Link button. Add to calendar answers
with an `.ics` file for that event.

**RSO card** (`rsos.detail`, Read). One RSO, its description, its next few events, and a
Follow button.

### 6.3 Proactive posting

Every proactive feature posts to the channel bound to its purpose, and every post is
recorded in `Deliveries` so that a restart never posts twice. Recurring series are handled
as one thing: a new weekly meeting series is announced once, listing its pattern and end
date, and never as sixteen separate announcements.

**New event announcements** (`announce.new`). When an event or series is created for an RSO
the server follows, the bot posts an announcement card with the same buttons as the event
card. Driven by the `event.created` and `series.created` outbox kinds.

**Change announcements** (`announce.changes`). When an announced event moves, changes room,
is cancelled, or is deleted, the bot edits its original announcement in place to reflect
the new state and, for a move or a cancellation, posts a short notice that replies to the
original. Driven by `event.updated`, `event.cancelled` and `event.deleted`.

**Weekly digest** (`announce.digest`). On a day and hour the server chooses, in campus time,
one message listing the coming week's events for the followed RSOs, grouped by day. A server
can choose to have the digest pinned and the previous one unpinned.

**Day of reminders** (`announce.dayof`). At a lead time the server chooses, a short reminder
for each event that day, with a link to the card.

**Native scheduled events** (`mirror.scheduled`). Each upcoming event is mirrored into the
server's own Events tab as a Discord scheduled event of the external kind, carrying the
place and time, so members can mark themselves interested with Discord's own control and
get Discord's own reminders. Only occurrences within a rolling window, two weeks by default and
adjustable per server, are mirrored, so a term of weekly meetings does not flood the tab,
and the window rolls forward daily. When a member marks interest, the gateway tells the bot, and the bot records
it on VIA as an interest signal: by NetID for a linked person, and as an anonymous count
for anyone else. Interest is what replaces the RSVPs the web platform removed. Requires the
Manage Events permission. Mappings live in `Event_Mirrors`.

**Exams this week** (`announce.exams`). For community servers, on a chosen day, a message
listing the confirmed midterms in the coming week, grouped by day.

**Living this week message** (`living.thisweek`). One message the bot posts once, pins, and
then edits in place whenever the week's events change, so the channel always has a current
list at the top. This is the kiosk's rotating list as a Discord surface.

### 6.4 The personal feed

All of these work in the bot's direct messages and under user installation, and need a
link.

**Follow RSOs** (`feed.follow`). Follow and unfollow RSOs, or follow everything. Followed
RSOs drive the personal digest and the personal reminders. Stored in `Subscriptions`.

**Personal digest and reminders** (`feed.digest`, `feed.reminders`). A weekly direct message
of what is coming up for followed RSOs, at a chosen day and hour, and a reminder before each
event the person asked to be reminded of, at a chosen lead time. Preferences in
`User_Preferences`, one off reminders in `Reminders`.

**Personal calendar** (`feed.calendar`). A private calendar subscription address, served by
the web platform, that carries every event of the RSOs the person follows, so their phone's
calendar stays current without the bot doing anything further. The address embeds a token
the person can rotate from the bot.

**My courses and exam reminders** (`feed.courses`). Add and remove courses by autocomplete.
The bot sends a reminder ahead of each confirmed midterm for those courses, and a notice
when a midterm for one of them is added or changed. Stored in `User_Courses`.

**Feedback after an event** (`feedback.request`). The morning after an event, a linked
person who had marked interest or set a reminder for it receives one direct message with
five buttons, one to five, and an optional comment through a modal. The answer is recorded
on VIA against the event by NetID, and the board sees the aggregate on the RSO's statistics
page. A person can turn these off entirely, and a server bound to an RSO can turn off
feedback collection for that RSO's events. This is the first thing the bot sends that the
person did not explicitly ask for, so it is one message, once, with an off switch in it.

### 6.5 Midterms and campus lookups

**Midterm lookup** (`midterms.lookup`, Read). A course by autocomplete, answered with its
confirmed midterms, their rooms and times, and whether one is pending confirmation.

**Free rooms** (`campus.rooms`, Read). A building and a time window, answered with the
rooms in that building that have no facility reservation, no course section and no VIA
event overlapping the window, as the web platform's conflict detection already computes.

**Course lookup** (`campus.course`, Read). A course by autocomplete, answered with its
sections, their meeting times and rooms, from the courses poller's data.

**Building lookup** (`campus.building`, Read). A building code or name, answered with the
full name and address, from the web platform's building code table.

### 6.6 The scheduler

**Recommend** (`scheduler.recommend`, Editor). A board member asks, for their RSO, which
evening works, either for one week or for the rest of the term, with the same options the
dashboard offers. The bot calls the same scheduler the dashboard calls and shows the top
recommendations with their scores, the number of clear weeks, and the reasons.

**Poll** (`scheduler.poll`, Editor). From a recommendation message, a board member can open
a native Discord poll over the top few candidates in a channel of their choice, so member
availability joins the campus data. When the poll closes, the bot posts the result with an
Accept button.

**Accept** (`scheduler.accept`, Editor). Accepting a recommendation, from the
recommendation message or from the poll result, asks the web platform to create the series
exactly as the dashboard would. The bot re-checks the recommendation first, because rooms
and exams may have changed while the poll ran, and shows the difference before creating
anything.

### 6.7 Allowed administrative actions

All of these need the Editor tier for the event's RSO, as the web platform decides. Each is
a button on the event card and on the announcement, shown only when the viewer is linked,
and refused with a sentence if the web platform declines. Each is also a command, for
people who prefer typing. Every action is recorded by the web platform as the acting
person's action, exactly as if done on the dashboard.

- **Postpone** (`admin.postpone`): a modal for the new start and end, and an optional
  reason, which is included in the change notice.
- **Cancel** (`admin.cancel`): a confirmation, then the event is cancelled on VIA, and the
  change announcement follows.
- **Edit description** (`admin.describe`): a modal pre-filled with the current description.
- **Toggle internal** (`admin.visibility`): switch an event between public and internal.
- **Re-post** (`admin.repost`): post the announcement card again in the announcements
  channel, or in the channel the command was run in.
- **Pin a location note** (`admin.locationnote`): a short note, such as the room being
  changed at the door or where to find the entrance, attached to the event and shown on the
  card and the announcement.

Creating an event draft from a message, which is also an allowed action, is scheduled for
the second horizon and is described in `docs/roadmap.md`.

### 6.8 User installation

**User installed contexts** (`install.user`). The application is published with both
installation contexts, server and user. Every Read and Linked feature is marked as usable in
the user context, so a person who installed the bot to their account can use it in servers
that have not installed it. Proactive features and administrative actions are server
context only, because they act on a server. Answers in a server that has not installed the
bot are ephemeral by default, so the bot does not post into channels it was not invited to.

## 7. Architecture

### Containers

The bot is a third service, `via-bot`, in the web platform's Docker Compose stack, on the
same virtual private server. It joins the stack's private database network to reach MySQL
and the shared `internal` network to reach the web platform's container by service name. It
exposes one port on the host, for its health endpoint, and nothing else. It runs with a
memory and processor ceiling like the other two containers.

### Language

The bot is written in TypeScript throughout and run through Node's type stripping, with no
build step, which is how the web platform already runs its Drizzle and migration files.
Tests run the same files through Vitest.

### The gateway

The bot holds one gateway connection, as a single shard, which is ample for the number of
servers involved. It requests only the unprivileged intents it needs: guilds, guild
scheduled events, guild members for role synchronisation, and direct messages. It never
requests the message content intent or the presence intent. Message text reaches the bot
only inside a context menu interaction on a specific message, which Discord delivers as part
of the interaction, and the bot uses it for that interaction and discards it.

Application commands are registered globally at startup from the feature registry, so a
change to the registry is a change to the commands. Student facing commands sit at the top
level, so a student types `/events`, `/midterms` or `/rooms`, and everything for setup and
for boards sits under one `/via` group, so a manager types `/via setup` and a board member
`/via postpone`. Every interaction is acknowledged
within Discord's deadline and then answered, so a slow web platform shows as a "thinking"
state rather than a failed command.

### The web platform client

One module wraps the internal service API. It attaches the service token, the acting
Discord user identifier when there is one, and a request identifier, and it understands the
web platform's refusal shape: a busy answer is retried with the delay the web platform
names, and an authorization refusal is turned into the sentence the person sees. Hot reads,
which are the upcoming events for an RSO and the RSO list, are cached for a minute, and the
cache is invalidated when an outbox entry touches the RSO.

### The outbox consumer

A single loop polls the outbox endpoint every few seconds with the cursor it last reached,
stored in `Outbox_Cursor`, and handles each entry in order. Handling an entry means deciding
which servers and which people it concerns and writing one `Deliveries` row per intended
post before posting it, keyed by outbox entry, target and purpose, so that a crash between
the write and the post is retried and a crash after the post is not. The cursor advances
only after every delivery for the entry is recorded. This gives at least once delivery from
the web platform and exactly once posting to Discord under any single failure.

### Scheduled jobs

Digests, reminders, exam notices, feedback requests, the scheduled event window roll, the
living message refresh, and the daily role reconciliation are jobs on a clock in campus
time. Each job is idempotent through `Deliveries`, and each records when it last ran, so a
bot that was down over a digest hour sends the digest when it returns rather than skipping
the week or sending it twice.

### The bot database

Its own database, `via_bot`, inside the existing MySQL container, with its own account that
cannot see the web platform's database. Drizzle from day one, and migrations under
`src/db/migrations` as the schema of record, applied by a migrate script the cutover runs.

| Table | What it holds |
|---|---|
| `Guild_Installations` | One row per server: kind, binding (one RSO, all, or a set), who installed it and when |
| `Guild_Followed_Rsos` | For a community server bound to a set, the RSOs in the set |
| `Guild_Features` | One row per feature a server changed from the default |
| `Guild_Channels` | One row per channel purpose a server bound |
| `Guild_Role_Mappings` | VIA membership role to Discord role, per server |
| `Event_Mirrors` | VIA event to Discord scheduled event and announcement message, per server |
| `Deliveries` | Every post, edit and direct message the bot intended, keyed for idempotency |
| `Subscriptions` | A Discord user follows an RSO, or everything |
| `User_Preferences` | Digest day and hour, reminder lead time, feedback opt out, direct message opt out |
| `Reminders` | One off reminders a person asked for |
| `User_Courses` | Courses a person added for exam reminders |
| `Outbox_Cursor` | The last outbox entry handled |
| `Rate_Windows` | Sliding windows for the bot's own rate limits |

The bot stores Discord identifiers and VIA identifiers and nothing that identifies a person
beyond those. It never stores a NetID: when it needs to know who a Discord user is, it asks
the web platform, and it caches the answer briefly in memory.

### Health

`GET /health` on the bot's port reports the bot version, the migration version, whether the
gateway is connected, whether the database answers, and whether the web platform's internal
API answers, with a 503 when any of those is false. The cutover gates the bot's deploy on
it, exactly as it gates the web platform's on the web platform's.

## 8. The outbox

The outbox is how the web platform tells the bot that something happened. It is a table the
web platform writes and an endpoint the bot reads, specified fully in the companion
document. The kinds the first release needs are:

- `event.created`, `event.updated`, `event.cancelled`, `event.deleted`
- `series.created`, `series.updated`, `series.deleted`
- `midterm.confirmed`, `midterm.updated`, `midterm.cancelled`
- `membership.changed`
- `link.completed`, `link.revoked`

Each entry carries the kind, the identifiers involved, and a snapshot of the object after
the change, so the bot can post without a second round trip in the common case.

## 9. Rate limits and abuse

Three limits apply, and all three answer with a sentence and a wait rather than silence.

- **Per Discord user.** A sliding window of commands per hour, tighter for unlinked users
  than for linked ones, because a linked person is accountable through a NetID. Stored in
  `Rate_Windows`.
- **Per server.** A ceiling on commands per hour from one server, so a script in one server
  cannot starve the others.
- **From the web platform.** The internal service API is exempt from the public traffic
  budgets and is refused last under load shedding, but it can still say busy. The bot
  honours the wait it names and does not retry inside it.

Discord's own rate limits are handled by the library, and the bot's proactive jobs spread
their posts rather than firing every server's digest in the same second.

## 10. Privacy and retention

- The bot never requests the message content intent and never stores message text.
- The link between a Discord account and a NetID lives on the web platform. The bot holds
  Discord identifiers only.
- Interest from an unlinked person is recorded as a salted hash of their Discord identifier,
  so it is deduplicated and reversible by nobody.
- Direct messages are sent only to linked people and only about things they opted into, and
  every direct message the bot sends carries a way to stop that kind of message.
- Unlinking deletes every subscription, preference, reminder and course the bot held for
  that account, on both sides.
- `Deliveries` and `Rate_Windows` rows are pruned after ninety days. Nothing else is
  retained beyond its use.
- Nothing about a server's members is read except what a mapped role needs, and role
  reconciliation reads membership from VIA, not from Discord.

## 11. Deployment and versioning

The bot has its own semantic version, its own changelog and its own `v*` tags, cut with a
bump script that mirrors the web platform's: it refuses a dirty tree and refuses to run off
`main`. The bot's gate runs on the tag.

Deployment is shared. The web platform's repository pins the bot tag it deploys in one
file, `deploy/bot-release`, and its Compose file declares the `via-bot` service with a build
context that is a checkout of this repository at that tag, beside the web platform's
checkout on the server. The web platform's cutover script grows the steps the bot needs,
in the same order it already follows for the web platform: build both images before
touching anything, back up both databases and prove the backups restore, stop both
application containers, migrate the web platform, migrate the bot, start both, and gate on
both health endpoints, with a rollback that restores both databases and checks out both
previous tags. A release of the bot alone is a change to `deploy/bot-release` on the web
platform and a cutover; a release of the web platform alone leaves the pinned bot tag
where it is. The full procedure will live in `docs/deployment.md` here and in the web
platform's own deployment document.

The gate in this repository has the same three classes of job as the web platform's:
quality (version and changelog consistency, the language check and its tests, the bump
script tests, type checking, unit tests, coverage reported and never enforced), database
(migrations apply cleanly from an empty database, the Drizzle drift check, the database
backed tests), and security (`npm audit` at high severity and secret scanning over the full
history). All are required by branch protection on `main`.

## 12. Testing

Vitest, with the same `unit` and `db` projects as the web platform. Three seams are designed
in so that most tests need neither Discord nor the web platform:

- **Interactions** arrive through a thin adapter that turns a library interaction into a
  plain object and turns a plain response into library calls. Commands are tested against
  plain objects.
- **The web platform client** is an interface with a real implementation over HTTP and a
  fake that serves fixtures. Fixtures are the recorded shapes of the internal service API,
  and the companion document's contract tests on the web platform side check that the API
  still produces those shapes.
- **Time** is injected, so digests, reminders and the mirroring window are tested at fixed
  instants in campus time.

Delivery idempotency, the outbox cursor, and rate windows are tested against the real
database in the `db` project, because their correctness is about what the database
guarantees.

Against a real Discord, development uses a separate development Discord application and
one shared test server, run from a developer's machine against a local stack. There is no
staging copy of the stack on the server.

## 13. Delivery sequence

The first release is horizon one as a whole, but it lands in increments so that each is
testable and reviewable on its own against the test Discord server. The web platform work
in the companion document comes first in order, because everything here depends on it, and
the two ship together: no web platform release is cut for that work on its own, and the
first cutover that pins a bot tag is the launch of both. Web platform increments still
merge to `main` as they are completed, and if a fix has to be released in between, the
internal service API travels with it inert, since nothing can reach it without the bot's
service token.

1. **Foundation.** Repository scaffold, gate, database and migrations, the gateway client,
   the web platform client, health, the feature registry, and the Compose and cutover
   changes on the web platform. Nothing user facing beyond a working link command.
2. **Reading and announcing.** Event commands, RSO card, server setup and configuration,
   new event and change announcements, the outbox consumer, and native scheduled events with
   interest signals.
3. **The feed.** Following, personal digest and reminders, the personal calendar, weekly
   digest and day of reminders in servers, and the living this week message.
4. **Campus and midterms.** Midterm lookup, my courses and exam reminders, exams this week,
   free rooms, course and building lookup.
5. **Boards.** The scheduler with polls and acceptance, the allowed administrative actions,
   membership roles and linked roles.
6. **Closing the loop.** Feedback after an event, user installation contexts, and the
   pruning and reconciliation jobs.

An implementation plan per increment will be written under `docs/superpowers/plans` once
this specification is agreed.

## 14. Decisions on the points the draft left open

These were put as options and decided on 2026-09-04. The reasoning is in
`docs/decisions.md`.

1. **Interest for unlinked people** is counted, keyed by a salted hash of the Discord
   identifier, so the count that replaces RSVPs is honest and nobody can reverse it.
2. **Linked roles** are refreshed: the web platform keeps the Discord authorization from
   the link flow, encrypted at rest, and re-pushes the facts when a membership changes.
3. **Feedback requests** go to anyone linked who marked interest in the event or set a
   reminder for it. When check in exists, attendance replaces that signal.
4. **Binding a server to an RSO** requires a server manager who is linked and on that
   RSO's board, or a global administrator.
5. **The mirroring window** defaults to two weeks and is a per server setting.
6. **Cancelling** is a state of its own on the web platform, not a delete.
7. **The deploy** builds the bot from a sibling checkout pinned by a file in the web
   platform's repository, with no image registry.
8. **The web platform work and the bot ship together**, in one cutover.
9. **Commands** are top level for students and under one `/via` group for setup and boards.
10. **The bot is TypeScript** run through Node's type stripping, with no build step.
11. **Real Discord testing** uses a development application and one shared test server from
    a developer's machine, with no staging server.
