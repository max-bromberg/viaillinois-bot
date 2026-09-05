# Internal service API fixtures

These files are the shapes the web platform's internal service API answers with, under
`/internal/v1`. The web platform client's tests and the fake client both read them, so a
change to a shape is a change to a committed file rather than a surprise at run time.

Two kinds of file live here. The files in the second table were recorded by the web
platform's contract test, `server/tests/routes/internalContract.test.js`, and are copied
here unchanged; a change to one of them is a change the web platform made deliberately.
The files in the first table are hand written from
`docs/superpowers/specs/2026-09-04-via-internal-service-api.md`, sections 4 and 6,
because the link endpoints do not exist on the web platform yet. When the contract test
records them, the recorded files replace the hand written ones, and any difference between
the two is a real disagreement to settle before the two repositories ship together.

Times carry the campus offset, as the public API sends them.

## Hand written, from the spec

| File | The answer it records |
|---|---|
| `links.session.json` | `POST /links/sessions`, a new link session with its address and expiry |
| `links.link.json` | `GET /links/{discordUserId}`, a resolved link |
| `links.unlinked.json` | `GET /links/{discordUserId}` and `DELETE /links/{discordUserId}` when there is no link |
| `error.not_linked.json` | The error shape with the `not_linked` code, answered with 403 |
| `error.busy.json` | The busy answer, sent with 503 and a Retry-After header |
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
