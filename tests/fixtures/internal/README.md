# Internal service API fixtures

These files are the shapes the web platform's internal service API answers with, under
`/internal/v1`. The web platform client's tests and the fake client both read them, so a
change to a shape is a change to a committed file rather than a surprise at run time.

Two kinds of file live here. The files in the second table were recorded by the web
platform's contract test, `server/tests/routes/internalContract.test.js`, and are copied
here unchanged; a change to one of them is a change the web platform made deliberately.
The files in the first table are hand written from
`docs/superpowers/specs/2026-09-04-via-internal-service-api.md`, sections 4 and 6, because
the link endpoints, the binding confirmation, the interest endpoint and the personal
calendar endpoints do not exist on the web platform yet, and one of them,
The interest endpoint is the web
platform's seventh increment, and `interest.json` is written from the row for
`PUT /events/{id}/interest` in section 6 of that specification. The two personal calendar
files are written from the same section, whose personal calendar endpoints are being built
on the web platform now. When the contract test records any of them, the recorded files
replace the hand written ones, and any difference between the two is a real disagreement
to settle before the two repositories ship together.

Times carry the campus offset, as the public API sends them.

## Hand written, from the spec

| File | The answer it records |
|---|---|
| `error.not_linked.json` | The error shape with the `not_linked` code, answered with 403 |
| `error.forbidden.json` | The error shape with the `forbidden` code, answered with 403 |
| `error.busy.json` | The busy answer, sent with 503 and a Retry-After header |
| `guilds.bindingConfirmed.json` | `POST /guilds/bindings/confirm`, the answer when the acting person may bind a server to that organization |
| `health.json` | `GET /health` on the web platform, which the bot's own health endpoint reports |

## Recorded by the web platform's contract test

| File | The answer it records |
|---|---|
| `rsos.json` | `GET /rsos` |
| `rso.json` | `GET /rsos/{id}` |
| `rsoMembers.json` | `GET /rsos/{id}/members` |
| `events.json` | `GET /events` |
| `event.json` | `GET /events/{id}` |
| `eventCalendar.json` | `GET /events/{id}/calendar`, the calendar file as text |
| `midterms.json` | `GET /midterms` |
| `courses.json` | `GET /courses` |
| `locations.json` | `GET /locations` |
| `locationsFree.json` | `GET /locations/free` |
| `building.json` | `GET /buildings/{code}` |
| `refusal.json` | The error shape itself, which every refusal uses |
| `links.session.json` | `POST /links/sessions`, a new link session with its address and expiry |
| `links.link.json` | `GET /links/{discordUserId}`, a resolved link; roles carry the platform's casing and the client lowers them |
| `links.unlinked.json` | `GET /links/{discordUserId}` when there is no link |
| `guilds.bindingConfirmed.json` | `POST /guilds/bindings/confirm`, recorded by the web platform as bindingsConfirm.json |
| `outbox.json` | `GET /outbox`, a page of entries with the next cursor |
| `outboxEntries.json` | One entry per outbox kind, as the web platform writes them |
| `calendars.personal.json` | `POST /calendars/personal`, the address of the person's calendar and when its token was last rotated |
| `calendars.personalRsos.json` | `PUT /calendars/personal/rsos`, the answer to updating the organizations a calendar carries without rotating its token |
| `interest.json` | recorded by the web platform as acting.interest.json: `PUT /events/{id}/interest`, the answer to setting or clearing interest, with the count after the change |
| `acting.postpone.json` | `POST /events/{id}/postpone`, the event as it stands after it was moved |
| `acting.cancel.json` | `POST /events/{id}/cancel`, with the moment the event was cancelled at |
| `acting.patch.json` | `PATCH /events/{id}`, the event as it stands after its description, its visibility or its location note was changed |
| `acting.series.json` | `POST /events/series`, the repeat that was created, with the events it holds and the dates it skipped |
| `scheduler.recommend.json` | `POST /scheduler/recommend`, recorded by the web platform as acting.recommend.json in the shape the scheduler service answers with |
