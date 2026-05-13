# FOSS E2E — Playwright Test Suite

End-to-end tests for the FOSS platform. **124 tests across 18 spec files**,
covering: SSO chain, multi-app session sharing, cookie expiry bounds,
session lifecycle (logout / invalidation / replay / deletion), per-app link
coverage, the Plane god-mode admin escape hatch, Outline's admin
`/settings/*` SSO-gating + role split, Penpot's team-role RPC
mutation round-trip, the full
login → 5 apps → logout user journey, and the SSO-rule invariants from
[`sso-rules` RULES.md](https://github.com/awais786/sso-rules) (header
spoofing, bypass discipline, security-header coverage on every router
type, no local-login UI in SSO mode, cross-app identity consistency,
HTTP plaintext lockdown).

The suite is **environment-agnostic**. One env var (`FOSS_BASE_URL`) drives
the entire host topology. Pointing at sandbox, staging, prod, or a local
devstack is a one-line `.env` change — no code edits.

## Apps Under Test

All hosts derive from `FOSS_BASE_URL` using the FOSS naming convention:

| Component | Host pattern | Sandbox value |
|-----------|-------------|---------------|
| Main portal           | `foss.<domain>`              | `foss.arbisoft.com` |
| Outline (Docs)        | `docs.foss.<domain>`         | `docs.foss.arbisoft.com` |
| Plane (PM)            | `pm.foss.<domain>`           | `pm.foss.arbisoft.com` |
| Penpot (Design)       | `design.foss.<domain>`       | `design.foss.arbisoft.com` |
| SurfSense (Research)  | `research.foss.<domain>`     | `research.foss.arbisoft.com` |
| Twenty (CRM)          | `twenty.foss.<domain>`       | `twenty.foss.arbisoft.com` |
| ForwardAuth proxy     | `auth.foss.<domain>`         | `auth.foss.arbisoft.com` |

App hosts are nested under the main-portal hostname, and the SSO cookie
scope is `foss.<domain>` (the MAIN_URL hostname). Pointing the suite at
a different deployment is a one-line change to `FOSS_BASE_URL`.

## Quick start

```bash
npm install
npm run install:browsers
cp .env.example .env       # then fill in FOSS_USER / FOSS_PASS
npm test
```

Required env (in `.env`):

```
FOSS_BASE_URL=https://foss.arbisoft.com
FOSS_USER=...
FOSS_PASS=...
```

Optional:
- `PLANE_ADMIN_USER` / `PLANE_ADMIN_PASS` — enables the god-mode admin sign-in
  + wrong-password tests (otherwise those self-skip)
- `OUTLINE_ADMIN_USER` / `OUTLINE_ADMIN_PASS` — SSO user with `role=admin`
  in Outline; enables the admin-reaches-every-/settings-page block
  (otherwise that block self-skips)
- `PENPOT_ADMIN_USER` / `PENPOT_ADMIN_PASS` — SSO user who is owner/admin
  on at least one Penpot team; enables the role-mutation round-trip
  test (promote a teammate via RPC, verify, restore) — self-skips otherwise
- `BROWSERS=all` — chromium + firefox + webkit (default: chromium only)
- `FOSS_COGNITO_DOMAIN` / `FOSS_MPASS_DOMAIN` — IDP overrides (don't derive
  from base URL)

See `.env.example` for everything.

## Running

```bash
npm test                  # all tests, chromium
npm run test:auth         # tests/auth/        — SSO, sharing, lifecycle, identity
npm run test:apps         # tests/apps/        — per-app + god-mode
npm run test:flows        # tests/flows/       — login → 5 apps → logout
npm run test:security     # tests/security/    — headers, plaintext, spoof, bypass
npm run test:all-browsers # full suite × chromium + firefox + webkit
npm run report            # open last HTML report
```

Filter by name:

```bash
npx dotenv -- npx playwright test -g "Log out of all apps"
```

## What's covered

The full invariant contract lives in **`skills.md`** (universal rules) and
[`sso-rules` RULES.md](https://github.com/awais786/sso-rules) (per-app +
edge-layer rules). Highlights:

