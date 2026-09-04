# Changelog

All notable changes to the VIA Discord bot are recorded here. The format follows the web
platform's changelog: one section per release, newest first, with an Unreleased section
at the top that the bump script turns into the next release.

## Unreleased

- Repository scaffold: manifest, type checking, the unit and db test projects, the
  throwaway test database, the container image, and the release scripts carried over
  from the web platform.
- The release gate with quality, database and security jobs.
- Startup configuration that refuses to start with a sentence naming the missing
  variable.
- The bot database: Drizzle schema for every table in the design, the baseline migration,
  and the migrate script the cutover runs.
- The health endpoint the cutover gates on.
- The feature registry with the two identity features.
