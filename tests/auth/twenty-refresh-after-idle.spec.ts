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
