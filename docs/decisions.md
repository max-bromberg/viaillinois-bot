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
