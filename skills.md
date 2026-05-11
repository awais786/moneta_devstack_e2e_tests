# FOSS App Test Coverage Skill

This is the test-coverage contract every app on the FOSS platform must satisfy.
Coverage is split between **shared suites** (run once across all 5 apps via
`APPS`) and a **per-app suite** that crawls each app's link surface. Adding a
new app to the platform should require touching one constant and registering
one factory call — nothing more.

The canonical rule source is `RULES.md` in
[awais786/sso-rules](https://github.com/awais786/sso-rules). This file
mirrors the **testable** subset of those rules onto specific spec files
and notes the failure modes each test can / cannot catch.

---

## §1 — Universal invariants (shared suites, no per-app code)

Every entry in `APPS` (defined in `constants.ts`) is automatically validated by
the suites below. Don't duplicate these checks per app.

| # | Rule | Source |
|---|------|--------|
| U1 | `_oauth2_proxy` cookie shared across all 5 FOSS subdomains | `tests/auth/session-sharing.spec.ts` |
| U2 | `_oauth2_proxy` has valid future expiry within session bounds | `tests/auth/session-sharing.spec.ts` |
| U3 | Every app's auth/session cookies have expiry within 30-day SSO TTL bound | `tests/auth/session-sharing.spec.ts` |
| U4 | Round-trip across all 5 apps requires no re-auth | `tests/auth/session-sharing.spec.ts` |
| U5 | Cookie has SameSite=Lax + Secure + HttpOnly, set after login | `tests/auth/sso-login.spec.ts` |
| U6 | Session survives reload and revisit without re-auth | `tests/auth/sso-login.spec.ts` |
| U7 | UI logout on portal clears SSO cookie | `tests/auth/session-lifecycle.spec.ts` |
| U8 | UI logout invalidates session on every app | `tests/auth/session-lifecycle.spec.ts` |
| U9 | Pre-logout cookie cannot be replayed in a fresh context | `tests/auth/session-lifecycle.spec.ts` |
| U10 | Fresh login → all 5 apps load authed without re-auth | `tests/flows/login-logout-flow.spec.ts` |
| U11 | `/oauth2/sign_out` endpoint clears cookie and redirects | `tests/flows/login-logout-flow.spec.ts` |
| U12 | Main portal **"Log out of all apps"** → all 5 apps bounce to IDP | `tests/flows/login-logout-flow.spec.ts` |
| U13 | Plane `/god-mode/` bypasses ForwardAuth (admin escape hatch) | `tests/apps/pm-godmode.spec.ts` |
| U14 | Deleting `_oauth2_proxy` (cookie expiry stand-in) locks every app | `tests/auth/session-lifecycle.spec.ts` |
| U15 | Plane `/auth/get-csrf-token` also bypasses ForwardAuth (god-mode prerequisite) | `tests/apps/pm-godmode.spec.ts` |
| U16 | god-mode admin login does **not** issue the platform SSO cookie | `tests/apps/pm-godmode.spec.ts` |
| U17 | god-mode rejects an incorrect password (form stays visible, no admin nav) | `tests/apps/pm-godmode.spec.ts` |
| U18 | Twenty: valid SSO cookie + cleared local Twenty session + reload stays on Twenty (refresh re-issues local session from SSO cookie) | `tests/auth/twenty-refresh-after-idle.spec.ts` |

App-level smoke (HTTP status, title, host stability, no login wall) is no
longer a separate suite — it is fully implied by `Link Coverage › every
internal link loads without auth wall or error`, which exercises the same
checks on every discovered route including the start page.

---

## §2 — Edge-layer + identity invariants (RULES.md §1)

These validate Traefik routing, oauth2-proxy + ForwardAuth, and backend
identity handling. Some are partial checks — what's actually provable
from outside the stack is narrower than what RULES.md asserts. Each
limitation is called out in §6.

| # | Rule | Source |
|---|------|--------|
| E1 | Every host on port 80 redirects to https or refuses the connection — no 2xx ever served over plain HTTP | `tests/security/http-no-plaintext.spec.ts` |
| E2 | Every `*-secure` router emits the canonical security-headers set (HSTS ≥180d + includeSubDomains, X-Content-Type-Options=nosniff, X-Frame-Options=DENY/SAMEORIGIN, Referrer-Policy, Permissions-Policy denying camera/mic/geo) | `tests/security/headers.spec.ts` |
| E3 | Every `*-bypass` router (Plane `/god-mode`, Outline `/favicon.ico`) emits the same headers — the middleware was added to bypass routers in foss-server-bundle#30 | `tests/security/headers.spec.ts` |
| E4 | `oauth2-proxy-secure` (the SSO login form itself at `auth.foss.<domain>/oauth2/sign_in`) emits the same headers | `tests/security/headers.spec.ts` |
| E5 | `oauth2-apps` host bindings (every app's `/oauth2/sign_in`) emit the same headers — verifies the middleware fires on every host binding of the same oauth2-proxy process | `tests/security/headers.spec.ts` |
| E6 | Unauth'd request with spoofed `X-Auth-Request-*` headers to any app's `/` MUST bounce to auth or 4xx — proves mpass-auth is in front of `/` | `tests/security/header-spoofing.spec.ts` (describe: auth gate) |
| E7 | Authed request with a spoofed `X-Auth-Request-Email` for a DIFFERENT user MUST NOT flip the backend's view of identity — see F1 for the partial-check caveat | `tests/security/header-spoofing.spec.ts` (describe: strip middleware) |
| E8 | `/favicon.ico` and `/robots.txt` are reachable on every app host without a cookie (static-asset bypass discipline) | `tests/security/bypass-surface.spec.ts` |
| E9 | The secure catch-all is still gated: root `/` without cookie redirects to auth — inverse-control anchor for E8 | `tests/security/bypass-surface.spec.ts` |
| E10 | Bypass routers (`/favicon.ico`, `/god-mode`) are reachable and don't 5xx — router-reachability smoke check, NOT strip validation | `tests/security/strip-on-bypass.spec.ts` |
| E11 | `AUTH_TYPE=SSO` UI gate: every known local-auth route (Plane `/sign-in`, Outline `/auth/email`, Penpot `/#/auth/*`, SurfSense `/login`, Twenty `/sign-in`/`/welcome`) MUST NOT render a reachable `<input type="password">` — and a 404 from upstream rename fails LOUDLY (no quiet pass on rot) | `tests/security/sso-mode-no-local-login.spec.ts` |
| E12 | Same routes MUST NOT render a visible local-credential affordance (`forgot password`, `reset password`, `sign in with password`, `continue with email`) — backstop for SPAs that render local-login via custom components instead of `<input type="password">` | `tests/security/sso-mode-no-local-login.spec.ts` |
| E13 | Every backend resolves the same logged-in user to the same email — Plane `/api/users/me/`, Outline `POST /api/auth.info`, Penpot RPC `get-profile`, SurfSense `/users/me` must all agree (Twenty omitted — its REST endpoints need a JWT Bearer, see F4) | `tests/auth/identity-consistency.spec.ts` |
| E14 | Each backend's reported email derives from oauth2-proxy's forwarded user value (`/oauth2/userinfo`) — catches per-backend `DEFAULT_EMAIL_DOMAIN` divergence; does NOT catch uniform misconfiguration upstream (see F2) | `tests/auth/identity-consistency.spec.ts` |

---

## §3 — Per-app link-coverage rules (this skill)

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

### Apps without `<a href>` nav (Penpot)

Apps whose UI uses click-handler-driven nav (listitem/button) instead of
anchor tags can't be covered by the generic factory. Penpot is the only
such app today — its spec hits well-known hash routes directly
(`/#/dashboard/recent`, `/#/settings/profile`, etc.) and asserts the
same invariants the factory would (host stays put, no auth wall, no 404
title). The `requireLinks: false` factory flag is still available for
future apps in the same shape.

### Tour overlay handling (SurfSense, etc.)

Apps that ship a product tour cover the page with an invisible
`aria-label="Close tour"` button that intercepts pointer events. The factory
calls a best-effort `dismissTour()` before discovery and before each click, and
all clicks use `force: true` to bypass any remaining overlay.

## §4 — Per-app branding (optional)

When an app sets a recognizable `<title>`, assert it once in
`tests/apps/<app>.spec.ts`:

| App | Title pattern | Verified |
|-----|---------------|----------|
| Outline   | `/outline/i` | ✅ `outline.spec.ts` |
| Penpot    | `/penpot/i`  | ✅ `penpot.spec.ts` |
| Plane (PM) | not branded reliably | — skip |
| SurfSense | not branded reliably | — skip |

---

## §5 — Adding a new app

1. Add a URL to `APP_URLS` in `constants.ts` (env-overridable via `FOSS_APP_<NAME>`).
2. Create `tests/apps/<app>.spec.ts`:
   ```ts
   import { APP_URLS } from "../../constants";
   import { registerLinkCoverage } from "../lib/link-coverage";

   registerLinkCoverage({ appName: "MyApp", baseUrl: APP_URLS.MyApp });
   ```
3. (Optional) add a branding assertion in the same file.
4. The shared suites (U1–U18, E1–E12) pick the new app up automatically via `APPS`.
5. To include the new app in `identity-consistency.spec.ts` (E13/E14), add a
   probe entry with the app's `/me`-shape endpoint and its email-extraction
   function.

---

## §6 — Findings + known limitations

Tests that catch SOME failure modes but not all, plus deployment-state
observations that affect interpretation.

### Limitations of individual tests

| # | Test | What it catches | What it does NOT catch | Why |
|---|------|-----------------|------------------------|-----|
| F1 | E7 (strip middleware authed test) | Backend that explicitly prefers inbound headers over ForwardAuth-injected ones; mpass-auth accidentally removed from a router | Missing `strip-auth-headers` on stacks where Traefik REPLACES (rather than appends) `X-Auth-Request-Email` with oauth2-proxy's value | Traefik's `authResponseHeaders` behavior varies; when it replaces, the spoofed value gets overwritten by mpass-auth even with strip removed, and the test passes vacuously |
| F2 | E14 (identity canonical-derivation check) | One backend's `DEFAULT_EMAIL_DOMAIN` env diverges from the others | Every backend AND oauth2-proxy uniformly misconfigured (e.g. all containers reading the same wrong env var) | `/oauth2/userinfo` is itself part of the chain we're verifying; closing this fully would need a direct Cognito `/userInfo` call from outside the proxy |
| F3 | E10 (strip-on-bypass) | Bypass router pointed at a misconfigured / dead backend | `strip-auth-headers` actually running before the bypass upstream | None of the tested bypass paths (`/favicon.ico`, `/god-mode`) read `X-Auth-Request-*`, so the presence of strip is unobservable from outside |
| F4 | E13 (identity consistency) | Per-backend identity divergence for Plane/Outline/Penpot/SurfSense | Twenty's backend identity | Twenty's `/rest/*` endpoints require a JWT Bearer (not the SSO cookie); the SPA also hides identity-managed fields by design. Twenty's identity goes through one SSO controller (`sso-proxy-login.controller.ts:resolveEmail`), audited manually |
| F5 | E12 (local-login affordance text regex) | Routes that render an explicit `forgot password` / `continue with email` / `sign in with password` affordance | A SPA that renders a local-login form using only generic "Sign in" / "Log in" button text and no other affordance | Broadening the regex to bare "Sign in" would false-positive on the legitimate SSO redirect page itself. The `<input type=password>` check (E11) is the stronger primary signal; E12 is a low-FP backstop |

### Deployment-state observations

| # | Observation | Implication |
|---|-------------|-------------|
| F6 | Cognito returns a **bare username** (not a full email) as the subject (verified: `1020010000019120`) | The `DEFAULT_EMAIL_DOMAIN` synthesis path IS exercised on this deployment. Every backend's `/me` returns `<sub>@askii.ai`. If the deployment ever migrates to email-as-subject in Cognito, E13/E14 trivially pass without exercising synthesis — re-evaluate then |
| F7 | Twenty's first-paint client redirect aborts in-flight `load` / `domcontentloaded` navigations | `tests/apps/twenty.spec.ts` uses `waitUntil: "commit"` and the L7 click test re-collects anchors after each reset goto (see PR #9) |
| F8 | Twenty's sidebar mutates by route — anchors discovered on one view aren't all rendered after a reset goto | L7 silently skips discovery-time hrefs not currently rendered; asserts `clicked > 0` so the test never silently degrades |
| F9 | Outline `accessToken` cookie expires in 92 days (`addMonths(3)`) — the fork doesn't yet wire `SESSION_TTL_SECONDS` | U3 fails on Outline until the fork patch lands. Documented in README "Known platform findings" |

### Audit cadence

- E7's limitation (F1) and E14's limitation (F2) mean `strip-auth-headers`
  ordering and uniform DEFAULT_EMAIL_DOMAIN remain audit invariants, not
  fully live-tested ones. Re-audit on every change to `docker-compose.yml`
  Traefik middleware chains or to any container's identity-related env vars.
- E13's Twenty omission (F4) is acceptable so long as Twenty has exactly one
  SSO entry path (`sso-proxy-login.controller.ts`). If Twenty grows a second
  identity-issuance path (e.g. CLI auth), revisit and add a probe.

---

## §7 — Implementation reference

Single source of truth: `tests/lib/link-coverage.ts`

- `resolveStartUrl(page, baseUrl)` → enforces L1.
- `waitForAnchors(page, { requireLinks })` → waits for anchor count to
  stabilize before discovery, so SPAs with streaming sidebars (Twenty)
  aren't sampled mid-hydration.
- `collectInternalHrefs(page, host)` → enforces L8 + dedupe + same-host filter.
- `registerLinkCoverage({ appName, baseUrl, includeClickTest?, waitUntil? })` →
  registers the L2 + L3–L6 + L7 tests inside a per-app `describe` block.
