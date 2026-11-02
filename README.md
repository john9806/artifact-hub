# Artifact Hub

A Git-backed home for the little tools your team creates with AI.

Upload an interactive HTML artifact, use it immediately in development, and publish
an independently reviewed version for the rest of the team. No analyst needs a
personal fork or a local Git checkout.

**Status: early pilot, not independently security-audited.** Start with synthetic
data. Read the [security model](SECURITY.md) before deploying for a company.

## What works

- Upload or paste self-contained HTML with inline JavaScript and CSS, up to 1 MB.
- Search the catalog, copy stable authenticated links, open isolated interactive
  previews, and edit existing artifacts.
- Every DEV save is a Git commit; no review is needed to save a draft.
- Request publication through an artifact-scoped GitHub pull request.
- The PR's `artifact-hub/validated` check links to its authenticated live preview.
- Review the HTML, metadata, Cube grants, and exact immutable source revision.
- A different configured reviewer approves the final PR head on GitHub.
- A reviewer publishes from the app; the server checks approval again and merges
  that exact head. Only this artifact changes in PROD.
- Production reads verify the release still matches an approved, merged PR.
- Inspect Git history and restore a revision into the editor as a **new DEV draft**.
  Rollbacks require the same publication review as other changes.
- Optional controlled Cube queries: no Cube credentials enter artifact code.
- GitHub OAuth sign-in, explicit viewer/writer/reviewer allowlists, and a
  loopback-only local development identity.

## What is an artifact?

For this first version, **one self-contained `.html` file**, not arbitrary server
code. It can contain sliders, calculations, charts built with inline code, forms
that operate locally, and embedded data that is safe to retain in the repository.

Ask Claude:

> Create a standalone HTML price simulator with inline JavaScript and CSS.
> Include all code in one HTML file. Do not use external libraries, fonts, CDNs,
> network requests, localStorage, or a backend. Use only synthetic example data.
> Explain the model's assumptions in the interface.

React JSX exports are **not directly supported**. Export/bundle them as a
self-contained HTML file first. Python, arbitrary npm installs, external scripts,
API calls, and general server-side execution are intentionally out of scope.

## Edit an artifact with Claude

1. Open a tool in the catalog and select **Download source**. This downloads the
   exact displayed version, not a newer draft that somebody may have saved.
2. Attach the HTML file to Claude and ask for changes. Keep the output as one
   self-contained HTML file, following the restrictions above.
3. Open that same tool in **Development** and choose **Upload revised version**.
   The dialog displays the target artifact and its stable ID.
4. Choose Claude's revised file, inspect the source and metadata, and **Save to DEV**.
   The file name can change: identity comes from the selected tool, not the name.
   The artifact keeps its owner, history, and shared link.
5. Test the updated preview and choose **Request publication**. Production remains
   unchanged until a different authorized reviewer approves and publishes.

Use **Edit source** for direct changes in the browser. **Version history** can
restore an older version to the editor. If another user has saved changes since
you opened the editor, saving is rejected; reconcile against the latest DEV
version rather than overwriting it.

**Upload new artifact** at the top of the library creates a separate tool. It
never guesses which existing artifact to replace based on the file name.

Source downloads require sign-in and are served as attachments, not rendered on
the application origin. The file contains the original artifact, without the
injected Cube bridge or credentials. Opening downloaded HTML on your own computer
is outside the Hub sandbox; give the file to Claude rather than trusting local
execution. Cube-enabled artifacts require the Hub's preview bridge to query data.

## Repository model: template or fork?

For your own installation, use this repository as a template, or fork it.
**For company artifacts, create a private repository from the template.** A public
fork has public Git history, even when the application requires login.

All users of a shared installation work in the same configured repository:

```text
main                                  application code + approved artifact releases
artifact-dev                          draft artifacts, saved without approval
promotion/<artifact-id>/<request-id>   one pinned artifact proposed for publication
```

Artifacts live at:

```text
artifacts/<uuid>/artifact.html
artifacts/<uuid>/artifact.json
```

