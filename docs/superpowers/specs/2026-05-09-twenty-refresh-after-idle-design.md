# Twenty: refresh-after-idle should not bounce to login

## Background

Observed on `https://twenty.foss.arbisoft.com`: leaving the Twenty tab idle
~30 min and then refreshing redirects the user to the login page, even
though the shared `_oauth2_proxy` SSO cookie has a longer TTL and is still
valid in the browser. The other apps in the bundle (Outline, Plane,
Penpot, SurfSense) are not currently reported with this symptom; this spec
covers only Twenty.

The likely mechanism: Twenty maintains its own client-side session
(cookie and/or `localStorage`) with a shorter TTL than the SSO cookie.
When that local session is gone, Twenty's frontend short-circuits to
`/login` instead of letting the oauth2-proxy → forward-auth chain
re-establish the session from the still-valid `_oauth2_proxy` cookie.
The expected behavior is that as long as the SSO cookie is valid, a
refresh should keep the user inside Twenty (no auth-wall redirect).

## Goal

Add an e2e regression test that fails today (proves the bug) and will
pass once Twenty's auth flow correctly re-uses the SSO cookie. The test
must run in CI in seconds — it cannot literally idle for 30 min.

## Non-goals

- Fixing Twenty's auth flow.
- Generalizing to other apps. (May follow-up; out of scope here.)
- Asserting specific cookie names or TTL values inside Twenty — those
  are implementation details and would make the test brittle.

## Test design

**File:** `tests/auth/twenty-refresh-after-idle.spec.ts`

Placed alongside the other session-lifecycle tests, not under
`tests/apps/`, because the behavior under test is SSO session lifecycle,
not Twenty link coverage.

**Strategy:** simulate "Twenty's local session has expired but the SSO
cookie is still valid" by clearing every cookie on the Twenty host
*except* `_oauth2_proxy`, plus clearing Twenty-origin `localStorage` and
`sessionStorage`. Then reload and assert the page is still on the Twenty
host (not on an auth wall).

**Steps:**

1. Login a fresh browser context via `cognitoLogin` (same pattern as
   `session-lifecycle.spec.ts`).
2. Navigate to `APP_URLS.Twenty` and confirm the page is on the Twenty
   host (sanity check).
3. Capture cookies. Confirm `_oauth2_proxy` is present.
4. Clear every cookie *except* `_oauth2_proxy`. Use Playwright's
   `context.clearCookies({ name: ... })` per non-SSO cookie, or capture
   the SSO cookie, `clearCookies()` everything, then `addCookies()` the
   SSO one back.
5. Clear Twenty-origin `localStorage` and `sessionStorage` via
   `page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); })`.
6. `page.reload({ waitUntil: "domcontentloaded" })` — `domcontentloaded`
   matches the rest of the suite's handling of Twenty's GraphQL
   websocket (see `session-lifecycle.spec.ts:80` and
   `tests/apps/twenty.spec.ts`).
7. Assert `!isAuthWall(page.url())`. If the test fails, the URL
   contains `auth.foss.<domain>` or an IDP host — exactly the bug we
   want to catch.

**Why the assertion is just "not on auth wall":** we don't want to
over-specify ("must be at `/objects` route", "must show table view")
because Twenty's landing route can change. The minimal contract under
test is: refresh + valid SSO cookie ⇒ user stays inside the app.

**Cleanup:** wrap in try/finally to `context.close()`, mirroring the
existing `loginFreshContext` pattern. No shared worker session — this
test mutates auth state.

## Risks and edge cases

- **`localStorage` may be empty.** No-op clear is fine; the test still
  exercises cookie-only expiry.
- **Twenty may issue cookies under multiple paths.** `clearCookies`
  without a `path` filter clears every match, so this is handled.
- **The bug may be server-side (oauth2-proxy session refresh, not
  Twenty's frontend).** The test still catches it — we only assert the
  user-visible outcome (auth wall vs. not).
- **False positive risk:** if Twenty in the future starts requiring a
  hard re-login for unrelated reasons even with a valid SSO cookie, the
  test will fail. That's the correct signal — the contract is "valid
  SSO cookie ⇒ no auth-wall redirect on refresh."

## Out of scope / follow-ups

- Parameterizing this test across all five apps once it's stable.
- Asserting cookie TTL attributes directly (`Max-Age` / `Expires`).
- Testing actual 30-min idle via Playwright `page.clock` — won't help
  because cookie expiry is server-side.

## Acceptance criteria

- New test file `tests/auth/twenty-refresh-after-idle.spec.ts` exists.
- Running the test against the current deployment **fails** with the
  page landing on an auth-wall URL after reload (proves bug).
- Running the test after Twenty's auth fix **passes** with the page
  remaining on the Twenty host.
- No other tests are modified or made flaky.
