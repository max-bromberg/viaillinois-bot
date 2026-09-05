# Decision log

One entry per decision that shapes the bot or the work it requires on the web platform.
Each entry records what was decided and why, so that a later contributor can tell a
deliberate choice from an accident. Reversing a decision adds a new entry rather than
editing the old one.

## 2026-09-04: The bot serves the whole ECE community, with no third audience

The bot is for RSO boards, RSO members, and students discovering events. There is no
department staff audience and no HKN specific audience for now. Every feature is judged by
whether it serves one of those two groups.

## 2026-09-04: Parity is the product

A student in Discord should feel that VIA exists in their RSO server and in their direct
messages just as fully as it exists on the website. This is the principle every feature
is measured against, and it is why the bot both posts proactively and answers on demand.

## 2026-09-04: The bot is installed in RSO servers and in ECE community servers

Both are first class. An RSO server is bound to one RSO. A community server follows all of
ECE, or a chosen subset of RSOs. The bot has to fulfil its purpose in both.

## 2026-09-04: Direct messages are VIA's primary communication medium once accounts are linked

Once a Discord account is linked to a NetID, the bot's direct messages become the main way
VIA reaches that person: reminders, a personal feed, feedback requests, and, later,
anything the platform needs to tell a board member.

## 2026-09-04: Unlinked Discord users get read only access under tighter limits

Anyone can ask the bot what is coming up. Only a linked account can subscribe, mark
interest, act on an event, or receive direct messages. Unlinked use is rate limited more
tightly than linked use.

## 2026-09-04: Serious administration stays on the web, lower actions are allowed in Discord

Creating and deleting events, managing RSO details and membership, and anything a global
administrator does stay in the web dashboard. The actions allowed from Discord are:
postponing an event, cancelling an event, editing a description, toggling whether an event
is internal, re-posting an announcement, pinning a location note, creating an event draft
from a message, asking the scheduler for a recommendation, opening a poll over its
recommendations, and accepting a recommendation.

## 2026-09-04: Server owners configure everything

A server owner or manager can enable or disable every feature individually, choose the
channel each proactive feature posts to, and remove the bot's presence from their server
entirely. Nothing proactive is on until a server chooses it.

## 2026-09-04: The bot reaches VIA through an internal service API, not through the tables

The bot is a third container in the web platform's Compose stack, with its own database
inside the existing MySQL container for the tables only the bot needs. VIA's own data is
read and written through an internal service API on the private network. The reasons are
that authorization stays in one place, the schema stays owned by one repository, and
change notification has a clean shape. Direct table access was considered and rejected, and
the spec records the one relaxation that would be acceptable later: a single read only
path, converted deliberately, with tests, if it ever proves too slow over HTTP.

## 2026-09-04: The first release is the whole of horizon one

Horizon one, as listed in the bot specification, is the scope of the first public release.
It includes account linking, linked roles, server setup and per feature configuration, event
commands, proactive announcements and digests, native scheduled event mirroring, the
personal feed in direct messages, midterms, the scheduler with polls, the allowed
administrative actions, campus lookups, post event feedback, and installation to a user's
own account. The work lands in ordered increments so that each is testable and deployable,
but the release is judged as one.

## 2026-09-04: The bot may ask for any permission it needs at install time

Managing scheduled events and managing roles are visible asks to a server owner. They are
acceptable, because the features that need them are the features that make the bot worth
installing.

## 2026-09-04: Same gate, same language rules as the web platform

The bot repository runs a gate with the same three classes of job as the web platform, and
the same rule against em dashes and en dashes, repository wide, with no exceptions.

## 2026-09-04: Interest from unlinked people is counted through a salted hash

The count that replaces RSVPs has to include the people who press Interested on a mirrored
scheduled event without ever linking, or it undercounts the very people the feature is for.
A salted hash of the Discord identifier deduplicates them and is reversible by nobody.

## 2026-09-04: Linked role facts are refreshed, so the web platform keeps the Discord authorization

The board fact would otherwise go stale the day a person leaves a board. The refresh token
is encrypted at rest with a key in the stack's environment file, it is the only secret the
web platform keeps on a person's behalf, and it is dropped when the link is removed.

## 2026-09-04: Feedback requests go to people who marked interest or set a reminder

Until check in exists, those are the two signals that a person meant to go. When
attendance exists, it replaces them.

## 2026-09-04: Binding a server to an RSO requires a board member

A binding is a claim that a server speaks for an RSO. The server manager who makes it must
be linked and on that RSO's board, or a global administrator. A member setting the bot up
for a board that has not got round to it is refused, and told who can.