A promotion starts from the latest `main` and copies only the selected artifact
from an immutable DEV commit. It never merges the entire `artifact-dev` branch.
Editing DEV after opening a PR does not change that PR. To publish those new edits,
open another promotion. Artifact source is stored, not executed, by the server.

## Local setup

Requires Node.js 20.19+ (Node.js 22 recommended), npm, Git, and an initialized GitHub
repository with a `main` branch.

```sh
git clone https://github.com/john9806/artifact-hub.git
cd artifact-hub
npm ci
cp .env.example .env
openssl rand -hex 32
```

Set `SESSION_SECRET` to the generated value and configure `.env`:

1. `GITHUB_REPOSITORY`: your own repository, e.g. `your-org/private-artifact-hub`.
2. `GITHUB_TOKEN`: a **dedicated bot user's** fine-grained PAT, limited to this
   repository, with Contents read/write, Pull requests read/write, and Commit
   statuses read/write. Metadata read is implicit.
3. For real accounts, create a GitHub OAuth App. Its callback is
   `http://localhost:3000/auth/callback`. Configure `GITHUB_CLIENT_ID` and
   `GITHUB_CLIENT_SECRET`. No repository OAuth scope is requested for user login;
   the separate bot token handles repository writes.
4. Configure comma-separated GitHub usernames in `GITHUB_ALLOWED_USERS`,
   `GITHUB_WRITERS`, and `GITHUB_REVIEWERS`. Role users must also be allowed users.
5. Add at least one reviewer distinct from the artifact's publication requester.
   Reviewers must have access to review the repository's PRs.

**Do not use a reviewer's account as the bot:** GitHub does not allow PR authors
to approve their own PRs. Local login is useful for uploads and previews but is
never a reviewer identity.

```sh
npm run dev
```

Open **http://localhost:3000**, select **Enter local development**, and try the
synthetic price simulator. Previews are served from **http://127.0.0.1:3001**:
different hostnames, not merely different ports.

The development server uses CSP nonces for Vite's inline preamble. Hot reload uses
the app's own listener, with an explicit same-host WebSocket CSP grant only in
development; it does not open a separate Vite network port.

For a local test of real review/publishing, sign out, sign in through GitHub with
the configured real accounts, review the PR on GitHub, then return to the PR
preview and select **Refresh approval** and **Publish approved version**.

The app must be running and reachable by reviewers for its preview links to work.
A localhost deployment is not reachable by colleagues on other computers.

## Production setup

This is a **single-instance** service. Do not run multiple replicas against the
same data directory. A startup lock prevents accidental concurrent use. After an
unclean shutdown, confirm the prior process has stopped before removing only
`DATA_DIR/instance.lock`.

1. Set `LOCAL_DEVELOPMENT=false`, a strong `SESSION_SECRET`, real OAuth credentials,
   and explicit role allowlists.
2. Set `APP_ORIGIN=https://hub.yourcompany.com`.
3. Set `ARTIFACT_ORIGIN=https://preview.your-isolated-domain.net`. Prefer a different
   registrable domain; never share parent-domain cookies with the artifact host.
4. Update the OAuth callback to `https://hub.yourcompany.com/auth/callback`.
5. Route HTTPS traffic for the app to port 3000 and artifacts to port 3001.
   Preserve the original `Host` header. The app rejects unexpected hosts.
   **Never** route application/auth paths through the artifact hostname.
6. Use persistent private storage for `DATA_DIR`, back up the GitHub repository
   and configuration, and keep server logs access-controlled. Reverse proxies
   must redact `/render` query strings, which contain short-lived preview grants.
7. Configure GitHub rules for `main`: require PRs and independent approval, dismiss
   stale approvals, require approval of the latest push, and require the
   `artifact-hub/validated` status for artifact releases. If one ruleset covers code
   PRs too, its required-check policy must accommodate application PRs, which do
   not produce an artifact validation status. Restrict direct pushes and bypass
   access. Repository admins and the bot token remain trusted.
8. Restrict creation/update of `artifact-dev` and `promotion/**` branches to the
   trusted bot and maintainers. Only the server should author promotion metadata.
   Keep promotion branches for audit/debugging; automatic deletion is not needed.
