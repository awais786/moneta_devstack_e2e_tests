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
// every app's cached identity must match User B after relogin. The
// test will fail today (Outline and Penpot leak User A's email after
// relogin) — we want it on the team's daily CI radar until the SPA
// identity-refresh fix lands. When the bug is fixed, the test goes
// green naturally.

const FOSS_USER = process.env.FOSS_USER;
const FOSS_PASS = process.env.FOSS_PASS;
const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

// Both users' "visible" emails inside the apps follow the synthetic
// <numeric-id>@askii.ai convention (oauth2-proxy maps Cognito IDs into
// emails). The username we send to Cognito IS the numeric prefix.
const expectedEmail = (cognitoUsername: string): string =>
  `${cognitoUsername}@askii.ai`;

// Per-app URL that *reliably* surfaces the current user's email in
// rendered HTML. The app root pages (e.g. Twenty's /objects/companies,
// Plane's /aa/) often only render a user avatar / initials and don't
// include the email anywhere observable. The profile / account-settings
// pages are where the email is consistently rendered. Without visiting
// them, the test would only catch leaks on Outline + Penpot (which do
// surface the email on their root pages); Plane and Twenty would
// silently slip through.
const APP_IDENTITY_URLS: Record<string, string> = {
  Outline: "/settings/profile",
  PM: "/settings/profile/general",
  Penpot: "/#/settings/profile",
  // SurfSense surfaces the logged-in email in the Manage Members
  // dialog (verified) — the dashboard root suffices because the
  // sidebar avatar tooltip also renders the email.
  SurfSense: "",
  Twenty: "/settings/profile",
};

// Collect every place an app could surface a user identity. The bug
// is observable in any of these — apps cache the email in:
//   • localStorage / sessionStorage (Penpot, Twenty)
//   • a rendered avatar / sidebar header (Outline)
//   • icon tooltips, title attributes, or aria-labels (Plane's user
//     avatar — rendered text isn't enough; full outerHTML is needed)
//   • base64-encoded JWTs inside larger JSON blobs (Twenty stores its
//     tokenPair this way; the email lives in the JWT payload)
// Returns the full concatenated haystack with all reasonable decodings
// applied; callers regex it for the email pattern.
async function collectIdentityHaystack(
  page: Page,
  context: BrowserContext,
  appUrl: string
): Promise<string> {
  const fromDom = await page.evaluate(() => {
    // Walk localStorage/sessionStorage and *also* try to base64-decode
    // any JWT-shaped substrings (3 dot-separated b64url segments) we
    // find in the values — Twenty buries the user email inside the
    // JWT payload, not in plain text.
    const tryDecodeJwts = (s: string): string[] => {
      const out: string[] = [];
      const matches = s.match(/eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? [];
      for (const jwt of matches) {
        const parts = jwt.split(".");
        try {
          // Decode the payload (middle part) as base64url.
          const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
          out.push(atob(b64 + "==".slice(0, (4 - (b64.length % 4)) % 4)));
        } catch {
          /* skip non-decodable */
        }
      }
      return out;
    };

    const buckets: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k) {
        const v = localStorage.getItem(k) ?? "";
        buckets.push(v);
        buckets.push(...tryDecodeJwts(v));
      }
    }
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k) {
        const v = sessionStorage.getItem(k) ?? "";
        buckets.push(v);
        buckets.push(...tryDecodeJwts(v));
      }
    }
    buckets.push(document.cookie);
    // Full HTML — innerText misses attribute values (title, aria-label,
    // data-* attrs) where Plane stashes the email in avatar tooltips.
    buckets.push(document.documentElement?.outerHTML ?? "");
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
    raw.setTimeout(300_000);

    const ctx = await browser.newContext();
    const loginPage = await ctx.newPage();
    // One page per app — match the bug report's flow ("open all apps in
    // separate tabs"). Each app's tab keeps its primed state across
    // Phase 2 (logout) and Phase 3 (relogin); the bug only manifests
    // when the *same* tab is refreshed post-relogin.
    const appPages = new Map<string, Page>();
    try {
      // Phase 1: Login as User A on the portal, then open every app
      // in its own page to prime each app's local cache.
      await cognitoLogin(loginPage, { user: FOSS_USER!, pass: FOSS_PASS! });
      for (const app of APPS) {
        const p = await ctx.newPage();
        await p.goto(app.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await p.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
        appPages.set(app.name, p);
      }
      const userAEmail = expectedEmail(FOSS_USER!);

      // Phase 2: Log out of all apps from the portal tab.
      await loginPage.goto(MAIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
      const LOGOUT_ALL_RE = /log\s*out\s*(of\s*)?all(\s*apps)?|sign\s*out\s*(of\s*)?all(\s*apps)?/i;
      await loginPage
        .getByRole("button", { name: LOGOUT_ALL_RE })
        .or(loginPage.getByRole("link", { name: LOGOUT_ALL_RE }))
        .first()
        .click({ timeout: 10_000 });
      await loginPage.waitForLoadState("networkidle", { timeout: 30_000 }).catch(() => {});

      // Sanity: SSO cookie must be cleared so we know the logout
      // actually happened.
      const ssoAfterLogout = (await ctx.cookies()).find((c) => c.name === AUTH_COOKIE);
      const cleared = !ssoAfterLogout || ssoAfterLogout.value === "";
      expect(cleared, `Logout must clear ${AUTH_COOKIE} cookie before relogin`).toBe(true);

      // Phase 3: Log in as User B in the portal tab.
      await cognitoLogin(loginPage, { user: NORMAL_USER!, pass: NORMAL_PASS! });
      const userBEmail = expectedEmail(NORMAL_USER!);

      // Phase 4: For each app's pre-existing tab, navigate to its
      // identity-revealing URL (the profile / account-settings page,
      // or the root if that's where the email surfaces). This matches
      // the user-reported flow ("refresh the tab") plus the practical
      // need to land on a page that actually renders the email — root
      // pages on Plane and Twenty hide the email behind an avatar.
      //
      // Bug: User A's email is still present in client-readable state.
      // We assert two things per app:
      //   • No User A leak — userAEmail must NOT appear anywhere
      //     observable (storage, cookies, rendered text/HTML, decoded
      //     JWTs). If it does, the SPA is reading stale identity.
      //   • Positive signal where available — if an app surfaces an
      //     askii.ai email at all, it should be User B's. Apps that
      //     don't surface any email are tolerated.
      const failures: { app: string; reason: string }[] = [];
      for (const app of APPS) {
        const p = appPages.get(app.name)!;
        const identityUrl = app.url + (APP_IDENTITY_URLS[app.name] ?? "");
        await p.goto(identityUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await p.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        // Tiny extra settle window for SPAs that hydrate the user
        // avatar / sidebar header asynchronously after the route
        // resolves. Twenty especially does its currentUser query late.
        await p.waitForTimeout(2000);
        const haystack = await collectIdentityHaystack(p, ctx, app.url);

        if (haystack.includes(userAEmail)) {
          failures.push({
            app: app.name,
            reason: `User A's email (${userAEmail}) is still cached at ${identityUrl} after relogin as User B`,
          });
          continue;
        }
        const surfaced = haystack.match(/(\d{10,})@askii\.ai/g) ?? [];
        const nonUserB = surfaced.filter((e) => e !== userBEmail);
        if (nonUserB.length > 0) {
          failures.push({
            app: app.name,
            reason: `Unexpected non-User-B email surfaced at ${identityUrl}: ${[...new Set(nonUserB)].join(", ")} (expected ${userBEmail} or no email at all)`,
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