## 2026-09-04: The mirroring window defaults to two weeks

Two weeks keeps a server's Events tab useful without flooding it with a term of weekly
meetings. It is a per server setting.

## 2026-09-04: Cancelling an event is a state, not a delete

A cancelled event that vanishes cannot tell the students who planned to attend that it was
cancelled rather than mistyped. The web platform gains a cancelled state, the feed hides
cancelled events by default and shows them in the archive, and the outbox distinguishes a
cancellation from a deletion.

## 2026-09-04: The deploy builds the bot from a pinned sibling checkout

The web platform's repository pins the bot tag in `deploy/bot-release`, and the cutover
builds the bot image from a checkout of this repository at that tag, beside the web
platform's own checkout, exactly as it builds the web platform's image. No image registry
and no registry credentials are involved.

## 2026-09-04: The web platform work and the bot ship together

The internal service API, the link flow, the outbox and the stack changes are not released
on their own. They merge to `main` as they are completed, and the first web platform tag
that pins a bot tag is the launch of both, in one cutover.

## 2026-09-04: Student commands are top level, board and setup commands are under one group

A student types `/events`, `/midterms` or `/rooms`. A server manager or board member types
`/via setup` or `/via postpone`. The split keeps the student facing commands short and
keeps everything with side effects under one recognisable name.

## 2026-09-04: The bot is TypeScript with no build step

TypeScript throughout, run through Node's type stripping, which the web platform already
relies on for its Drizzle schema and migration files. Tests run the same files.

## 2026-09-04: Real Discord testing uses a development application and one test server

Development runs from a developer's machine against a local stack, with a separate
development Discord application and one shared test server. There is no staging copy of
the stack on the server.

## 2026-09-05: Reading back the courses somebody added is a subcommand rather than a bare name

The design writes the courses commands as `/courses add`, `/courses remove` and
`/courses`. Discord does not answer the name of a command that carries subcommands, so the
bare name cannot be invoked, and the third way in is `/courses list`. The three are still
one feature over one set of rows, as following, unfollowing and reading back what is
followed are.

## 2026-09-05: The exams of the week go out on the server's digest day

A server that wants both the weekly digest and the exams of the week gets them together on
one evening, and its manager has one answer to give rather than two. A separate day and
hour for the exams would be a second setting that almost nobody would change.

## 2026-09-05: The bot holds the building codes it completes, and nothing else about a building

The web platform's building code table is the authority on what a code stands for, and the
bot asks it rather than keeping a second copy of the names that would drift. What the bot
keeps is the list of codes themselves, so that the building option has something to offer
before anything has been typed; everything after that comes from the rooms VIA knows.

## 2026-09-05: A poll is closed by the clock rather than by a gateway event

Discord sends no event of its own when a poll ends. The one signal near it is the message
being edited as the counts are finalized, and receiving that would mean asking the gateway
for every message in every server the bot is in, which is a great deal of other people's
conversation to receive in order to learn one thing about one message. So the bot writes
down the hour each poll runs to, in Scheduler_Polls, and reads the result then. That needs
no further intent, and it survives a restart in the middle of a poll, which a gateway
event would not.

## 2026-09-05: The administrative buttons are on the card a person opened, not on the announcement

Section 6.7 asks for the administrative actions as buttons on the event card and on the
announcement, shown only when the viewer is linked. Discord has no way to show one person
a button and another person nothing on a message a whole channel reads. So an announcement
carries one button that opens the card privately for whoever pressed it, and that card
carries the six actions. The refusals are unchanged: whoever presses one is answered by
the web platform's decision about them.

## 2026-09-05: Re-posting an announcement reads the acting person's memberships

Every other administrative action proves editorship by being refused, because each of them
writes to VIA. Re-posting writes nothing, and the internal service API has no endpoint
that answers whether a person may act, so this one action compares the memberships the web
platform sends for that account and refuses with the same code and the same sentence the
others do. It is the only comparison of its kind in the bot. The web platform should grow
an endpoint that answers it, and this should call that instead when it does.

## 2026-09-05: A membership entry the bot cannot resolve is skipped rather than guessed at

A `membership.changed` entry names a person by NetID, and the bot stores no NetID: it holds
Discord identifiers and asks the web platform who somebody is. Links resolve from a Discord
account to a NetID and not the other way, so a NetID the bot has not seen recently cannot
be turned into a Discord account at all. Those people are skipped, with a line in the log,
and the daily reconciliation puts them right once they have used the bot and the in memory
directory has learned who they are.