### Session + SSO
- **SSO chain** — `_oauth2_proxy` cookie shape (Secure / HttpOnly / SameSite=Lax),
  shared across all 5 subdomains, present after login, scoped to the
  platform domain.
- **Cookie expiry** — `_oauth2_proxy` and per-app session cookies must expire
  within a 30-day SSO TTL bound. Browser-session cookies (`expires=-1`) and
  CSRF / locale cookies are excluded.
- **Session lifecycle** — UI logout clears the cookie; logout from one app
  invalidates all; pre-logout cookies cannot be replayed; deleting the SSO
  cookie locks every app behind the IDP.
- **Twenty refresh after idle** — valid SSO cookie + cleared Twenty
  local session + reload stays on Twenty (regression guard for the
  refresh-after-expiry path).
- **Cross-app identity consistency** — every backend's `/me`-shape
  endpoint (Plane `/api/users/me/`, Outline `/api/auth.info`, Penpot
  RPC `get-profile`, SurfSense `/users/me`) resolves the same logged-in
  user to the same synthesized email. Catches `DEFAULT_EMAIL_DOMAIN`
  drift across containers.

### Per-app
- **Per-app link coverage** — every internal `<a href>` on the start page
  loads <400, stays on the app's host, doesn't bounce to the auth wall, no
  404 in title, and is clickable. Adapts to SPAs whose nav streams in /
  mutates by route (Twenty).
- **god-mode** (Plane admin) — `/god-mode/` and `/auth/get-csrf-token`
  bypass ForwardAuth; the page renders Plane's own admin form (not the SSO
  IDP); admin login works; wrong password is rejected; admin login does
  **not** issue the platform `_oauth2_proxy` cookie (separate session
  universe).
- **Outline admin** (`/settings/*`) — *inverse* invariant of god-mode:
  every admin URL sits fully behind SSO (cold context bounces through
  ForwardAuth), and Outline enforces the admin/non-admin role split
  server-side. Under a non-admin SSO user the 5 common-settings pages
  load, while the 8 admin-only pages (details, security, authentication,
  features, integrations, applications, import, export) are gated
  (Not Found, chunk-load failure, or never resolve past the SPA shell).
- **Penpot admin** (team-role RPC) — Penpot has no `/admin` URL; admin
  is a per-team state on the `team_profile_rel` row, gated server-side
  by the `update-team-member-role` RPC handler. The test logs in as
  `PENPOT_ADMIN_USER`, discovers a team they own/admin, picks a non-self
  non-owner teammate, promotes them via RPC, verifies the change in a
  re-fetched member list, and restores the original role in a `finally`
  block. Locks in the round-trip contract end-to-end.
- **End-to-end flow** — fresh login → all 5 apps load authed; per-app
  `/oauth2/sign_out`; main portal "Log out of all apps" → all 5 apps
  bounce back to the IDP.

### Edge layer (RULES.md §1)
- **HTTP plaintext lockdown** — every host on port 80 redirects to https
  or refuses the connection. No 2xx ever served over plain HTTP.
- **Security headers** on every browser-facing router — HSTS (≥180d +
  includeSubDomains), `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY|SAMEORIGIN`, `Referrer-Policy`,
  `Permissions-Policy` denying camera / mic / geolocation. Covers
  `*-secure`, `*-bypass`, `oauth2-proxy-secure`, and `oauth2-apps`
  routers (headers are per-response, not host-cached — each router
  type is verified separately).
- **Header spoofing rejection** — sending `X-Auth-Request-*` headers
  without a cookie must bounce to auth or 4xx; the
  `strip-auth-headers` middleware must scrub inbound identity headers
  before the backend can trust them. Verified on both `*-secure` and
  `*-bypass` routers (defense-in-depth on bypass routers added in
  `foss-server-bundle#30`).
- **Bypass discipline** — static assets (`/favicon.ico`, `/robots.txt`)
  reachable without auth; the catch-all `/` still gated. Catches both
  over-protection of public assets and under-protection of the secure
  catch-all (Electric `/v1/shape` exfiltration pattern).
