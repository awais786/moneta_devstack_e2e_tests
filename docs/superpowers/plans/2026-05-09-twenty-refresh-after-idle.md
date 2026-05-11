# Twenty Refresh-After-Idle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Playwright e2e regression test that simulates Twenty's local app-session expiring while the SSO `_oauth2_proxy` cookie is still valid, then asserts that a page refresh keeps the user inside the Twenty app (no auth-wall redirect).

**Architecture:** Single `test.describe` block in a new file under `tests/auth/`. The test logs in via the existing `cognitoLogin` helper (using its own context — does not share the worker storage state, since it mutates auth state). It then captures and re-installs only the `_oauth2_proxy` SSO cookie, clears Twenty-origin `localStorage` / `sessionStorage`, reloads the Twenty page, and asserts the resulting URL is not on an auth-wall host (using the existing `isAuthWall` helper).

**Tech Stack:** Playwright (`@playwright/test` ^1.59), TypeScript, existing helpers `cognitoLogin` (`auth-helpers.ts`), `APP_URLS`, `AUTH_COOKIE`, `isAuthWall` (`constants.ts`).

---

## Background context (read before starting)

- Existing reference test: `tests/auth/session-lifecycle.spec.ts` — mirrors this file's conventions (own contexts, no shared worker storage, `loginFreshContext` pattern, `try/finally` cleanup). Especially note line 80 — Twenty requires `waitUntil: "domcontentloaded"` for navigation, not `networkidle` or `load`, because Twenty keeps a GraphQL websocket open.
- `tests/apps/twenty.spec.ts` — confirms Twenty uses `waitUntil: "load"` for link coverage, but for navigations after auth-state mutation, `domcontentloaded` is the safe choice (per session-lifecycle.spec.ts:80).
- `constants.ts` exports `APP_URLS.Twenty`, `AUTH_COOKIE` (the `_oauth2_proxy` cookie name, env-overridable), and `isAuthWall(url)` which returns true if the URL is on the ForwardAuth host or any IDP host.
- `fixtures.ts` exports a `test` object that pre-loads worker storage state. **We do NOT use that fixture here** — like `session-lifecycle.spec.ts`, we use the bare Playwright `test` import so we control auth state per test. (Sharing storage would let our cookie clears leak into sibling tests.)
- Run a single spec: `npx playwright test tests/auth/twenty-refresh-after-idle.spec.ts --project=chromium` (FOSS_USER and FOSS_PASS must be set in `.env`).

---

## File Structure

- **Create:** `tests/auth/twenty-refresh-after-idle.spec.ts` — single test describing Twenty's expected behavior when only the SSO cookie remains and the page is refreshed.
- **No modifications** to existing files. The new test reuses `cognitoLogin`, `APP_URLS`, `AUTH_COOKIE`, and `isAuthWall` directly from their current modules.

One file, one responsibility (Twenty refresh-after-idle behavior). It belongs under `tests/auth/` rather than `tests/apps/` because the contract under test is SSO session lifecycle, not Twenty link coverage.

---

## Task 1: Add the failing test

**Files:**
- Create: `tests/auth/twenty-refresh-after-idle.spec.ts`

- [ ] **Step 1: Write the test file**

Create `tests/auth/twenty-refresh-after-idle.spec.ts` with the following exact contents:

