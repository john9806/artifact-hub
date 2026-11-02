# Security model and pilot limitations

This project is an early pilot, not an independently audited sandbox. Do not
introduce sensitive company data before your organization's security review.

## Trust boundaries

- **Trusted:** application server and code, GitHub configuration and administrators,
  the dedicated repository bot token, server configuration, authorized writers
  and reviewers for their assigned responsibilities, and your Cube authorization.
- **Untrusted:** artifact HTML/JavaScript, its data, and arbitrary external PRs.
- All allowed users share one workspace and can view its development content.
  This is not a multi-tenant isolation product.

## Artifact execution

The application never executes uploaded JavaScript server-side. Artifact bytes
are kept in Git and served from a separately configured host. The server injects
only the Cube message bridge before the artifact content.

The viewer uses an iframe with `sandbox="allow-scripts"` and no
`allow-same-origin`. The artifact response independently sets CSP `sandbox
allow-scripts` and denies direct network connections, forms, nested frames,
workers, objects, base URL changes, remote scripts, and external subresources.
Inline JavaScript/CSS, data/blob images, and data fonts are supported.

Opaque frame origins prevent one artifact from accessing another's DOM or normal
origin-bound storage. The authenticated app keeps its cookies away from the
artifact origin. The parent only accepts messages whose source is the particular
iframe and whose origin is opaque. It never interprets artifact messages as code
or HTML. Cube results are returned only to the same frame and source revision.

There are important residual risks:

- A sandboxed frame can navigate **itself** to an external URL. CSP does not
  provide a reliable, universally deployed ban on that behavior. Artifact
  embedded/user-entered/queried data could be encoded into that navigation.
- Browser-dependent APIs, including WebRTC, require additional enterprise browser
  policy if a hard outbound-network ban is required.
- Browser frames do not guarantee CPU/memory isolation. Hostile infinite loops or
  large allocations can impair a browser session.
- The iframe is not a malware scanner, and an approval is not proof of correct
  calculations, safe content, or appropriate data handling.
- Preview capabilities expire in ten minutes. Already loaded content remains
  loaded; a capability is not tied to an active cookie on the artifact host.

For stronger requirements, use managed hardened browser/VM sandboxes, enforce
enterprise browser and network controls, and reassess the threat model.

## Authentication and authorization

GitHub OAuth verifies identity. User access and writer/reviewer roles are explicit
server-side allowlists. Signed session cookies expire in eight hours, use
HttpOnly/SameSite=Lax, and use Secure plus the `__Host-` prefix in production.
OAuth access tokens are discarded after fetching identity.

Mutations require same-origin JSON requests with a custom header. APIs enforce
roles independently of UI controls. Expected revisions prevent a stale editor
silently overwriting another edit.

`LOCAL_DEVELOPMENT=true` allows an explicitly local fake writer identity, **not a
reviewer**. It is rejected when NODE_ENV=production, requires prescribed loopback
hostnames, and binds only loopback interfaces. Never expose it via a tunnel/proxy.

Revoking an allowlisted username blocks future API calls and new artifact renders.
Rotating SESSION_SECRET revokes all signed sessions and preview capabilities.

## Releases

Every promotion references a pinned DEV commit and copies exactly that artifact's
HTML and metadata. The server validates source bytes and metadata, repository,
branch format, allowed file paths, and PR number.

Approval must be from a configured reviewer different from the requester and must
refer to the exact latest PR head. Outstanding authorized change requests block
publication. The publish endpoint rechecks these rules and passes the expected
head SHA to GitHub's merge API. PROD reads verify the release matches an approved,
merged promotion, including its data grants.

GitHub branch protections are also required to close review/merge races and
restrict direct changes. Bot credentials and repository write/admin access are
powerful: protect them. The protocol is not designed to resist a compromised
repository administrator, server, or bot.

Artifact validation statuses report structural integrity only. They are never
security or business-correctness certifications.

## Cube

The application is a restricted query proxy, not a general proxy. The destination
is fixed in server configuration. Artifacts never get the Cube secret or JWT.
Every query member must be allowed globally and for that artifact. Queries have
schema, concurrency, row, rate, response-size, and timeout limits.

The connector signs a short-lived JWT with server-derived identity and artifact
claims. Your Cube securityContext/query rewrite must enforce tenant and row
permissions; a list of allowed measures is not row-level authorization.

Giving an artifact Cube access makes its result visible to that artifact's
JavaScript and to the viewing user. Browser isolation cannot make permitted data
safe to give to malicious code. Review code and data grants accordingly.

## Storage, logs, and incident handling

- Treat all Git content as persistent. Never upload secrets, even to a draft.
- A public repository makes all committed artifacts publicly readable.
- Keep .env, PATs, session secrets, Cube secrets, and data volumes out of Git.
- Redact renderer URLs/query strings in reverse proxy access logs.
- Use a private repository, HTTPS ingress with preserved Host headers, distinct
  domains, patched Node/Git/browser/container versions, and least-privilege tokens.
- After a secret leak, revoke it first. Git history rewriting is a separate
  administrator incident-response procedure, not implemented by this app.

Report issues privately to the repository owner through GitHub private
vulnerability reporting if enabled. Do not publish sensitive artifact examples.
