# Deploying the VIA Discord Bot

Nothing here runs yet. This page records the deployment design so that the runtime is built
to fit it, and it will be rewritten as the procedure once the first release exists.

The bot is never deployed on its own. It is a third container in the web platform's Docker
Compose stack, and the web platform's cutover script deploys both services in one
maintenance window. The design of that shared cutover is in section 9 of
`docs/superpowers/specs/2026-09-04-via-internal-service-api.md`, and the procedure itself
will live in the web platform's `docs/deployment.md`.

What this repository is responsible for:

- **Cutting a release.** `scripts/bump-version.sh <patch|minor|major>` writes the version
  into `package.json`, opens `CHANGELOG.md` for the release notes, commits, and creates an
  annotated `v*` tag. It refuses a dirty tree and refuses to run off `main`. It never pushes
  and never deploys.
- **The gate on the tag.** `.github/workflows/gate.yml` runs on the tag and must be green
  before the tag is pinned anywhere.
- **The migrate script.** `src/db/migrate.ts` applies the migrations under
  `src/db/migrations` to the `via_bot` database, and the cutover runs it between stopping
  and starting the bot.
- **The health endpoint.** `GET /health` on the bot's port, which the cutover gates on.

Deploying a new bot version is then a change to `deploy/bot-release` in the web platform's
repository, merged through its gate, and a cutover on the server.
