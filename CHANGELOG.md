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
- Deliveries: one row per intended post, written before the post and keyed by the outbox
  entry, the target and the purpose, so that a crash between the two is retried and a
  crash after the post is not.
- The outbox consumer: one loop polling the outbox from the cursor in Outbox_Cursor,
  handling each entry in order through the handler for its kind, advancing the cursor only
  once every delivery is recorded, and dropping the cached reads for the organization the
  entry touched. An entry of a kind nothing handles is moved past, and an entry that keeps
  failing is left behind loudly rather than stopping the queue behind it forever.
- Announcements: the three proactive features in the registry, and the handlers for
  event.created, series.created, event.updated, event.cancelled, event.deleted,
  series.updated and series.deleted. A new event or a new series is announced in the
  channel each following server bound, a series being announced once with its pattern and
  its end date; a change edits that announcement in place and, for a move or a
  cancellation, replies to it with a short notice; and a deletion leaves an announcement
  saying that the event was removed.
- Native scheduled events: each occurrence inside a server's mirroring window, a fortnight
  by default, is mirrored into the server's Events tab, mapped in Event_Mirrors, kept in
  step by the outbox handlers, and rolled forward by a daily job. Interest a member leaves
  with Discord's own control is recorded on VIA, by NetID when the person is linked and by
  their Discord identifier otherwise, which the web platform records as a salted hash.
- The Interested button on the event card now records interest on VIA and answers with the
  count.
- A proactive feature whose channel or permission has gone is switched off in that server,
  and the manager who set the bot up is told once, with the reason and what to do.
- The remove command now deletes the scheduled events the bot created in the server before
  it deletes the rows that say where they are.
- The health endpoint reports how far through the outbox the consumer has read and when it
  last looked, so the cutover can see that it is alive.
- The job scheduler: one clock in campus time, with the hour each job last ran for recorded
  in the new Job_Runs table, so a bot that was down over a digest hour sends that digest
  when it returns rather than skipping the week or sending it twice. A job whose work is
  due at a moment rather than in an hour, such as a reminder, runs on every pass instead.
- Following: the follow, unfollow and following commands over Subscriptions, with
  following every organization in ECE as a flag rather than a row per organization, and
  the Follow button on the organization card doing the same.
- The feed settings command, which opens a panel over User_Preferences: the day and hour
  the weekly digest arrives, how far ahead reminders arrive, and the two switches for the
  direct messages and for the feedback the sixth increment will ask for.
- The personal digest and the personal reminders: a weekly direct message listing the
  coming week for the organizations somebody follows, grouped by day, and a direct message
  before each event they asked to be reminded of, which the Remind me button on the event
  card now records. Both go through Deliveries, both end with the way to stop that kind of
  message, and somebody who has closed their direct messages has them switched off rather
  than being written to every week.
- The personal calendar: the calendar command creates or rotates a private calendar
  address through the web platform, and the set of organizations it carries is sent again
  whenever somebody's follows change.
- The weekly digest a server posts, on the day and at the hour it chooses, with the option
  of pinning each one and unpinning the one before it; the day of reminders in the channel
  bound to them, at the lead time the server chooses; and the living this week message,
  posted once, pinned, and edited in place both hourly and whenever the outbox says an
  event of a followed organization has changed. The remove command now unpins it.
- The setup panels gained a fifth step for when the timed posts happen, with the defaults
  the design names: Sunday at six in the evening, an hour of notice, and no pinning.
- The personal calendar endpoints on the web platform client, in all three of the
  interface, the HTTP implementation and the fake, with hand written fixtures.
- The health endpoint reports when the scheduler last made a pass, for the same reason it
  reports the outbox consumer's cursor.
