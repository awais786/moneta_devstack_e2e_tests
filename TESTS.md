# Test catalog

A top-to-bottom inventory of every test in this suite, grouped by area.
Each row says what *invariant* the test pins down — not just *what it does*.

## Identities used

Two SSO accounts span every test, plus one local-credential identity for
Plane's god-mode (which sits outside the SSO chain).

| Env var | Identity | Role | Where used |
|---|---|---|---|
| `FOSS_USER` / `FOSS_PASS` | **User A** | Admin across every SSO app (Outline `role=admin`, Penpot/SurfSense Owner of own workspace, Twenty `canAccessFullAdminPanel=true`) | Worker fixture — auto-logged-in for every `test()` block |
| `NORMAL_USER` / `NORMAL_PASS` | **User B** | Non-admin baseline — never promoted | Non-admin role-split blocks (loaded explicitly in fresh contexts) |
| `PLANE_ADMIN_USER` / `PLANE_ADMIN_PASS` | Plane local admin | Instance admin for Plane's `/god-mode` only (local email + password — bypasses SSO entirely) | `tests/apps/pm-godmode.spec.ts` |

Blocks that require `NORMAL_USER` or `PLANE_ADMIN_USER` self-skip when those env vars are unset.

---

## `tests/auth/` — SSO chain + session lifecycle

### `sso-login.spec.ts` — SSO cookie shape + session persistence

| Test | Pins down |
|---|---|
| `authenticated session lands on FOSS platform, not Cognito` | After SSO completes, the browser is on a FOSS host, not the IDP. |
| `_oauth2_proxy cookie present on .<COOKIE_DOMAIN> after login` | The SSO cookie exists and is scoped to the platform domain. |
| `_oauth2_proxy cookie has SameSite=Lax (allows cross-subdomain sharing)` | Cookie's `SameSite` must be `Lax` — `Strict` would break cross-app navigation. |
| `session localStorage key set after login` | The SPA wrote its session marker on first authenticated load. |
| `session survives reload + revisit (cookie unchanged, no re-auth)` | A reload doesn't trigger a fresh SSO round-trip; the cookie persists. |

### `session-sharing.spec.ts` — multi-app session sharing + expiry

| Test | Pins down |
|---|---|
| `_oauth2_proxy cookie is shared across all FOSS subdomains` | One login covers all 5 apps. |
| `_oauth2_proxy cookie has a valid future expiry within session bounds` | The cookie expiry is in the future AND within the 30-day SSO TTL. |
| `auth/session cookies on every app have valid future expiry within session bounds` | Same expiry check on every per-app session cookie (Outline `accessToken`, Penpot, Plane, etc.). |
| `round-trip across all apps requires no re-authentication` | Visiting every app in sequence with one cookie never bounces to the IDP. |

### `session-lifecycle.spec.ts` — logout, replay, deletion

| Test | Pins down |
|---|---|
| `logout clears the _oauth2_proxy SSO cookie` | UI logout invalidates the cookie. |
| `deleting the _oauth2_proxy cookie locks every app behind the IDP` | Without the cookie, every app bounces to the IDP. |
| `session cannot be resumed by replaying the old cookie after logout` | A captured pre-logout cookie can't be replayed to resurrect the session. |

### `twenty-refresh-after-idle.spec.ts` — Twenty's local-session re-issue

| Test | Pins down |
|---|---|
| `valid SSO cookie + cleared Twenty session + reload → stays on Twenty` | When only Twenty's local session is cleared but the SSO cookie is still valid, a reload re-issues the Twenty JWT and the user stays on Twenty — does not bounce to the IDP. |

### `identity-consistency.spec.ts` — every backend resolves the same identity

| Test | Pins down |
|---|---|
| `every backend resolves the logged-in user to the same email` | Plane `/api/users/me/`, Outline `/api/auth.info`, Penpot `get-profile`, SurfSense `/users/me` all return the same synthesised email — proves `DEFAULT_EMAIL_DOMAIN` is identical across containers. |

---

## `tests/apps/` — per-app coverage

### `outline.spec.ts` — Outline branding + link coverage

| Test | Pins down |
|---|---|
| `page title carries Outline branding` | `/home` renders the Outline app shell (page title matches `/outline/i`). |
| Link coverage (×3, via `registerLinkCoverage`) — start page exposes ≥ 1 internal link; every link loads <400; clicking each link stays within host. |

