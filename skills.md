# FOSS App Test Coverage Skill

This is the test-coverage contract every app on the FOSS platform must satisfy.
Coverage is split between **shared suites** (run once across all 4 apps via
`APPS`) and a **per-app suite** that crawls each app's link surface. Adding a
new app to the platform should require touching one constant and registering
one factory call — nothing more.

---

## §1 — Universal invariants (shared suites, no per-app code)

Every entry in `APPS` (defined in `constants.ts`) is automatically validated by
the suites below. Don't duplicate these checks per app.

| # | Rule | Source |
|---|------|--------|
| U1 | Authenticated visit returns HTTP `<400` | `tests/apps/cross-app.spec.ts` |
| U2 | Page `<title>` is non-empty and contains no `error` / `404` | `tests/apps/cross-app.spec.ts` |
| U3 | App stays on its own host (no off-host redirect) | `tests/apps/cross-app.spec.ts` |
| U4 | No login form / "Sign in" button visible when authed | `tests/apps/cross-app.spec.ts` |
| U5 | `_oauth2_proxy` cookie present, scoped to `.arbisoft.com` | `tests/auth/session-sharing.spec.ts` |
| U6 | Round-trip across all 4 apps requires no re-auth | `tests/auth/session-sharing.spec.ts` |
| U7 | `/oauth2/sign_out` on any app clears the SSO cookie | `tests/auth/session-lifecycle.spec.ts` |
| U8 | After logout, no protected route is reachable | `tests/auth/session-lifecycle.spec.ts` |
| U9 | Pre-logout cookie cannot be replayed in a new context | `tests/auth/session-lifecycle.spec.ts` |
| U10 | Login → visit each app → per-app `/oauth2/sign_out` → land on portal/auth wall | `tests/flows/login-logout-flow.spec.ts` |
| U11 | Main portal **"Log out of all apps"** → all 4 apps bounce to an IDP | `tests/flows/login-logout-flow.spec.ts` |

---

## §2 — Per-app link-coverage rules (this skill)

Implemented by `tests/lib/link-coverage.ts` and registered via
`registerLinkCoverage({ appName, baseUrl })` from each `tests/apps/<app>.spec.ts`.

| # | Rule | Why |
|---|------|-----|
| L1 | Visiting the app's `baseUrl` redirects to a **non-reserved** start URL on the same host | Confirms post-login routing isn't stuck on `/auth`, `/login`, `/onboarding`, etc. — the user has a real workspace. |
| L2 | The start page exposes ≥1 same-host `<a href>` | Catches blank-shell renders and SSR auth-loop failures. |
| L3 | Every discovered link returns HTTP `<400` on direct GET | Catches broken routes, dead views. |
| L4 | Every link stays on the app's host (no off-host bounce) | Catches mid-session SSO loss / bad OAuth state. |
| L5 | No link lands on the auth wall (`isAuthWall` = oauth2-proxy or any IDP host) | Same as L4 from a different angle — cookie scoping or expiry regression. |
| L6 | No visited page's title says `404` or `not found` | Catches "200 OK with error body" cases. |
| L7 | Clicking each visible link (when present in DOM) keeps the user on the app's host | Verifies actual click semantics, not just GETtable URLs. |
| L8 | Logout / sign-out paths are **excluded** from the link set | Crawling them would destroy the SSO cookie mid-test. |

### Reserved start-path segments (L1)

If `baseUrl` redirects to a path whose first segment is one of:

```
auth, login, signin, sign-in, sign_in, signup, sign-up,
logout, sign_out, signout, oauth2, onboarding,
create-workspace, invitations, god-mode, accounts, api, static, _next
```

…the test fails loudly: the user has no workspace or is unauthenticated.

### Excluded link patterns (L8)

Any link whose pathname matches `/(logout|sign_out|signout)/i` is dropped from
the discovery set before the assertions in L3–L7 run.

---

## §3 — Per-app branding (optional)

When an app sets a recognizable `<title>`, assert it once in
`tests/apps/<app>.spec.ts`:

| App | Title pattern | Verified |
|-----|---------------|----------|
| Outline   | `/outline/i` | ✅ `outline.spec.ts` |
| Penpot    | `/penpot/i`  | ✅ `penpot.spec.ts` |
| Plane (PM) | not branded reliably | — skip |
| SurfSense | not branded reliably | — skip |

---

## §4 — Adding a new app

1. Add a URL to `APP_URLS` in `constants.ts` (env-overridable via `FOSS_APP_<NAME>`).
2. Create `tests/apps/<app>.spec.ts`:
   ```ts
   import { APP_URLS } from "../../constants";
   import { registerLinkCoverage } from "../lib/link-coverage";

   registerLinkCoverage({ appName: "MyApp", baseUrl: APP_URLS.MyApp });
   ```
3. (Optional) add a branding assertion in the same file.
4. The shared suites (U1–U11) pick the new app up automatically via `APPS`.

---

## §5 — Implementation reference

Single source of truth: `tests/lib/link-coverage.ts`

- `resolveStartUrl(page, baseUrl)` → enforces L1.
- `collectInternalHrefs(page, host)` → enforces L8 + dedupe + same-host filter.
- `registerLinkCoverage({ appName, baseUrl, includeClickTest? })` → registers
  the L2 + L3–L6 + L7 tests inside a per-app `describe` block.
