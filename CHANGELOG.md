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
- The feature registry with the two identity features, each declaring the application
  command it is reached by.
- The web platform client: the ViaClient interface, the implementation over HTTP with the
  service token, the acting header, a request identifier and the busy retry, and the in
  memory implementation that serves the recorded shapes of the internal service API.
- The gateway: the intents list with a test that reads the bitfield, the client, the
  adapter that turns interactions into plain objects and replies into library calls, and
  global command registration built from the feature registry.
- The link and unlink commands, with the dispatcher that keys on the command name.
- The rate windows over Rate_Windows, with the unlinked, linked and per server limits read
  from the environment, and the sweep that removes buckets nothing will read again.