- **AUTH_TYPE=SSO gate** — local login / register / forgot-password
  UI must be hidden in SSO mode. Every app's known local-auth routes
  (Plane `/sign-in`, Outline `/auth/email`, Penpot `/#/auth/*`,
  SurfSense `/login`, Twenty `/sign-in`, etc.) must have no reachable
  `<input type="password">`.

## Test layout

```
tests/
├── auth/
│   ├── sso-login.spec.ts                  # cookie shape, persistence
│   ├── session-sharing.spec.ts            # cross-subdomain scope + expiry bounds
│   ├── session-lifecycle.spec.ts          # logout, replay, cookie deletion
│   ├── twenty-refresh-after-idle.spec.ts  # Twenty local-session re-issue from SSO cookie
│   └── identity-consistency.spec.ts       # every backend resolves the same email
├── apps/
│   ├── outline.spec.ts                    # branding + link coverage
│   ├── penpot.spec.ts                     # branding + hash-route nav coverage
│   ├── outline-admin.spec.ts              # /settings/* SSO-gating + non-admin role split
│   ├── penpot-admin.spec.ts               # team-role RPC mutation round-trip
│   ├── pm.spec.ts                         # link coverage
│   ├── pm-godmode.spec.ts                 # admin escape-hatch invariants
│   ├── surfsense.spec.ts                  # link coverage
│   └── twenty.spec.ts                     # link coverage (SPA, route-mutating nav)
├── flows/
│   └── login-logout-flow.spec.ts          # full e2e journey
├── security/
│   ├── headers.spec.ts                    # canonical headers on *-secure, *-bypass,
│   │                                      # oauth2-proxy-secure, oauth2-apps
│   ├── http-no-plaintext.spec.ts          # no 2xx over plain HTTP on any host
│   ├── header-spoofing.spec.ts            # X-Auth-Request-* spoof must be rejected
│   ├── strip-on-bypass.spec.ts            # strip-auth-headers chained on bypass routers
│   ├── bypass-surface.spec.ts             # static assets bypass, catch-all gated
│   └── sso-mode-no-local-login.spec.ts    # no password input on local-auth routes
└── lib/
    └── link-coverage.ts                   # registerLinkCoverage() factory
```

