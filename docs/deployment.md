# Deploying the VIA Discord Bot

The bot is never deployed on its own. It is a third container in the web platform's Docker
Compose stack, on the same virtual private server, and the web platform's
`scripts/cutover.sh` deploys both services in one maintenance window. This page is the
bot's half of that procedure. The cutover itself, the settings it reads, the backups it
takes and the rollback it performs are written out in the web platform's
`docs/deployment.md`, and that document is the one to follow on the day.

What this repository owns is its own version, its own changelog, its own `v*` tags and its
own gate. What the web platform owns is which of those tags production runs, which it
records in one file, `deploy/bot-release`.

## Cutting a bot release

A release here is a version bump, a push, a green gate on the tag, and then a change to
the pin in the web platform's repository. Nothing in this repository deploys anything.

1. Merge the work to `main` with the gate green on its pull request.
2. On a clean tree on `main`, run the bump:

   ```bash
   scripts/bump-version.sh <patch|minor|major>
   ```

   It writes the version into `package.json`, opens `CHANGELOG.md` in your editor so that
   you can describe the release under the new dated heading, then commits and creates an
   annotated tag. It refuses a dirty tree, because that would tag a commit which does not
   match what was tested, and it refuses to run off `main`, because that would tag work
   which was never reviewed. It never pushes and never deploys.
3. Push the commit and the tag:

   ```bash
   git push && git push origin v<version>
   ```
4. Confirm the gate passes on the tag. The tag build runs the same jobs as the pull
   request did, against the exact commit that is about to be deployed.
5. In the web platform's repository, change the single line in `deploy/bot-release` to the
   tag you have just pushed, open a pull request, and merge it with its gate green.
6. Deploy from the web platform, with `scripts/cutover.sh v<version>` on the server, as its
   deployment document describes. If the web platform is releasing anything of its own in
   the same window, its bump carries the changed pin; if it is not, the tag that carries
   the changed pin is what gets deployed.

A release of the bot alone is therefore one line changed in the other repository followed
by a cutover. A release of the web platform alone leaves that line where it is and
redeploys the same bot tag. There is no way to run a bot tag that is not written down.

## What the cutover does with the bot

The order below is the web platform's, and it is repeated here only so that the bot's part
of it can be read in one place. The whole of it is one command.

1. The cutover refuses to start if either working tree is dirty, this one or the web
   platform's, then checks the web platform out at its release tag, reads
   `deploy/bot-release`, and checks this repository out at the tag that file names, in the
   sibling checkout at `../viaillinois-bot`.
2. Both images are built before anything stops, so a build failure costs no downtime.
3. Both databases are backed up and each backup is proved to restore. The bot's database,
   `via_bot`, is backed up beside the web platform's.
4. Both application containers stop. The database container stays up throughout.
5. The web platform's migrations are applied, and then the bot's, by
   `src/db/migrate.ts` against `via_bot`. The bot's run second because a bot migration is
   written against a web platform that has already been migrated.
6. The web platform starts and is gated on its own `GET /health`.
7. The bot starts and is gated on `GET /health` on its port, 3002 by default. This order is
   not a preference: the bot's health answer stays `unavailable` until the web platform
   answers it, so a bot started first is a bot started into a failing health check.

If the migrations, either health check or either start fails, the cutover restores both
backups, checks both repositories out at their previous tags, rebuilds and restarts both
previous images, and exits non-zero.

## The health endpoint

`GET /health` on the bot's port answers 200 with `status: ok` only when the migration
version is known, the gateway is connected, the database answers and the web platform's
internal service API answers. Anything else is 503 with `status: unavailable`, which is
what the cutover gates on.

The document also carries three things that are reported rather than gated on, because a
bot that has quietly stopped doing one of them looks exactly like a bot with nothing to do:

- `outboxCursor` and `lastPollAt`, which say how far through the outbox the consumer has
  read and when it last looked.
- `schedulerLastTickAt`, which says when the timed jobs last made a pass.
- `lastPruneAt` and `reconciliationPending`, which say when the ninety day retention was
  last applied and whether the bot knows it has fallen behind the outbox and has not yet
  rebuilt what it mirrors. A `reconciliationPending` of true is worth looking into: it
  means a server's Events tab may be out of date until the next housekeeping run succeeds.

After a deploy, confirm the version is the tag you released:

```bash
curl -fsS http://localhost:3002/health
```

A `version` that does not match the tag means the running container is not the build you
think it is.

## The settings the bot's container needs

They live in the `.env` file beside the web platform's `docker-compose.yml`, because one
stack has one environment file, and the web platform's deployment document lists them in
full. The bot reads them in `src/config.ts`, which validates every one of them at startup
and refuses to start with a sentence naming the one that is missing.

The bot's container is deliberately not given the web platform's database account or its
signing secret. Everything it knows about events, memberships and people it reads and
writes through the internal service API, which decides every authorization question
itself, and either of those in this container would be a way around that.

## The release gate

`.github/workflows/gate.yml` runs on every pull request to `main` and on every `v*` tag,
and its jobs are required by branch protection. They are the same three classes the web
platform's gate has.

The `quality` job covers the code: version consistency, the language check and its own
tests, the bump script tests, the compose file tests, type checking, the unit project, and
coverage, which is reported and never enforced.

The `database` job covers the schema: the migrations apply cleanly from an empty database,
the Drizzle drift check fails when a schema declaration was changed without a migration
being generated, and the database project runs against the same throwaway container
developers use locally.

The `security` job covers the supply chain: `npm audit` at high severity, and secret
scanning over the full history.

A red gate is a blocked release, not a judgment call. The fix is to make the check pass,
not to weaken the check.

## The bot's database

`via_bot` lives inside the web platform's MySQL container, with an account scoped to it
that cannot see the web platform's database. It is created once, by the web platform's
`server/db/init/01-bot-database.sh` on an empty data directory, or by hand on a host that
already has a database. The statements to run by hand are in the web platform's deployment
document, and that is the one place the procedure asks for SQL by hand: the database and
the account have to exist before there is anything to connect as.

No table is created that way. Every table in `via_bot` comes from a migration under
`src/db/migrations`, applied by the cutover.
