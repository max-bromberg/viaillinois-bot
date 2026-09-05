# Changelog

All notable changes to the VIA Discord bot are recorded here. The format follows the web
platform's changelog: one section per release, newest first, with an Unreleased section
at the top that the bump script turns into the next release.

## Unreleased

- The first review of the whole of the first release, and the work it asked for. Deliveries
  are retried rather than treated as made, so a post Discord refused once is made when the
  entry or the hour comes round again, and the posts still owed at a restart are drained by
  reading the outbox from the oldest of them. The two link outbox kinds are handled at last,
  so a link made on the website is confirmed by direct message and one revoked there deletes
  everything the bot held, including the Discord roles it had given. Every server switch is
  now enforced when a command runs, the reading commands answer the channel in a server that
  invited the bot, and the people holding a reminder for an event that is cancelled are told,
  which the cancellation command had been promising all along. The gateway intents are down
  to the two the bot reads, both unprivileged. A great deal of copy was rewritten: the setup
  panels say what a feature does rather than the identifier the bot keys it by, lead times
  read as a day rather than as 1440 minutes, and removal asks first and then says what has
  actually happened. `docs/decisions.md` records the decisions this took.

- Feedback after an event, from section 6.4: the morning after an event, the linked people
  who marked interest in it or asked to be reminded of it receive one direct message with
  five buttons, a comment through a form, and a button that stops the bot asking again. The
  score is recorded on VIA as the acting person the moment it is pressed, and the comment
  is recorded beside it. Both switches are honoured, the person's own and the one a server
  bound to an organization has for its events, and somebody whose VIA account has gone
  since the event is passed over in silence.
- A new table, Interest_Marks, holding who marked interest in which event by Discord
  account. The web platform holds interest by NetID and by a salted hash, neither of which
  can be turned back into somebody to write to, and the bot stores no NetID, so it keeps
  the mark it forwarded. The rows for an event go once its feedback has been asked for, and
  the rows of a person go when they unlink, along with everything else the bot held.
- The web platform client grows the feedback endpoint, with the recorded answer of the web
  platform's contract test beside the other acting endpoints.
- An answer in a server that has not installed the bot is shown only to the person who
  asked, whatever the handler would otherwise have chosen, because a person using the bot
  through their own installation has not invited it into that server's channels. The
  registry and the command list are now asserted over every feature rather than over an
  example, so a feature added later without the contexts it needs fails a test.
- Daily housekeeping: Deliveries and Rate_Windows rows older than ninety days are removed,
  as section 10 requires. When the outbox cursor has not moved in longer than the web
  platform keeps the outbox, the cursor can no longer be caught up with, so the bot says so
  loudly and rebuilds what each server mirrors from the reading endpoints instead. The
  health endpoint reports when the rows were last pruned and whether a rebuild is still
  owed.
- `docs/development.md`, which is how to run the bot from a developer's machine against a
  local web platform and a development Discord application, and how to run each test
  project. `docs/deployment.md` is rewritten as the procedure it describes rather than the
  design of one, and the README's status says what runs now and what nobody has yet
  exercised against real Discord.
- The setup features panel is paged by category, because the registry outgrew both what
  Discord will carry in one message and what one menu will offer. Each page lists the
  features of one category with their state and, when a feature cannot work, the reason,
  and what each feature does is written on the menu entry that switches it, which is what
  the new summary field in the registry is for. A test asserts that no panel exceeds
  either of Discord's limits with the whole registry.
- The allowed administrative actions of section 6.7: postpone, cancel, describe,
  visibility, re-post and the location note, each a command under the via group and a
  button on the event card, with forms for the three that take text, filled in with what
  the event holds now. Every one of them calls the web platform with the acting Discord
  account and turns its refusals into one sentence each, which is one helper shared by
  every action: a link button for an account VIA does not know, a sentence naming the
  organization for an account it does not list as an editor, the clash the web platform
  named for a conflict, and the wait for a busy answer.
- A postponement's reason travels from the outbox entry into the notice that replies to
  the announcement, so a channel reads why a meeting moved rather than only that it did.
- The scheduler: `/via schedule` asks the same scheduler the dashboard asks and shows the
  evenings with their scores, their clear weeks and their reasons; a button opens one of
  Discord's own polls over the top few in a channel the board picks; the poll's result is
  posted with a button that creates the repeat. Accepting checks the recommendation again
  first and shows anything that has changed since the poll was opened before it creates
  anything.
- Membership roles: `/via roles` maps VIA's member, editor and board roles to Discord
  roles, the `membership.changed` outbox entries keep them in step, and a daily
  reconciliation reads the organization's members as the board member the server was
  bound by. The bot never removes a role it did not grant, which the new Role_Grants table
  records, and a server whose Manage Roles permission was taken away has the feature
  switched off and its manager told once.
- Linked roles: the three facts a server can require for a role are registered with
  Discord at startup, and the link command says where the verification is started from.
  Pushing a person's own values stays the web platform's.
- The web platform client grows the acting endpoints: postpone, cancel, patch, the
  scheduler and the series creation, along with the members of an organization, in all
  three of the interface, the HTTP implementation and the fake.
- The adapter grows forms, one of Discord's own polls, role menus and the two role calls,
  and the dispatcher routes a submitted form by the identifier the form was built with.

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
- The campus endpoints on the web platform client, in all three of the interface, the HTTP
  implementation and the fake: the midterm listing, the course search with its sections,
  the room search, the free rooms of a building and the building codes. The course search
  and the midterm listing join the hot read cache, because a course autocomplete fires on
  every keystroke and the answer to when the next exam is does not depend on who is
  asking.
- The midterms command: a course by autocomplete, answered with the exams VIA has for it,
  their rooms and their times, and a sentence saying how many of those times are still
  pending confirmation.
- The courses commands: courses add, courses remove and courses list over User_Courses,
  with the catalogue completing a course being added and the person's own courses
  completing one being removed.
- The exam reminders: a direct message before each confirmed exam of a course somebody
  added, at the lead time they chose, through Deliveries and ending with the way to stop
  them. Nobody asks for one of these individually, because adding a course is the asking.
- The midterm outbox handlers for midterm.confirmed, midterm.updated and
  midterm.cancelled, which write one direct message to each person who added the course,
  keyed by the outbox entry so that an entry handled twice writes once. These are the
  first outbox entries that reach a person rather than a server.
- Exams this week: a proactive feature a server switches on, posting the confirmed exams
  of the coming week in the channel bound to exam notices, grouped by day, on the same day
  and hour as that server's weekly digest.
- The campus lookups: the rooms command for the free rooms of a building over a window
  given as a date and two hours, or the next hour when none is given; the course command
  for the sections of a course, their days, their hours and their rooms; and the building
  command for what a code stands for, which says in a sentence that no address is recorded
  rather than guessing at one. A window the web platform refuses, such as one longer than
  seven days or a date it cannot read, is shown as the sentence it refused with.
