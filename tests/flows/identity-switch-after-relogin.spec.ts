import { test, expect } from "../../fixtures";
import { test as raw, type Page, type BrowserContext } from "@playwright/test";
import { APPS, MAIN_URL, AUTH_COOKIE } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// Scenario (from a real bug report against the deployment):
//
//   1. Log in as User A on the FOSS portal.
//   2. Open every service app in its own tab.
//   3. From the portal tab, click "Log out of all apps" — SSO cookie
//      is cleared.
//   4. Log in again as User B.
//   5. Refresh each app tab.
//
// Expected: all five apps reflect User B's identity.
// Reported: only SurfSense flips correctly; Outline, Penpot, Plane,
//           and Twenty keep showing User A in their cached profile.
//
// The four broken apps cache identity in app-local storage
// (localStorage / sessionStorage / non-shared cookies on their own
// subdomain). When the platform SSO cookie rotates to User B, the
// app middleware sees the new X-Auth-Request-Email header but the
// SPA continues reading from the stale local cache.
//
// This test reproduces the scenario and asserts the *fixed* contract:
// every app's cached identity must match User B after relogin. It is
// marked test.fail() because the bug is known and the test will fail
// today — once the SPAs fix their identity refresh logic, Playwright
// will report "unexpected pass" and someone can remove the marker.

const FOSS_USER = process.env.FOSS_USER;
const FOSS_PASS = process.env.FOSS_PASS;
const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

// Both users' "visible" emails inside the apps follow the synthetic
// <numeric-id>@askii.ai convention (oauth2-proxy maps Cognito IDs into
// emails). The username we send to Cognito IS the numeric prefix.
const expectedEmail = (cognitoUsername: string): string =>
  `${cognitoUsername}@askii.ai`;

// Collect every place an app could surface a user identity: localStorage,
// sessionStorage, JS-visible cookies, HttpOnly cookies (via the Playwright
// context), and the page's visible text. The bug is observable in any of
// these — apps cache the email in localStorage (Penpot, Twenty), in a
// rendered avatar / sidebar header (Outline, Plane), or both. The reader
// returns the full haystack; callers decide what to search for.
async function collectIdentityHaystack(
  page: Page,
  context: BrowserContext,
  appUrl: string
): Promise<string> {
  const fromDom = await page.evaluate(() => {
    const buckets: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) buckets.push(localStorage.getItem(k) ?? "");
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k) buckets.push(sessionStorage.getItem(k) ?? "");
    }
    buckets.push(document.cookie);
    buckets.push(document.body?.innerText ?? "");
    return buckets.join("\n");
  });
  const cookies = await context.cookies(appUrl);
  const cookieBlob = cookies.map((c) => c.value).join("\n");
  let decodedCookies = cookieBlob;
  try {
    decodedCookies = decodeURIComponent(cookieBlob);
  } catch {
    /* leave as-is */
  }
  return [fromDom, decodedCookies].join("\n");
}

raw.describe("Identity switch — relogin as a different user updates every app's cache", () => {
  raw.skip(
    !FOSS_USER || !FOSS_PASS || !NORMAL_USER || !NORMAL_PASS,
    "Set FOSS_USER/FOSS_PASS and NORMAL_USER/NORMAL_PASS in .env"
  );

  raw("after 'Log out of all apps' and relogin, every app reflects the new user", async ({
    browser,
  }) => {
    // Known-broken — see file header. Remove .fail() when the four
    // affected apps refresh their cached identity after SSO rotation.
    raw.fail(
      true,
      "Known issue: Outline, Penpot, Plane, Twenty cache identity in app-local storage and don't re-sync after the SSO cookie rotates to a different user. Only SurfSense flips correctly."
    );
    raw.setTimeout(300_000);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      // Phase 1: Login as User A and visit each app to prime caches.
      // No assertions here — some apps don't surface the email
      // anywhere JS-readable, and that's not the bug we're hunting.
      await cognitoLogin(page, { user: FOSS_USER!, pass: FOSS_PASS! });
      for (const app of APPS) {
        await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
      }
      const userAEmail = expectedEmail(FOSS_USER!);

      // Phase 2: Log out of all apps from the portal. Uses the same
      // locator pattern as flows/login-logout-flow.spec.ts.
      await page.goto(MAIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const LOGOUT_ALL_RE = /log\s*out\s*(of\s*)?all(\s*apps)?|sign\s*out\s*(of\s*)?all(\s*apps)?/i;
      await page
        .getByRole("button", { name: LOGOUT_ALL_RE })
        .or(page.getByRole("link", { name: LOGOUT_ALL_RE }))
        .first()
        .click({ timeout: 10_000 });
      await page.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

      // Sanity: SSO cookie must be cleared so we know the logout
      // actually happened (otherwise the relogin would just be a no-op
      // and the test would be meaningless).
      const ssoAfterLogout = (await ctx.cookies()).find((c) => c.name === AUTH_COOKIE);
      const cleared = !ssoAfterLogout || ssoAfterLogout.value === "";
      expect(cleared, `Logout must clear ${AUTH_COOKIE} cookie before relogin`).toBe(true);

      // Phase 3: Log in as User B.
      await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });
      const userBEmail = expectedEmail(NORMAL_USER!);

      // Phase 4: Refresh each app tab; the bug is that User A's email
      // is still present in client-readable state. We assert two
      // things per app:
      //   • No User A leak — userAEmail must NOT appear anywhere
      //     observable (storage, cookies, rendered text). If it does,
      //     the SPA is reading stale identity.
      //   • Positive signal where available — if an app surfaces an
      //     askii.ai email at all, it should be User B's. Apps that
      //     don't surface any email (e.g. Plane) are tolerated.
      const failures: { app: string; reason: string }[] = [];
      for (const app of APPS) {
        await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        const haystack = await collectIdentityHaystack(page, ctx, app.url);

        if (haystack.includes(userAEmail)) {
          failures.push({
            app: app.name,
            reason: `User A's email (${userAEmail}) is still cached after relogin as User B`,
          });
          continue;
        }
        // If any askii.ai email is surfaced, it must be User B's.
        const surfaced = haystack.match(/(\d{10,})@askii\.ai/g) ?? [];
        const nonUserB = surfaced.filter((e) => e !== userBEmail);
        if (nonUserB.length > 0) {
          failures.push({
            app: app.name,
            reason: `Unexpected non-User-B email surfaced: ${[...new Set(nonUserB)].join(", ")} (expected ${userBEmail} or no email at all)`,
          });
        }
      }

      expect(
        failures,
        `Apps leaking stale identity after relogin as User B (expected ${userBEmail}):\n${JSON.stringify(failures, null, 2)}`
      ).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});
