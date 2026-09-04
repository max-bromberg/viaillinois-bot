# Roadmap

The first release is horizon one, which is specified in full in
`docs/superpowers/specs/2026-09-04-via-discord-bot.md`. This document holds the two
horizons after it. Nothing here is committed to a date, and everything here is expected to
change once the first release has real users. What it is for is to make sure the first
release's architecture leaves room for it, and to record the long term objective in one
place: VIA grows from an event platform into the platform that runs an RSO.

## Horizon two: Discord native tooling for boards

The second horizon is where information starts flowing from Discord into VIA, and where the
bot starts doing things the website cannot.

**Create an event from a message.** A board member opens the context menu on a message they
or a fellow board member wrote, chooses the bot's action, and the bot reads the date, time,
place and title out of the message into a pre-filled modal. Confirming creates an event
draft on VIA, which the web platform holds in a `draft` state until a board member confirms
it on the dashboard or from the bot's confirmation message. This is an allowed action
under the decision log. It meets boards where they already write, and every draft it
creates is a data point about what the announcement channel actually says. Message text
reaches the bot only inside the interaction, and the bot does not keep it.

**Check in and attendance.** The web platform already issues a QR code per event. Scanning
it, or pressing a check in button that the bot posts at start time, records attendance
against a linked NetID. Attendance flows into RSO statistics and becomes the signal that
feedback requests and the scheduler use instead of interest.

**Event threads and forum channels.** A thread under each announcement for questions, which
the bot closes and archives after the event, and, for servers that use a forum channel for
events, one post per event with tags by event type instead of a message in a text channel.

**Announcement composer.** A board writes an announcement once on VIA and it is published
to the RSO's Discord servers, the feed and the kiosk together, with the bot editing the
Discord copy when the source changes.

**Cross RSO conflict alerts.** When a new event lands within an hour of another RSO's event
that draws the same people, both boards get a direct message saying so, with the scheduler's
suggestion of a clear alternative.

**Notification preferences on the website.** Everything a person can set from the bot's
direct messages, also on their account page, so the two surfaces agree about what the
person asked for.

## Horizon three: the platform that runs an RSO

The third horizon is the long term objective. Each item here is large, and each is
something an RSO currently does with a spreadsheet, a form, and a channel full of pings.

**Membership and roles in both directions.** VIA membership drives Discord roles, as in the
first release, and Discord roles can drive VIA membership where a board chooses, so that
adding an officer in either place adds them in both. Officer transition at the end of a
year becomes one operation that reassigns roles, dashboard access and channel permissions
together.

**Insights.** Attendance over time, which event types draw and which do not, growth across
terms, and which announcement channels move people. Aggregate only, opt in for members,
and designed so that no message content is ever read. The question a board is trying to
answer is what to run next term, and the insight page answers it with the RSO's own data.

**Managed event types.** Templates that the bot and the web platform understand together:
a workshop series with sign up and capacity, a competition with team formation and
submissions, office hours with a queue, a company information session with resume
collection, a project fair with tables and a schedule. Each template is a set of fields on
the event, a set of components the bot posts, and a set of pages on the website.

**A department wide view.** Contested weeks, rooms that every RSO wants, and the events that
compete for the same students, visible to every board, so that the scheduler's advice is
also a shared understanding.

**Discord Activity.** The feed as an embedded application inside a channel, for the
servers that want VIA visible without a command.

## What the first release leaves room for

- The outbox has a `subject_type` and a `payload`, so new kinds are additive.
- Interest and feedback are tables with a `source`, so attendance and web controls join
  them without a migration of the existing rows.
- The feature registry is the only place a feature is declared, so a new feature is a new
  entry with its own toggle, permissions and channel purpose.
- The internal service API is versioned by path, so a breaking change is a new path beside
  the old one for as long as an older bot is pinned.
