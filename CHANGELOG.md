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
- The server records: the store over Guild_Installations, Guild_Features, Guild_Channels
  and Guild_Followed_Rsos, and the gateway wiring that records a server the bot joins and
  deletes everything for a server it is removed from. A server that has just installed
  the bot is recorded as one that has not been set up, which the kind and binding columns
  became nullable to say.
- The setup, config and remove commands: the four panels the design names, which are the
  kind of server, what it follows, the channels the bot may post in, and the feature list
  with its blocked features explained. Binding a server to an organization asks the web
  platform to confirm that the person may, and says who can bind it when the answer is no.
- The reading commands: the events listing with its window, organization and internal
  options and its page control, the event card with its reminder, interest, calendar and
  website buttons, and the organization card. Times are the campus wall clock with
  Discord's relative timestamp beside them, as on the website.
- The reading endpoints and the binding confirmation on the web platform client, in all
  three of the interface, the HTTP implementation and the fake, and the hot read cache
  that holds the organization list and a listing for a minute.