```typescript
import { test, expect, Browser, BrowserContext, Page } from "@playwright/test";
import { cognitoLogin } from "../../auth-helpers";
import { APP_URLS, AUTH_COOKIE, isAuthWall } from "../../constants";

// This test manages its own auth context — sharing the worker session
// would contaminate other tests when we clear cookies.
async function loginFreshContext(
  browser: Browser
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await cognitoLogin(page);
  return { context, page };
}

test.describe("Twenty — refresh after local-session expiry", () => {
  // Simulates the user-reported bug: leaving Twenty idle ~30 min and
  // refreshing redirects to the login page, even though the SSO
  // `_oauth2_proxy` cookie is still valid. We reproduce the same
  // browser-side state in seconds by clearing every Twenty-origin
  // cookie *except* `_oauth2_proxy`, plus localStorage/sessionStorage,
  // then reloading. With a valid SSO cookie, the oauth2-proxy →
  // forward-auth chain must re-authenticate Twenty seamlessly — the
  // user must NOT land on an auth wall.
  test("valid SSO cookie + cleared Twenty session + reload → stays on Twenty", async ({
    browser,
  }) => {
    test.setTimeout(120_000);
    const { context, page } = await loginFreshContext(browser);

    try {
      // Land on Twenty with a fully populated session.
      await page.goto(APP_URLS.Twenty, {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      expect(
        page.url().startsWith(APP_URLS.Twenty),
        `Pre-condition: must be on Twenty after login, got: ${page.url()}`
      ).toBe(true);

      // Capture and isolate the SSO cookie. Everything else (Twenty's
      // own session cookies, CSRF, locale, etc.) gets dropped to
      // simulate Twenty's local session having expired.
      const allCookies = await context.cookies();
      const ssoCookie = allCookies.find((c) => c.name === AUTH_COOKIE);
      expect(ssoCookie, "SSO cookie must exist after login").toBeDefined();

      await context.clearCookies();
      await context.addCookies([ssoCookie!]);

      // Belt-and-braces: clear Twenty-origin web storage too. Some apps
      // gate auth on a localStorage token, not just a cookie.
      await page.evaluate(() => {
        try {
          window.localStorage.clear();
          window.sessionStorage.clear();
        } catch {
          // Cross-origin frames may throw; safe to ignore.
        }
      });

      // The reload that the user would do after coming back to the tab.
      // `domcontentloaded` matches the convention in
      // session-lifecycle.spec.ts:80 for Twenty (websocket keeps the
      // page from ever reaching networkidle/load).
      await page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });

      expect(
        isAuthWall(page.url()),
        `Refresh must NOT bounce to auth wall when SSO cookie is valid. Landed on: ${page.url()}`
      ).toBe(false);
      expect(
        page.url().startsWith(APP_URLS.Twenty),
        `After refresh, page must remain on the Twenty host. Landed on: ${page.url()}`
      ).toBe(true);
    } finally {
      await context.close();
    }
  });
});
```

- [ ] **Step 2: Run the test and confirm it FAILS (proves the bug)**

Run:

```bash
npx playwright test tests/auth/twenty-refresh-after-idle.spec.ts --project=chromium
```

Expected: 1 failed. The failure should be on one of the two `expect` assertions after `page.reload(...)`. The error message will include the URL the page landed on — it should be on the ForwardAuth host (`auth.foss.<domain>`) or an IDP host (Cognito / mPass), confirming we have caught the bug.

If the test instead **passes** on the very first run, that is a meaningful signal — either the bug is environment-specific (try a different `FOSS_BASE_URL`) or has already been fixed. Stop and report this back rather than committing a green test.

If the test errors before reaching the reload step (e.g. login fails, navigation times out), fix the environment or login credentials before continuing — those failures are not the bug we're catching.

- [ ] **Step 3: Commit**

```bash
git add tests/auth/twenty-refresh-after-idle.spec.ts \
        docs/superpowers/specs/2026-05-09-twenty-refresh-after-idle-design.md \
        docs/superpowers/plans/2026-05-09-twenty-refresh-after-idle.md
git commit -m "test(twenty): regression for refresh-after-idle redirect to login

Reproduces the bug where leaving Twenty idle ~30 min and refreshing
bounces the user to the login page despite a still-valid _oauth2_proxy
SSO cookie. Simulates Twenty's local session expiry by clearing every
non-SSO cookie + Twenty-origin web storage, then reloading and
asserting the page does not land on an auth wall."
```

---

## Verification

After Task 1 the working tree should contain:

- A new file at `tests/auth/twenty-refresh-after-idle.spec.ts`.
- A new design doc at `docs/superpowers/specs/2026-05-09-twenty-refresh-after-idle-design.md`.
- A new plan doc at `docs/superpowers/plans/2026-05-09-twenty-refresh-after-idle.md`.
- One new commit on the current branch with the message above.

Run `npm test -- tests/auth/twenty-refresh-after-idle.spec.ts` once more from a clean shell to confirm the failure is deterministic. Acceptance for this plan = test fails reproducibly against the current deployment with an auth-wall URL in the error message. Once Twenty's auth flow is fixed, the same test must turn green without further edits.
