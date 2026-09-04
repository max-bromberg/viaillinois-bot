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

This repository is in the planning stage. Nothing runs yet. The design is written out under
`docs/superpowers/specs`, the decisions behind it are in `docs/decisions.md`, and the
implementation plans are under `docs/superpowers/plans`.

| Document | What it covers |
|---|---|
| `docs/superpowers/specs/2026-09-04-via-discord-bot.md` | The bot itself: audiences, identity, per-server configuration, the first release's features, architecture, privacy, deployment and testing |
| `docs/superpowers/specs/2026-09-04-via-internal-service-api.md` | The work on the web platform side: the internal service API, account linking, the outbox, and the new tables |
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
