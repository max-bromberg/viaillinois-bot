# CLAUDE.md

Guidance for Claude Code (claude.ai/code) when working in this repository.

## Project Overview

This repository holds the Discord companion to **VIA (Virtually Integrated Agenda)**, the
event management platform for the Electrical and Computer Engineering department's
Registered Student Organizations at the University of Illinois Urbana-Champaign. The web
platform runs at viaillinois.com and lives in the `viaillinois` repository. This bot exists
so that VIA is present inside the Discord servers where those organizations actually run,
in the ECE community servers, and in each student's direct messages, at the same time as it
is present on the website.

The bot is a volunteer, public-good service with real users, and it is maintained to the
same production standards as the web platform.

Planning documents live under `docs/superpowers/specs` and `docs/superpowers/plans`. Read
`docs/superpowers/specs/2026-09-04-via-discord-bot.md` before changing anything, and read
`docs/superpowers/specs/2026-09-04-via-internal-service-api.md` before touching anything
that talks to the web platform.

## Tech Stack

- **Runtime**: Node.js 20+ (ESM), the same runtime the web platform uses, with TypeScript
  throughout, run through Node's type stripping and no build step
- **Discord**: `discord.js`, connected to the gateway as a single shard
- **Database**: its own database, `via_bot`, inside the MySQL 8.0 container the web platform
  already runs, accessed through Drizzle over one connection pool
- **Web platform access**: the internal service API served by the web platform on the
  private container network, never the public API and never the web platform's tables
- **Tests**: Vitest, with a `unit` project and a `db` project, as in the web platform

## Non-Negotiable Rules

1. **Test driven development, always.** Write the failing test first, run it and observe
   it fail for the right reason, write the minimal implementation, run it and observe it
   pass. A bug fix starts with a test that reproduces the bug.
2. **Nothing ships without the release gate.** The gate is `.github/workflows/gate.yml`, it
   runs on pull requests to `main` and on `v*` tags, and its jobs are required by branch
   protection. A red gate is a blocked release, not a judgment call.
3. **Never auto-commit.** Do not run `git commit` unless the user explicitly asks.
4. **Every schema change is a migration.** The migrations under `src/db/migrations` are the
   schema of record for the `via_bot` database. A change to a Drizzle schema declaration
   without a generated migration fails the drift check in the gate.
5. **The bot never reads or writes the web platform's tables.** Every piece of VIA data,
   whether an event, a membership, a midterm, or an account link, is read and written
   through the internal service API. Authorization for anything a person does through the
   bot is decided by the web platform, never reimplemented here.
6. **Production deploys go through the web platform's cutover script only.** This
   repository builds no production artifact of its own. A release is cut here with
   `scripts/bump-version.sh`, and the web platform's deployment pins the bot tag it runs.
   The procedure is written out in `docs/deployment.md`.
7. **No privileged gateway intents, and no stored message content.** The bot never requests
   the message content intent or the presence intent, and it never persists the text of a
   message or a direct message. Message text reaches the bot only inside an interaction a
   person deliberately started, and it is used for that interaction and then discarded.

## User Facing Language Constraints

These apply to every string a user can read: command descriptions, embeds, buttons, modal
labels, direct messages, error messages, and documentation.

- **No em dashes and no en dashes.** Use commas, colons, parentheses, or a full stop.
- **No choppy fragment rhythm.** Do not write sentence fragments for emphasis, and do not
  use the "it's not this, it's that" construction. Write complete sentences.
- **No invented abbreviations or names.** Do not coin a shortened name for a project
  structure, table, service, or feature. Use the name the codebase already uses, in full.

## Repository Layout

- `src/` the bot: gateway client, commands, proactive jobs, the web platform client,
  database access
- `docs/superpowers/specs/` design specs, one per work package
- `docs/superpowers/plans/` implementation plans, one per spec
- `docs/` deployment, development, roadmap and the decision log
- `scripts/` release and check scripts

## Commands

The runtime is not set up yet. When it is, these are the commands this file will list, and
they mirror the web platform's so that a contributor moving between the two repositories
finds the same names:

- `npm install` install dependencies
- `npm run dev` run the bot against a development Discord application
- `npx vitest run` the test suite
- `npm run check:language` em dash and en dash check, which the gate enforces
- `scripts/bump-version.sh <patch|minor|major>` cut a release, see `docs/deployment.md`
