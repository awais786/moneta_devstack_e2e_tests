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
| U1 | `_oauth2_proxy` cookie shared across all 4 FOSS subdomains | `tests/auth/session-sharing.spec.ts` |
| U2 | `_oauth2_proxy` has valid future expiry within session bounds | `tests/auth/session-sharing.spec.ts` |
| U3 | Every app's auth/session cookies have expiry within 30-day SSO TTL bound | `tests/auth/session-sharing.spec.ts` |
| U4 | Round-trip across all 4 apps requires no re-auth | `tests/auth/session-sharing.spec.ts` |
| U5 | Cookie has SameSite=Lax + Secure + HttpOnly, set after login | `tests/auth/sso-login.spec.ts` |
| U6 | Session survives reload and revisit without re-auth | `tests/auth/sso-login.spec.ts` |
| U7 | UI logout on portal clears SSO cookie | `tests/auth/session-lifecycle.spec.ts` |
| U8 | UI logout invalidates session on every app | `tests/auth/session-lifecycle.spec.ts` |
| U9 | Pre-logout cookie cannot be replayed in a fresh context | `tests/auth/session-lifecycle.spec.ts` |
| U10 | Fresh login → all 4 apps load authed without re-auth | `tests/flows/login-logout-flow.spec.ts` |
| U11 | `/oauth2/sign_out` endpoint clears cookie and redirects | `tests/flows/login-logout-flow.spec.ts` |
| U12 | Main portal **"Log out of all apps"** → all 4 apps bounce to IDP | `tests/flows/login-logout-flow.spec.ts` |
| U13 | Plane `/god-mode/` bypasses ForwardAuth (admin escape hatch) | `tests/apps/pm-godmode.spec.ts` |
| U14 | Deleting `_oauth2_proxy` (cookie expiry stand-in) locks every app | `tests/auth/session-lifecycle.spec.ts` |

App-level smoke (HTTP status, title, host stability, no login wall) is no
longer a separate suite — it is fully implied by `Link Coverage › every
internal link loads without auth wall or error`, which exercises the same
checks on every discovered route including the start page.

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

### Canvas-SPA exemption (Penpot)

Apps that render their UI through canvas/SVG without `<a href>` (Penpot is the
only one today) opt out of L2–L7 by passing `requireLinks: false` to
`registerLinkCoverage`. L1 still runs. Downstream tests self-skip with a clear
"no anchors found" reason in the report.

### Tour overlay handling (SurfSense, etc.)

Apps that ship a product tour cover the page with an invisible
`aria-label="Close tour"` button that intercepts pointer events. The factory
calls a best-effort `dismissTour()` before discovery and before each click, and
all clicks use `force: true` to bypass any remaining overlay.

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
