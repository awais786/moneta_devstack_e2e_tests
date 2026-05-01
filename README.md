# FOSS E2E — Playwright Test Suite

End-to-end tests for the FOSS platform — SSO authentication, multi-app
session sharing, access control, session lifecycle, per-app link coverage,
and admin escape-hatch invariants across all 4 apps.

The suite is **environment-agnostic**. One env var (`FOSS_BASE_URL`) drives
the entire host topology. Pointing at sandbox, staging, prod, or a local
devstack is a one-line `.env` change — no code edits.

## Apps Under Test

All app hosts derive from `FOSS_BASE_URL` using the FOSS naming convention:

| App | Host pattern | Sandbox value |
|-----|-------------|---------------|
| Main portal           | `foss.<domain>`          | `foss.arbisoft.com` |
| Outline (Docs)        | `foss-docs.<domain>`     | `foss-docs.arbisoft.com` |
| Plane (PM)            | `foss-pm.<domain>`       | `foss-pm.arbisoft.com` |
| Penpot (Design)       | `foss-design.<domain>`   | `foss-design.arbisoft.com` |
| SurfSense (Research)  | `foss-research.<domain>` | `foss-research.arbisoft.com` |
| ForwardAuth proxy     | `foss-auth.<domain>`     | `foss-auth.arbisoft.com` |

`<domain>` is whatever follows `foss.` in `FOSS_BASE_URL`. Cookie domain
is the same `<domain>`.

## Prerequisites

- Node.js 18+
- Playwright browsers installed

```bash
npm install
npm run install:browsers
```

## Configuration

```bash
cp .env.example .env
```

Minimum required:

```
FOSS_USER=you@arbisoft.com
FOSS_PASS=your_password_here
```

Optional:
- `PLANE_ADMIN_USER` / `PLANE_ADMIN_PASS` — enables the `pm-godmode` admin sign-in test
- `BROWSERS=all` — runs against chromium + firefox + webkit (default: chromium only)
- `FOSS_BASE_URL` — switch to a different deployment (staging, prod, local)
- `FOSS_COGNITO_DOMAIN`, `FOSS_MPASS_DOMAIN` — override IDP hosts (don't derive from base URL)

See `.env.example` for the full list.

## Running Tests

```bash
npm test                  # all tests (default: chromium)
npm run test:auth         # tests/auth/ only
npm run test:apps         # tests/apps/ only
npm run test:flows        # tests/flows/ only
npm run test:all-browsers # full suite × chromium + firefox + webkit
npm run report            # open the last HTML report
```

Filter to a single test:

```bash
npx dotenv -- npx playwright test -g "Logout All"
```

## Test Structure

```
tests/
├── auth/                              # SSO chain invariants
│   ├── sso-login.spec.ts              # cookie shape, persistence, samesite
│   ├── session-sharing.spec.ts        # shared cookie scope + expiry bounds
│   └── session-lifecycle.spec.ts      # logout, invalidation, replay, cookie deletion
├── apps/                              # per-app surfaces
│   ├── outline.spec.ts                # branding + link coverage (factory)
│   ├── penpot.spec.ts                 # branding + link coverage (canvas-SPA exempt)
│   ├── pm.spec.ts                     # link coverage (factory)
│   ├── pm-godmode.spec.ts             # /god-mode bypasses ForwardAuth
│   └── surfsense.spec.ts              # link coverage (factory)
├── flows/                             # end-to-end user journeys
│   └── login-logout-flow.spec.ts      # login → 4 apps → logout (per-app + global)
└── lib/
    └── link-coverage.ts               # registerLinkCoverage() factory used per-app
```

`constants.ts` derives every host from `FOSS_BASE_URL`.
`skills.md` is the canonical contract — what every app must satisfy.

## Auth Architecture

Login is performed once per worker via the configured IDP (AWS Cognito or
mPass). The resulting session state (cookies + storage) is shared across
tests in the same worker — no repeated logins.

Session lifecycle and god-mode tests are exempt from the worker session:
they spawn fresh contexts and manage their own login/logout to avoid
contaminating shared state.

## Pointing at Production

When prod goes live, all you need:

```bash
# .env
FOSS_BASE_URL=https://foss.example.com
FOSS_USER=prod-user@example.com
FOSS_PASS=prod-password
```

The cookie-domain regex, app URLs, and ForwardAuth host all auto-derive.
If prod uses a different mPass IDP, also set `FOSS_MPASS_DOMAIN`.

## CI (GitHub Actions)

Two workflows, one per environment. Each runs the full chromium suite and
uploads the HTML report as an artifact every run.

| Workflow | File | Triggers | Secrets prefix |
|----------|------|----------|----------------|
| `E2E — Sandbox`    | `.github/workflows/e2e-sandbox.yml` | every 12h (00:00 + 12:00 UTC), push to `main`, PR, manual | `SANDBOX_*` |
| `E2E — Production` | `.github/workflows/e2e-prod.yml`    | manual only (gated on `production` Environment) | `PROD_*` |

### Sandbox setup (one-time)

**Settings → Secrets and variables → Actions → Secrets:**

| Name | Required | Purpose |
|------|----------|---------|
| `SANDBOX_FOSS_USER` | ✅ | SSO username for the sandbox test account |
| `SANDBOX_FOSS_PASS` | ✅ | SSO password |
| `SANDBOX_PLANE_ADMIN_USER` | optional | enables god-mode admin sign-in test |
| `SANDBOX_PLANE_ADMIN_PASS` | optional | same |

**Variables tab (optional):**

| Name | Purpose |
|------|---------|
| `SANDBOX_FOSS_BASE_URL` | override sandbox URL (defaults to `https://foss.arbisoft.com`) |

### Production setup (one-time)

**Settings → Environments → New environment → `production`:**

1. Add **required reviewers** so prod runs need explicit approval.
2. Add the secrets below as **Environment secrets** (not repository
   secrets — Environment secrets only release when an approver clicks):

| Name | Required | Purpose |
|------|----------|---------|
| `PROD_FOSS_USER` | ✅ | SSO username for prod |
| `PROD_FOSS_PASS` | ✅ | SSO password |
| `PROD_PLANE_ADMIN_USER` | optional | god-mode admin user |
| `PROD_PLANE_ADMIN_PASS` | optional | god-mode admin pass |

**Variables (repo or environment):**

| Name | Required | Purpose |
|------|----------|---------|
| `PROD_FOSS_BASE_URL` | ✅ | prod main portal URL (e.g. `https://foss.example.com`) |
| `PROD_FOSS_MPASS_DOMAIN` | optional | prod mPass IDP host if it differs from sandbox |
| `PROD_FOSS_COGNITO_DOMAIN` | optional | prod Cognito host if non-default |

### Running

- **Sandbox**: triggers automatically on every push/PR, or click *Actions
  → E2E — Sandbox → Run workflow*.
- **Production**: *Actions → E2E — Production → Run workflow*. Optional
  `base_url` input overrides `PROD_FOSS_BASE_URL` for that one run. Will
  pause for an approver if the `production` Environment requires reviews.
- Daily prod smoke: uncomment the `schedule:` block in
  `.github/workflows/e2e-prod.yml`.

### Local CI mode

```bash
CI=true npm test
```

CI mode: 2 workers, 1 retry, HTML report saved but not opened.
Screenshots, videos, and traces written to `test-results/` on failure.