### `outline-admin.spec.ts` — Outline `/settings/*` SSO-gating + role split

Outline has no separate `/admin` URL. Admin is a per-user role on the
`users` table (`role` enum). The 14 `/settings/*` URLs split cleanly
into "common" (any SSO user) and "admin-only" (server-side gated).

| Block | Tests | Pins down |
|---|---|---|
| Cold context | 14 (one per `/settings/*` URL) | No SSO cookie → every URL bounces through ForwardAuth / IDP. |
| Non-admin role split — common (skips without `NORMAL_USER`) | 5 (`/settings`, `/members`, `/groups`, `/api-and-access`, `/shares`) | NORMAL_USER reaches with a real page title — these are accessible to everyone. |
| Non-admin role split — admin-only (skips without `NORMAL_USER`) | 8 (`/details`, `/security`, `/authentication`, `/features`, `/integrations`, `/applications`, `/import`, `/export`) | NORMAL_USER gets Not Found / module-load failure / SPA shell — pages are server-side gated. |
| Admin reaches every page | 13 | FOSS_USER (admin) reaches every page above with a proper page title — no Not Found, no chunk-load failure. |

### `penpot.spec.ts` — Penpot branding + hash-route nav coverage

| Test | Pins down |
|---|---|
| `page title carries Penpot branding` | Home renders Penpot's SPA shell (title matches `/penpot/i`). |
| `every well-known hash route loads on Penpot host without auth wall` | Each hash route (`#/dashboard/projects`, `#/settings/profile`, …) stays on Penpot host, no auth wall, no 404. |

### `pm.spec.ts` — Plane link coverage

| Test | Pins down |
|---|---|
| Link coverage (×3) — start page exposes ≥ 1 internal link; every link loads <400; clicking each link stays within host. |

### `pm-godmode.spec.ts` — Plane god-mode (escape hatch)

god-mode bypasses oauth2-proxy ForwardAuth and uses local email + password.

| Test | Pins down |
|---|---|
| `cold visit to /god-mode/ does NOT redirect through ForwardAuth/IDP` | The bypass router actually bypasses — `/god-mode/` doesn't hit the SSO chain. |
| `god-mode renders Plane's own admin login form` | The page exposes Plane's own email/password form (not the SSO IDP). |
| `admin can sign in via god-mode and reach the admin console` (skips without `PLANE_ADMIN_USER`) | Submitting the form with valid local creds reaches the admin console. |
| `god-mode rejects an incorrect password` (skips without `PLANE_ADMIN_USER`) | Wrong password keeps the user on the login form. |
| `/auth/get-csrf-token bypasses ForwardAuth (cold context)` | The csrf token endpoint required for the login POST is also bypass-routed. |
| `god-mode admin login does not affect the SSO _oauth2_proxy cookie` (skips without `PLANE_ADMIN_USER`) | god-mode is a separate session universe — signing in there doesn't issue the platform SSO cookie. |

### `surfsense.spec.ts` — SurfSense link coverage

| Test | Pins down |
|---|---|
| Link coverage (×3) — same shape as the other apps. |

### `twenty.spec.ts` — Twenty link coverage (SPA, route-mutating nav)

| Test | Pins down |
|---|---|
| Link coverage (×3) — `waitUntil:"commit"` because Twenty keeps a GraphQL-subscriptions websocket open and never hits `networkidle`. |

### `twenty-admin.spec.ts` — Twenty `/settings/admin-panel` URL gate

Twenty has a real admin URL gated server-side by `AdminPanelGuard`
checking `User.canAccessFullAdminPanel === true`.

| Test | Pins down |
|---|---|
| `cold visit to /settings/admin-panel bounces through SSO` | No SSO cookie → bounces to ForwardAuth / IDP. |
| `non-admin lands on Twenty but admin-panel content is not rendered` (skips without `NORMAL_USER`) | NORMAL_USER lands on the Twenty host but sees zero admin UI markers (Health Status, Feature Flags, Config Variables, AI Models, Admin Panel). |
| `admin reaches /settings/admin-panel with admin UI visible` | FOSS_USER (admin) sees at least one admin marker — the page actually renders the admin panel. |

