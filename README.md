# FOSS E2E — Playwright Test Suite

End-to-end tests for the FOSS platform. **36 tests across 8 spec files**,
covering: SSO chain, multi-app session sharing, cookie expiry bounds,
session lifecycle (logout / invalidation / replay / deletion), per-app link
coverage, the Plane god-mode admin escape hatch, and the full
login → 4 apps → logout user journey.

The suite is **environment-agnostic**. One env var (`FOSS_BASE_URL`) drives
the entire host topology. Pointing at sandbox, staging, prod, or a local
devstack is a one-line `.env` change — no code edits.

## Apps Under Test

All hosts derive from `FOSS_BASE_URL` using the FOSS naming convention:

| Component | Host pattern | Sandbox value |
|-----------|-------------|---------------|
| Main portal           | `foss.<domain>`          | `foss.arbisoft.com` |
| Outline (Docs)        | `foss-docs.<domain>`     | `foss-docs.arbisoft.com` |
| Plane (PM)            | `foss-pm.<domain>`       | `foss-pm.arbisoft.com` |
| Penpot (Design)       | `foss-design.<domain>`   | `foss-design.arbisoft.com` |
| SurfSense (Research)  | `foss-research.<domain>` | `foss-research.arbisoft.com` |
| ForwardAuth proxy     | `foss-auth.<domain>`     | `foss-auth.arbisoft.com` |

`<domain>` is whatever follows `foss.` in `FOSS_BASE_URL`. Cookie scope
domain is `<domain>`.

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
- `BROWSERS=all` — chromium + firefox + webkit (default: chromium only)
- `FOSS_COGNITO_DOMAIN` / `FOSS_MPASS_DOMAIN` — IDP overrides (don't derive
  from base URL)

See `.env.example` for everything.

## Running

```bash
npm test                  # all tests, chromium
npm run test:auth         # tests/auth/        — SSO chain, sharing, lifecycle
npm run test:apps         # tests/apps/        — per-app + god-mode
npm run test:flows        # tests/flows/       — login → 4 apps → logout
npm run test:all-browsers # full suite × chromium + firefox + webkit
npm run report            # open last HTML report
```

Filter by name:

```bash
npx dotenv -- npx playwright test -g "Log out of all apps"
```

## What's covered

The full invariant contract lives in **`skills.md`** (17 universal rules).
Highlights:

- **SSO chain** — `_oauth2_proxy` cookie shape (Secure / HttpOnly / SameSite=Lax),
  shared across all 4 subdomains, present after login, scoped to the
  platform domain.
- **Cookie expiry** — `_oauth2_proxy` and per-app session cookies must expire
  within a 30-day SSO TTL bound. Browser-session cookies (`expires=-1`) and
  CSRF / locale cookies are excluded.
- **Session lifecycle** — UI logout clears the cookie; logout from one app
  invalidates all; pre-logout cookies cannot be replayed; deleting the SSO
  cookie locks every app behind the IDP.
- **Per-app link coverage** — every internal `<a href>` on the start page
  loads <400, stays on the app's host, doesn't bounce to the auth wall, no
  404 in title, and is clickable.
- **god-mode** (Plane admin) — `/god-mode/` and `/auth/get-csrf-token`
  bypass ForwardAuth; the page renders Plane's own admin form (not the SSO
  IDP); admin login works; wrong password is rejected; admin login does
  **not** issue the platform `_oauth2_proxy` cookie (separate session
  universe).
- **End-to-end flow** — fresh login → all 4 apps load authed; per-app
  `/oauth2/sign_out`; main portal "Log out of all apps" → all 4 apps
  bounce back to the IDP.

## Test layout

```
tests/
├── auth/
│   ├── sso-login.spec.ts             # cookie shape, persistence
│   ├── session-sharing.spec.ts       # cross-subdomain scope + expiry bounds
│   └── session-lifecycle.spec.ts     # logout, replay, cookie deletion
├── apps/
│   ├── outline.spec.ts               # branding + link coverage
│   ├── penpot.spec.ts                # branding + link coverage (canvas-SPA exempt)
│   ├── pm.spec.ts                    # link coverage
│   ├── pm-godmode.spec.ts            # admin escape-hatch invariants
│   └── surfsense.spec.ts             # link coverage
├── flows/
│   └── login-logout-flow.spec.ts     # full e2e journey
└── lib/
    └── link-coverage.ts              # registerLinkCoverage() factory
```

`constants.ts` — single source of truth, derives every host from
`FOSS_BASE_URL`.
`skills.md` — invariant contract (what every app must satisfy).

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