9. Run a private pilot and your organization's security review before live data.

```sh
npm run typecheck
npm test
npm run build
NODE_ENV=production npm start
```

Or, after configuring production `.env` and the external HTTPS reverse proxy:

```sh
docker compose up --build -d
```

The Compose file binds both ports to loopback and expects your host's reverse
proxy to terminate TLS. It is not a complete public ingress configuration.

### CI and review previews

Application PRs run TypeScript, tests, and a production build. Artifact-only PRs
run a structural check that **does not execute artifact code or install
dependencies from the promotion branch**. The running app validates immutable
content and puts its preview URL in a commit status on the final PR head.

That status is a structural/integrity check, **not a certification that an
artifact's calculations or code are safe**. The reviewer must inspect behavior,
assumptions, source, embedded data, and Cube member grants.

PR previews require sign-in and are pinned to the PR head. A changed head makes
old approval ineligible. Expired preview links can be reissued with **Reload
preview**; the link expires after ten minutes but an already loaded iframe is not
automatically erased.

## Optional Cube connector

Leave Cube settings unset for an offline, general-purpose artifact catalog.
To enable Cube:

```dotenv
CUBE_API_URL=https://cube.example.com/cubejs-api/v1
CUBE_API_SECRET=your-server-side-cube-signing-secret
CUBE_ALLOWED_MEMBERS=Orders.count,Orders.revenue,Orders.region
```

On upload/edit, select a subset of those members for the artifact. Inside the
HTML artifact:

```html
<div id="result">Loading...</div>
<script>
artifactHub.query({
  measures: ["Orders.revenue"],
  dimensions: ["Orders.region"],
  limit: 50
}).then(result => {
  document.getElementById("result").textContent = JSON.stringify(result.data);
}).catch(error => {
  document.getElementById("result").textContent = error.message;
});
</script>
```

`artifactHub.query()` crosses a source-checked `postMessage` bridge to the parent
app, which performs an authenticated server request. The server validates every
referenced query member against both global and artifact-specific grants.
Supported queries are deliberately limited: measures, dimensions, time dimensions,
flat filters, ordering, and a maximum 1,000 rows. Requests are rate-limited and
results limited to 2 MB. Cube's `Continue wait` response is shown as a retryable
error, not treated as success.

**You must implement row/tenant authorization in your Cube model or query rewrite.**
The short-lived signed Cube JWT contains server-derived `githubLogin` and
`artifactId` claims available in Cube's `securityContext`. The hub cannot infer
your company's data-access rules from a GitHub username. Do not enable the
connector until those rules are in place and tested. Do not store Cube signing
secrets in artifacts, Git, frontend configuration, or browser storage.

DEV is also data-access capable when granted members; production approval is not
a data permission boundary. All allowed workspace users can see all DEV and PROD
artifacts in this first version. Per-artifact viewer ACLs and tenant management
are not implemented.

## Verification

```sh
npm run typecheck
npm test
npm run build
npm audit
```

Tests use real temporary Git repositories and a fake GitHub API adapter to cover
draft persistence, concurrency, immutable PR previews, independent current-head
approvals, per-artifact promotion, tampering, rollback, and production approval
verification. HTTP tests cover authentication, roles, CSRF, render isolation,
expired grants, and bounded Cube access. A real GitHub OAuth/reviewer and Cube
deployment must still be exercised with your organization's credentials.

## Limits worth knowing

- Browser isolation, not a VM per artifact. No guarantee of CPU/memory isolation
  from other tabs or frames.
- Embedded/user-entered data can still leak through browser behaviors such as
  frame self-navigation; see [SECURITY.md](SECURITY.md).
- Public repositories expose source and embedded data, regardless of app login.
- No automatic Claude chat import, JSX compilation, background jobs, or Python.
- GitHub is required for publication review; GitLab is not supported.
- No automated correctness validation for calculations or business models.
- Git history retains old bytes. Deleting a UI revision would not erase Git data;
  no deletion feature is offered.

## License

[MIT](LICENSE).
