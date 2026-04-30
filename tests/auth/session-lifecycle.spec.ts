import { test, expect, Browser, BrowserContext, Page } from "@playwright/test";
import { cognitoLogin } from "../../auth-helpers";
import { APPS, AUTH_COOKIE, MAIN_URL, isAuthWall } from "../../constants";

// These tests manage their own auth contexts — sharing the worker session would
// contaminate other tests when logout destroys the SSO cookie.
async function loginFreshContext(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await cognitoLogin(page);
  return { context, page };
}

async function performLogout(page: Page): Promise<void> {
  await page.goto(MAIN_URL, { waitUntil: "networkidle", timeout: 30000 });

  // Click the logout button/link in the main portal UI
  const logoutLocator = page.locator(
    'a[href*="logout"], a[href*="sign_out"], button:has-text("Logout"), button:has-text("Log out"), button:has-text("Sign out"), a:has-text("Logout"), a:has-text("Log out"), a:has-text("Sign out")'
  ).first();

  await logoutLocator.click({ timeout: 10000 });
  await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
}

// ---------------------------------------------------------------------------

test.describe("Session Lifecycle — Logout", () => {
  test("logout clears the _oauth2_proxy SSO cookie", async ({ browser }) => {
    const { context, page } = await loginFreshContext(browser);

    try {
      const cookieBefore = (await context.cookies()).find((c) => c.name === AUTH_COOKIE);
      expect(cookieBefore, "SSO cookie must exist before logout").toBeDefined();
      expect(cookieBefore!.value).not.toBe("");

      await performLogout(page);

      const allCookies = await context.cookies();
      const cookieAfter = allCookies.find((c) => c.name === AUTH_COOKIE);
      const isCleared = !cookieAfter || cookieAfter.value === "";
      expect(isCleared, "_oauth2_proxy cookie must be absent or empty after logout").toBe(true);
    } finally {
      await context.close();
    }
  });

  test("logout from one app invalidates session across all apps", async ({ browser }) => {
    const { context, page } = await loginFreshContext(browser);

    try {
      await performLogout(page);

      for (const app of APPS) {
        await page.goto(app.url, { waitUntil: "networkidle", timeout: 30000 });
        expect(
          isAuthWall(page.url()),
          `${app.name} must redirect to auth wall after logout, got: ${page.url()}`
        ).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  test("no access to protected routes after logout", async ({ browser }) => {
    const { context, page } = await loginFreshContext(browser);

    const protectedRoutes = [
      "https://foss.arbisoft.com/dashboard",
      "https://foss.arbisoft.com/admin",
      "https://foss-pm.arbisoft.com",
      "https://foss-docs.arbisoft.com",
      "https://foss-design.arbisoft.com",
      "https://foss-research.arbisoft.com",
    ];

    try {
      await performLogout(page);

      for (const url of protectedRoutes) {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
        expect(
          isAuthWall(page.url()),
          `${url} must not be accessible after logout, got: ${page.url()}`
        ).toBe(true);
      }
    } finally {
      await context.close();
    }
  });

  test("session cannot be resumed by replaying the old cookie after logout", async ({ browser }) => {
    const { context: ctx1, page: page1 } = await loginFreshContext(browser);
    let savedCookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];

    try {
      // Capture cookies while authenticated
      savedCookies = await ctx1.cookies();
      expect(savedCookies.find((c) => c.name === AUTH_COOKIE)).toBeDefined();

      await performLogout(page1);
    } finally {
      await ctx1.close();
    }

    // New context: inject the pre-logout cookies and try to access an app
    const ctx2 = await browser.newContext();
    try {
      await ctx2.addCookies(savedCookies);
      const page2 = await ctx2.newPage();

      await page2.goto(APPS[0].url, { waitUntil: "networkidle", timeout: 30000 });

      // If the server-side session is properly invalidated, the old cookie is rejected
      // and we land on an auth wall even with the replayed cookie.
      // NOTE: If foss-auth uses stateless JWT tokens in the cookie this test may fail —
      // that would be a finding worth reporting (logout doesn't truly invalidate JWTs).
      const redirectedToAuthWall = isAuthWall(page2.url());
      console.log(page2.url());
      const loginVisible =
        (await page2.locator('input[type="password"]').count()) > 0 ||
        (await page2.locator('button:has-text("Sign in")').count()) > 0;
      console.log(redirectedToAuthWall);
      console.log(loginVisible);
      expect(
        redirectedToAuthWall || loginVisible,
        `Replayed pre-logout cookie must not grant access. Landed on: ${page2.url()}`
      ).toBe(true);
    } finally {
      await ctx2.close();
    }
  });
});