`constants.ts` — single source of truth, derives every host from
`FOSS_BASE_URL`.
`skills.md` — local invariant contract (what every app must satisfy).
[`sso-rules` RULES.md](https://github.com/awais786/sso-rules) — canonical
edge-layer + per-app rules; the `security/` and `identity-consistency`
tests verify these on the live deployment.

## Auth architecture

Login is performed once per worker via the configured IDP (Cognito or
mPass). The resulting cookies + storage are shared across tests in the
same worker — no repeated logins.

Session lifecycle and god-mode tests are exempt: they spawn fresh
contexts and manage their own login/logout so global state changes
don't contaminate the shared session.

## Pointing at production

```bash
# .env
FOSS_BASE_URL=https://foss.example.com
FOSS_USER=prod-user@example.com
FOSS_PASS=prod-password
# only if prod uses a different mPass IDP host:
# FOSS_MPASS_DOMAIN=moneta-auth.pressingly.net
```

App URLs, ForwardAuth host, and cookie domain all auto-derive from
`FOSS_BASE_URL`.

## CI (GitHub Actions)

Two workflows. Each runs the full chromium suite and uploads the HTML
report as an artifact every run; failure traces and videos as a second
artifact only on failure.

| Workflow | File | Triggers | Secrets prefix |
|----------|------|----------|----------------|
| `E2E — Sandbox`    | `.github/workflows/e2e-sandbox.yml` | every 12h (`00:00` + `12:00` UTC), push to `main`, PR, manual | `SANDBOX_*` |
| `E2E — Production` | `.github/workflows/e2e-prod.yml`    | manual only — gated on `production` Environment | `PROD_*` |

> **Note**: scheduled (cron) runs only fire from the default branch, so
> the 12-hour cadence starts after this branch lands on `main`.

### Sandbox setup (one-time)

**Repo → Settings → Secrets and variables → Actions → Secrets**:

| Name | Required | Purpose |
|------|----------|---------|
| `SANDBOX_FOSS_USER` | ✅ | SSO username |
| `SANDBOX_FOSS_PASS` | ✅ | SSO password |
| `SANDBOX_PLANE_ADMIN_USER` | optional | enables god-mode admin tests |
| `SANDBOX_PLANE_ADMIN_PASS` | optional | same |
| `SANDBOX_OUTLINE_ADMIN_USER` | optional | enables Outline admin-reaches-/settings tests |
| `SANDBOX_OUTLINE_ADMIN_PASS` | optional | same |
| `SANDBOX_PENPOT_ADMIN_USER` | optional | enables Penpot role-mutation round-trip test |
| `SANDBOX_PENPOT_ADMIN_PASS` | optional | same |
| `SLACK_WEBHOOK_URL` | optional | enables Slack failure notifications (with the list of failed tests) |

**Variables tab** (optional):

| Name | Purpose |
|------|---------|
| `SANDBOX_FOSS_BASE_URL` | override sandbox URL (default `https://foss.arbisoft.com`) |

### Production setup (one-time)

**Repo → Settings → Environments → New environment → `production`**:

1. Enable **Required reviewers** so prod runs pause for human approval.
2. Add the secrets below as **Environment secrets** (not repo secrets —
   Environment secrets only release when an approver clicks):

| Name | Required | Purpose |
|------|----------|---------|
| `PROD_FOSS_USER` | ✅ | SSO username |
| `PROD_FOSS_PASS` | ✅ | SSO password |
| `PROD_PLANE_ADMIN_USER` | optional | god-mode admin user |
| `PROD_PLANE_ADMIN_PASS` | optional | god-mode admin pass |
| `PROD_OUTLINE_ADMIN_USER` | optional | Outline admin SSO user |
| `PROD_OUTLINE_ADMIN_PASS` | optional | Outline admin SSO pass |
| `PROD_PENPOT_ADMIN_USER` | optional | Penpot admin SSO user |
| `PROD_PENPOT_ADMIN_PASS` | optional | Penpot admin SSO pass |

**Variables (repo or environment)**:

| Name | Required | Purpose |
|------|----------|---------|
| `PROD_FOSS_BASE_URL` | ✅ | prod main portal URL |
| `PROD_FOSS_MPASS_DOMAIN` | optional | prod mPass host if non-sandbox |
| `PROD_FOSS_COGNITO_DOMAIN` | optional | prod Cognito host if non-default |

### Running on GitHub

- **Sandbox**: runs automatically (cron / push / PR), or *Actions →
  E2E — Sandbox → Run workflow* to trigger ad-hoc.
- **Production**: *Actions → E2E — Production → Run workflow*. Optional
  `base_url` input overrides `PROD_FOSS_BASE_URL` for that single run.
  Pauses for reviewer approval if the `production` environment requires
  it.
- Daily prod smoke: uncomment the `schedule:` block in
  `.github/workflows/e2e-prod.yml`.

### Slack notifications

The sandbox workflow posts a **failure-only** plain-text report to
Slack — listing each failed test by file + title — when any run (12h
cron, push, PR, manual) fails. Successful runs stay quiet.

Sample message:

```
E2E Sandbox failed — 2 test(s)
Branch: main @ a1b2c3d
https://github.com/your-org/your-repo/actions/runs/123456789

tests/auth/session-sharing.spec.ts: auth/session cookies on every app...
tests/apps/outline.spec.ts: clicking each visible link navigates within host
```

To enable:

1. Slack workspace → **Apps → Incoming Webhooks → New webhook** for the
   target channel; copy the URL.
2. Repo Settings → Secrets and variables → Actions → Secrets → add
   `SLACK_WEBHOOK_URL` with the webhook URL.

The notification step no-ops with a log message if the secret is unset,
so existing setups don't break.

### Local CI mode

```bash
CI=true npm test
```

CI mode: 2 workers, 1 retry, HTML report saved but not opened.
Screenshots, videos, and traces written to `test-results/` on failure.

## Known platform findings (test should fail until fixed)

| Test | Finding | Fix lives in |
|------|---------|--------------|
| `auth/session cookies on every app have valid future expiry within session bounds` | Outline `accessToken` expires in 92 days — Outline fork uses upstream `addMonths(3)` instead of wiring `SESSION_TTL_SECONDS`. | Outline fork patch (open) |