---

## `tests/flows/` — end-to-end user journeys

### `login-logout-flow.spec.ts` — fresh login → 5 apps → logout

Serial — these tests depend on running in order.

| Test | Pins down |
|---|---|
| `login once, then every app loads authenticated without re-auth` | Single SSO login covers Outline, Penpot, Plane, SurfSense, Twenty without re-authenticating. |
| `main portal "Log out of all apps" button kills SSO and every app falls back to the IDP` | The portal logout invalidates the SSO cookie globally — every app now bounces to the IDP. |
| `/oauth2/sign_out endpoint clears SSO cookie and redirects` | Per-app sign-out endpoint also clears the SSO cookie (same effect, different entry point). |

---

## `tests/security/` — edge-layer invariants (sso-rules `RULES.md`)

### `headers.spec.ts` — canonical security headers on every router

Iterates over `*-secure`, `*-bypass`, `oauth2-proxy-secure`, and
`oauth2-apps` routers (headers are per-response, not host-cached —
each router type must be verified separately).

| Test | Pins down |
|---|---|
| `<router> sets the canonical security headers` (×N) | HSTS (`max-age ≥ 180d` + `includeSubDomains`), `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY|SAMEORIGIN`, `Referrer-Policy`, `Permissions-Policy` denying camera/mic/geolocation. |

### `http-no-plaintext.spec.ts` — every host refuses port-80 content

| Test | Pins down |
|---|---|
| `<host> — no content served over plain HTTP` (×N per host) | Port 80 redirects to https or refuses the connection. No 2xx ever served over plain HTTP. |

### `header-spoofing.spec.ts` — X-Auth-Request-* spoofing rejected

| Block | Test | Pins down |
|---|---|---|
| auth gate (unauth'd) | `<app>: spoofed X-Auth-Request-* without cookie does not grant access` | A request with spoofed identity headers but no SSO cookie still bounces to auth (or 4xx). |
| strip middleware (authed) | `<app>: spoofed X-Auth-Request-Email does not flip backend identity (partial)` | Even with a valid SSO cookie, inbound `X-Auth-Request-*` headers are scrubbed by `strip-auth-headers` before the backend can trust them. |

### `bypass-surface.spec.ts` — public paths reachable, protected paths gated

| Test | Pins down |
|---|---|
| `<app>: /favicon.ico is reachable without auth` | Static asset is bypass-routed. |
| `<app>: /robots.txt is reachable without auth` | Same. |
| `<app>: root / requires auth (catch-all gate is live)` | The catch-all `/` still bounces to auth — only the documented public paths are reachable. |

### `sso-mode-no-local-login.spec.ts` — no local-login UI in SSO mode

| Test | Pins down |
|---|---|
| `<app>: LOCAL_AUTH_ROUTES must be configured for E11/E12` | The test config declares the local-auth routes for the app — guards against a future "no routes = no failures" regression. |
| `<app> <route>: no reachable password input` (×N per app) | None of Plane `/sign-in`, Outline `/auth/email`, Penpot `/#/auth/*`, SurfSense `/login`, Twenty `/sign-in` etc. render a reachable `<input type="password">`. |

### `strip-on-bypass.spec.ts` — bypass routers smoke

| Test | Pins down |
|---|---|
| `<router>: bypass path is reachable without 5xx` | Bypass-routed paths still respond — chained `strip-auth-headers` middleware on bypass routers (from `foss-server-bundle#30`) doesn't break the bypass path. |

---

## Skip behaviour cheat-sheet

These conditions are honored *as-is*. Set the right env vars and the
self-skipping blocks fire automatically.

| Block | Skips when… |
|---|---|
| `pm-godmode.spec.ts` admin-sign-in + wrong-password + cookie-isolation | `PLANE_ADMIN_USER` or `PLANE_ADMIN_PASS` unset |
| `outline-admin.spec.ts` non-admin role-split (14 tests) | `NORMAL_USER` or `NORMAL_PASS` unset |
| `twenty-admin.spec.ts` non-admin gate (1 test) | `NORMAL_USER` or `NORMAL_PASS` unset |
| Any individual cross-browser test | Default Chromium-only run — `BROWSERS=all` enables Firefox + WebKit |
