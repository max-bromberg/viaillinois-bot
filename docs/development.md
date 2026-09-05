# Developing the VIA Discord Bot

This page is how to run the bot from your own machine, against a local copy of the web
platform and a Discord application of your own. Deployment is a separate procedure and
lives in `docs/deployment.md`.

Nothing here touches production. The bot you run locally is a different Discord
application with a different token, in a test server you own, against a web platform on
your own machine, with a database of its own.

## What you need

- Node.js 20 or later. The bot is TypeScript run through Node's type stripping, so there
  is no build step and no compiler to install.
- Docker with the Compose plugin, for the throwaway database the database tests use.
- A checkout of the web platform, `viaillinois`, running locally. The bot reads and writes
  every piece of VIA data through the web platform's internal service API, so a bot with
  nothing to talk to answers almost nothing.
- A Discord application of your own, and one server you own to test in.

## The development Discord application

Create a second application in the Discord developer portal, at
https://discord.com/developers/applications, and keep it for development. Never point a
local run at the production application: the commands are registered globally, so a local
run would replace the command list every real server sees.

**The bot user.** Add a bot to the application and copy its token into `DISCORD_TOKEN`.
The token is shown once, and resetting it is how you get another.

**The identifiers.** The application's identifier goes into `DISCORD_APPLICATION_ID` and
its public key into `DISCORD_PUBLIC_KEY`. Both are on the application's general page.

**The intents to leave off.** Under the bot's settings, leave Message Content Intent and
Presence Intent switched off. The bot never asks the gateway for either, and a development
application with them switched on would let a change that started asking for one pass
unnoticed. Server Members Intent is on, because the membership roles are assigned from it.
The four intents the bot does ask for are named in `src/discord/intents.ts`, and a test
reads the bitfield they produce.

**The installation contexts.** Under Installation, tick both the guild install and the
user install contexts. The bot registers each command with the contexts its feature
declares, and a command published to a context the application does not offer is refused
by Discord at startup. Give the guild install the `bot` and `applications.commands`
scopes, and the user install `applications.commands`.

**The OAuth2 redirect.** The account link flow runs on the web platform rather than in the
bot, so the redirect address belongs to the web platform. Add
`http://localhost:3001/auth/discord/callback` to the application's OAuth2 redirects, which
is where a local web platform serves it, and set `DISCORD_CLIENT_ID`,
`DISCORD_CLIENT_SECRET` and `DISCORD_LINK_KEY` in the web platform's own environment. The
scopes that flow asks for are `identify` and, when the person leaves the linked roles box
ticked, `role_connections.write`.

**The test server.** Invite the application to one server you own, with the Manage Events,
Manage Roles, Manage Messages, View Channel and Send Messages permissions, which is what
the features in `src/features/registry.ts` ask for between them. Run `/via setup` there
once and answer what it asks.

## Configuration

Copy `.env.example` to `.env` and fill it in. The variables with no default are listed in
`REQUIRED_VARIABLES` in `src/config.ts`, and a missing one is a sentence naming it at
startup rather than a connection error later.

For a local run against a local web platform:

| Variable | What to set it to locally |
| --- | --- |
| `DISCORD_TOKEN` | The development bot's token. |
| `DISCORD_APPLICATION_ID` | The development application's identifier. |
| `DISCORD_PUBLIC_KEY` | The development application's public key. |
| `VIA_INTERNAL_URL` | `http://localhost:3001`, where the web platform serves the internal service API. |
| `VIA_PUBLIC_URL` | `http://localhost:5173`, so that the link buttons the bot posts open your own copy of the website rather than viaillinois.com. |
| `BOT_SERVICE_TOKEN` | Any long random secret, set to the same value in the web platform's environment. Generate one with `openssl rand -hex 32`. |
| `DB_HOST`, `DB_PORT` | The MySQL the web platform runs, which is `localhost` and `3306` when you run its compose file. |
| `BOT_DB_USER`, `BOT_DB_PASSWORD`, `BOT_DB_NAME` | The bot's own database account and database, `via_bot` by default. |
| `HEALTH_PORT` | `3002`, which is where `GET /health` listens. |

The bot's database is created by the web platform's `server/db/init/01-bot-database.sh`,
which its database container runs the first time it starts on an empty data directory. If
your database container is older than that script, create the database and the account by
hand once, with the statements the deployment document gives for production.

## Running it

```bash
npm install
node --experimental-strip-types src/db/migrate.ts
npm run dev
```

`npm run dev` reads `.env`, watches the source and restarts on a change. Startup order is
the same as in production: the health listener binds first, the commands are registered
globally, the linked role facts are registered, and the gateway connects last. Two things
are worth watching for in the log, the count of commands registered and the line saying
the outbox consumer is running.

Confirm the bot is healthy the same way the cutover does:

```bash
curl -fsS http://localhost:3002/health
```

An answer of `unavailable` names which of the three it is waiting on: the gateway, the
database, or the web platform.

Global commands can take a few minutes to appear in Discord after the command list
changes. Nothing is wrong when a command you have just added is not offered yet.

## Running the tests

The suite is Vitest, with two projects, as the web platform's is.

```bash
npx vitest run --project unit    # everything that needs neither Discord nor a database
npx vitest run --project db      # the suites whose correctness is the database's
npx vitest run                   # both
npm run typecheck                # the types, which the gate runs as its own step
npm run check:language           # the em dash and en dash check the gate enforces
npx drizzle-kit check            # the drift check, after any change to src/db/schema.ts
```

The unit project needs nothing running. Interactions are plain objects, the web platform
client is the fake in `src/via/fake.ts` serving the recorded shapes under
`tests/fixtures/internal`, and time is injected, so a digest or a reminder is tested at a
fixed instant on the campus clock.

The database project brings up a throwaway MySQL container from `docker-compose.test.yml`
and resets the schema between suites. It publishes port 3308 by default, so it can run
beside the web platform's own throwaway database on 3307, and `BOT_TEST_DB_PORT` moves it.
The container is brought up by the suites themselves and torn down once at the end of the
run, so the first database suite of a run takes a minute longer than the rest.

Nothing in either project reaches real Discord or a real web platform, and nothing should
be written that does.

## Adding a migration

Every schema change is a migration, and the files under `src/db/migrations` are the schema
of record for `via_bot`.

1. Change the declarations in `src/db/schema.ts`.
2. Generate the migration: `npx drizzle-kit generate --name <short_name>`, run from the
   repository root, because `drizzle.config.ts` names its paths relative to the working
   directory.
3. Read what it generated, and write a comment block at the top of the file saying what
   the change is for and why. The migrations are read by people as well as applied by the
   runner.
4. Write a test under `tests/db` that fails without the migration, and run the database
   project.
5. Run `npx drizzle-kit check`. A schema declaration changed without a migration fails the
   drift check in the gate.

## Testing against real Discord

There is no staging copy of the stack. Real Discord testing is a developer's machine, the
development application and one shared test server, which is decision 11 in the design.
What that means in practice is that anything which only happens in a real server, the
scheduled events in the Events tab, the polls, the role assignments and the direct
messages, is exercised by hand there before a release rather than by the suite.
