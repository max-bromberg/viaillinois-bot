<div align="center">

# VIA Discord Bot

### VIA, inside the servers where ECE RSOs actually run

[**viaillinois.com**](https://viaillinois.com)

</div>

---

VIA (Virtually Integrated Agenda) is the event management platform for the Registered
Student Organizations of the Electrical and Computer Engineering department at the
University of Illinois Urbana-Champaign. The web platform lives in the
[`viaillinois`](https://github.com/max-bromberg/viaillinois) repository. This repository
holds its Discord companion.

The bot's purpose is parity. A student in an RSO's Discord server, or in one of the ECE
community servers, or in a direct message with the bot, should feel that VIA exists there
just as fully as it exists on the website: the same upcoming events, the same midterm
schedule, the same scheduler, announced where people already are, and answered on demand.
Server owners decide which of the bot's features are enabled in their server, down to the
individual feature and the channel it posts to.

## Status

The bot is built and untagged. Every feature of the first release is written, with its
tests, and none of it has been through a release: there is no `v0.1.0` yet, and the web
platform's `deploy/bot-release` does not name a tag of this repository.

What runs now, against the fake web platform client and the plain interaction objects the
tests are written on:

| Part | What it does |
| --- | --- |
| Identity | `/link` and `/unlink`, the account link flow the web platform serves, and the three linked role facts registered with Discord |
| Reading | `/events`, `/event`, `/rso`, `/midterms`, `/rooms`, `/course` and `/building`, answered from the web platform's reading endpoints |
| Setup | `/via setup` and `/via config`, one ephemeral panel per page, and `/via remove` |
| Announcements | The outbox consumer, the announcements and change notices, the native scheduled events, and the living this week message |
| The personal feed | Following organizations, the weekly digest, reminders, the personal calendar, and the courses somebody added for exam reminders |
| The board's work | The six administrative actions, the scheduler with its poll, and the membership roles |
| Feedback | The morning after job, the five buttons, the comment form and the two switches |
| Housekeeping | The ninety day retention, and the rebuild a cursor older than the outbox retention asks for |

What remains before the first release is the part no test can stand in for. Nothing here
has been exercised against real Discord: the tests use plain interaction objects and a fake
web platform client, deliberately, so the parts that only exist inside a real server have
been designed and never watched. That means the command registration with both installation
contexts, the scheduled events in a server's Events tab, Discord's own polls, the role
assignments, the direct messages and the forms. Decision 11 in the design says how that is
done, which is a development application and one shared test server from a developer's
machine, and `docs/development.md` says how to set it up.

The release itself is then the procedure in `docs/deployment.md`: a bump here, a green gate
on the tag, that tag written into `deploy/bot-release` on the web platform, and one cutover
that brings up all three containers.

### The documents

| Document | What it covers |
|---|---|
| `docs/superpowers/specs/2026-09-04-via-discord-bot.md` | The bot itself: audiences, identity, per-server configuration, the first release's features, architecture, privacy, deployment and testing |
| `docs/superpowers/specs/2026-09-04-via-internal-service-api.md` | The work on the web platform side: the internal service API, account linking, the outbox, and the new tables |
| `docs/development.md` | Running the bot locally, against a development Discord application and a local web platform |
| `docs/deployment.md` | Cutting a release here, and what the web platform's cutover does with the tag |
| `docs/roadmap.md` | The second and third horizons, where VIA grows from an event platform into the platform that runs an RSO |
| `docs/decisions.md` | The decision log |
| `docs/superpowers/plans/` | The implementation plans, one per spec, in ordered increments |

## Relationship to the web platform

- Versioning is separate. The bot has its own semantic version and its own `v*` tags.
- Deployment is shared. The bot is a third container in the web platform's Docker Compose
  stack, and the web platform's cutover script deploys both, pinning the bot tag it runs.
- Data ownership is one directional. The web platform owns every table that describes VIA.
  The bot owns only the tables that describe Discord: which servers it is in, what each
  server enabled, who is subscribed to what, and what it has already posted.
- Authorization is decided once. When a person acts through the bot, the web platform
  resolves who they are from their account link and applies the same rules the dashboard
  applies.

## License

MIT, the same as the web platform.
