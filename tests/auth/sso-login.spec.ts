import { test, expect } from "../../fixtures";
import { BrowserContext, Page } from "@playwright/test";
import { MAIN_URL, COGNITO_DOMAIN, AUTH_COOKIE } from "../../constants";

const SESSION_LS_KEY = "foss_cognito_alive_ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getOauthCookie(context: BrowserContext) {
  const cookies = await context.cookies("https://foss.arbisoft.com");
  return cookies.find((c) => c.name === AUTH_COOKIE);
}

async function isOnCognito(page: Page): Promise<boolean> {
  return page.url().includes(COGNITO_DOMAIN);
}

// ---------------------------------------------------------------------------
// Tests — storageState already injected via playwright.config.ts
// ---------------------------------------------------------------------------

test.describe("SSO Login Flow", () => {
  test("authenticated session lands on FOSS platform, not Cognito", async ({ page }) => {
    await page.goto(MAIN_URL);
    await page.waitForLoadState("networkidle");

    expect(await isOnCognito(page)).toBe(false);
    expect(page.url()).toContain("arbisoft.com");
  });

  test("_oauth2_proxy cookie present on .arbisoft.com after login", async ({ context }) => {
    const cookie = await getOauthCookie(context);
    expect(cookie).toBeDefined();
    expect(cookie!.domain).toMatch(/\.arbisoft\.com/);
    expect(cookie!.secure).toBe(true);
    expect(cookie!.httpOnly).toBe(true);
  });

  test("_oauth2_proxy cookie has SameSite=Lax (allows cross-subdomain sharing)", async ({
    context,
  }) => {
    const cookie = await getOauthCookie(context);
    expect(cookie).toBeDefined();
    expect(cookie!.sameSite).toBe("Lax");
  });

  test("session localStorage key set after login", async ({ page }) => {
    await page.goto(MAIN_URL);
    await page.waitForLoadState("networkidle");

    const val = await page.evaluate(
      (key) => localStorage.getItem(key),
      SESSION_LS_KEY
    );
    expect(val).not.toBeNull();

    const ts = parseInt(val!, 10);
    expect(ts).toBeGreaterThan(0);
    // timestamp should be recent (within last 24h)
    expect(Date.now() - ts).toBeLessThan(24 * 60 * 60 * 1000);
  });

});

// ---------------------------------------------------------------------------
// Session persistence across navigation
// ---------------------------------------------------------------------------

test.describe("Session Persistence", () => {
  test("cookie persists across multiple page navigations", async ({ page, context }) => {
    const cookieBefore = await getOauthCookie(context);
    expect(cookieBefore).toBeDefined();

    await page.goto(MAIN_URL);
    await page.waitForLoadState("networkidle");
    await page.reload();
    await page.waitForLoadState("networkidle");

    const cookieAfter = await getOauthCookie(context);
    expect(cookieAfter).toBeDefined();
    expect(cookieAfter!.value).toBe(cookieBefore!.value);
  });

  test("no re-authentication when revisiting base URL", async ({ page }) => {
    await page.goto(MAIN_URL);
    await page.waitForLoadState("networkidle");
    const url1 = page.url();

    await page.goto(MAIN_URL);
    await page.waitForLoadState("networkidle");

    expect(await isOnCognito(page)).toBe(false);
    expect(page.url()).toBe(url1);
  });
});
