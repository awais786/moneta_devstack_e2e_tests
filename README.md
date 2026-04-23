# FOSS E2E — Playwright Test Suite

End-to-end tests for the [FOSS platform](https://foss.arbisoft.com) — SSO authentication, multi-app session sharing, access control, session lifecycle, and cross-browser validation across all 4 apps.

## Apps Under Test

| App | URL |
|-----|-----|
| Outline (Docs) | https://foss-docs.arbisoft.com |
| PM / Onboarding | https://foss-pm.arbisoft.com |
| Penpot (Design) | https://foss-design.arbisoft.com |
| SurfSense (Research) | https://foss-research.arbisoft.com |

## Prerequisites

- Node.js 18+
- Playwright browsers installed

```bash
npm install
npm run install:browsers
```

## Configuration

Copy `.env.example` to `.env` and fill in credentials:

```bash
cp .env.example .env
```

```env
FOSS_USER=you@arbisoft.com
FOSS_PASS=your_password_here
```

## Running Tests

```bash
# All tests (Chromium, Firefox, Safari)
npm test

# Auth tests only — Chromium
npm run test:auth

# App tests only — Chromium
npm run test:apps

# Auth tests across all browsers
npm run test:all-browsers

# Open HTML report after a run
npm run report
```

## Test Structure

```
tests/
├── auth/
│   ├── sso-login.spec.ts          # SSO login flow via AWS Cognito
│   ├── session-sharing.spec.ts    # Single session shared across all apps
│   └── session-lifecycle.spec.ts  # Logout, session invalidation, cookie replay
└── apps/
    ├── cross-app.spec.ts          # Cross-app consistency checks
    ├── outline.spec.ts            # Outline-specific tests
    ├── pm.spec.ts                 # PM / Onboarding tests
    ├── penpot.spec.ts             # Penpot design app tests
    └── surfsense.spec.ts          # SurfSense research app tests
```

## Auth Architecture

Login is performed once per worker via AWS Cognito SSO. The resulting session state (cookies + storage) is shared across tests in the same worker — no repeated logins.

Session lifecycle tests (`session-lifecycle.spec.ts`) are exempt from this: they create isolated browser contexts and perform their own login/logout to avoid contaminating the shared session.

## CI

```bash
CI=true npm test
```

In CI mode: 2 workers, 1 retry, HTML report saved but not opened.

Screenshots, videos, and traces are captured on failure and written to `test-results/`.
