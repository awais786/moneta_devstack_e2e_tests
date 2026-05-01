import { test, expect } from "../../fixtures";
import { test as raw } from "@playwright/test";
import {
  APP_URLS,
  AUTH_COOKIE,
  AUTH_PROXY_DOMAIN,
  IDP_HOSTS,
  isAuthWall,
} from "../../constants";

const GODMODE_URL = `${APP_URLS.PM}/god-mode/`;
const CSRF_URL    = `${APP_URLS.PM}/auth/get-csrf-token/`;
const PM_HOST     = new URL(APP_URLS.PM).hostname;

const ADMIN_USER = process.env.PLANE_ADMIN_USER;
const ADMIN_PASS = process.env.PLANE_ADMIN_PASS;

// god-mode is the Plane admin console. It exposes its own admin login that
// is independent of the SSO IDP — admins authenticate against Plane directly.
//
// Two angles are tested:
//   (1) Cold-context: hitting /god-mode/ without any SSO cookie must NOT
//       redirect through oauth2-proxy / ForwardAuth → IDP. This is the strict
//       bypass invariant.
//   (2) SSO-authed (matches a normal browser session): /god-mode/ renders
//       Plane's own email + password form, and an admin can sign in to reach
//       the admin console.

test.describe("Plane (PM) — god-mode bypasses ForwardAuth", () => {
  // --- (1) Strict bypass invariant: cold context, no SSO cookie ---
  raw("cold visit to /god-mode/ does NOT redirect through ForwardAuth/IDP", async ({
    browser,
  }) => {
    const ctx = await browser.newContext(); // no storageState → no SSO cookie
    const page = await ctx.newPage();
    try {
      await page.goto(GODMODE_URL, { waitUntil: "networkidle", timeout: 30000 });

      const landed = page.url();
      expect(
        landed.includes(AUTH_PROXY_DOMAIN),
        `god-mode bounced through ForwardAuth (${AUTH_PROXY_DOMAIN}) — bypass router missing. Landed: ${landed}`
      ).toBe(false);
      expect(
        IDP_HOSTS.some((h) => landed.includes(h)),
        `god-mode bounced to IDP (${IDP_HOSTS.join("/")}) — bypass router missing. Landed: ${landed}`
      ).toBe(false);
      expect(
        isAuthWall(landed),
        `god-mode hit auth wall — bypass not in place. Landed: ${landed}`
      ).toBe(false);
      expect(new URL(landed).hostname).toBe(PM_HOST);
    } finally {
      await ctx.close();
    }
  });

  // --- (2) Authed visit: matches "direct load in your browser" ---
  test("god-mode renders Plane's own admin login form", async ({ page }) => {
    await page.goto(GODMODE_URL, { waitUntil: "networkidle", timeout: 30000 });

    expect(new URL(page.url()).hostname).toBe(PM_HOST);
    expect(page.url()).toContain("/god-mode");

    const emailInput = page
      .locator('input[type="email"], input[name="email"], input[name="username"]')
      .first();
    const passwordInput = page.locator('input[type="password"]').first();

    await expect(
      emailInput,
      "god-mode must expose a direct email input (Plane admin form, not SSO IDP)"
    ).toBeVisible({ timeout: 10000 });
    await expect(
      passwordInput,
      "god-mode must expose a direct password input (Plane admin form, not SSO IDP)"
    ).toBeVisible({ timeout: 10000 });
  });

  test("admin can sign in via god-mode and reach the admin console", async ({ page }) => {
    test.skip(
      !ADMIN_USER || !ADMIN_PASS,
      "Set PLANE_ADMIN_USER and PLANE_ADMIN_PASS in .env to run this test"
    );

    await page.goto(GODMODE_URL, { waitUntil: "networkidle", timeout: 30000 });

    const emailInput = page
      .locator('input[type="email"], input[name="email"], input[name="username"]')
      .first();
    const passwordInput = page.locator('input[type="password"]').first();
    await emailInput.waitFor({ state: "visible", timeout: 10000 });

    await emailInput.fill(ADMIN_USER!);
    await passwordInput.fill(ADMIN_PASS!);

    await page
      .getByRole("button", { name: /sign in|log in|login|submit/i })
      .first()
      .click({ timeout: 10000 });

    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

    const landed = page.url();
    expect(new URL(landed).hostname).toBe(PM_HOST);
    expect(landed, `Admin should remain in /god-mode after login: ${landed}`).toContain("/god-mode");
    expect(isAuthWall(landed), `Admin must not bounce to SSO chain: ${landed}`).toBe(false);

    // No password input visible after a successful sign-in (the form is gone).
    await expect(
      page.locator('input[type="password"]').first(),
      "Admin login form should disappear after successful sign-in"
    ).not.toBeVisible({ timeout: 5000 });
  });

  // --- (3) Negative: wrong creds rejected ---
  test("god-mode rejects an incorrect password", async ({ browser }) => {
    test.skip(!ADMIN_USER, "Set PLANE_ADMIN_USER in .env to run this test");
    test.setTimeout(60_000);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(GODMODE_URL, { waitUntil: "networkidle", timeout: 30000 });

      const emailInput = page
        .locator('input[type="email"], input[name="email"], input[name="username"]')
        .first();
      const passwordInput = page.locator('input[type="password"]').first();
      await emailInput.waitFor({ state: "visible", timeout: 10000 });

      await emailInput.fill(ADMIN_USER!);
      await passwordInput.fill("definitely-not-the-real-password-" + Date.now());

      await page
        .getByRole("button", { name: /sign in|log in|login|submit/i })
        .first()
        .click({ timeout: 10000 });

      // Give the server a chance to respond — but expect we *stay* on the
      // login form, not navigate into the admin console.
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

      // Login form must still be visible — wrong creds rejected
      await expect(
        page.locator('input[type="password"]').first(),
        "Password field must remain visible after wrong-password attempt"
      ).toBeVisible({ timeout: 5000 });
      // Still on /god-mode, not the admin dashboard
      expect(page.url()).toContain("/god-mode");
    } finally {
      await ctx.close();
    }
  });

  // --- (4) /auth/get-csrf-token bypass — needed before the login POST ---
  raw("/auth/get-csrf-token bypasses ForwardAuth (cold context)", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      const res = await page.goto(CSRF_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
      const landed = page.url();

      // Must NOT bounce through SSO chain
      expect(
        isAuthWall(landed),
        `/auth/get-csrf-token bounced to auth wall: ${landed}`
      ).toBe(false);
      expect(new URL(landed).hostname).toBe(PM_HOST);

      // Endpoint should answer (any 2xx — typically returns JSON {csrf_token: ...}).
      expect(res?.status(), "CSRF endpoint should not 4xx/5xx").toBeLessThan(400);
    } finally {
      await ctx.close();
    }
  });

  // --- (5) Independence: admin sign-in does NOT touch the SSO cookie ---
  test("god-mode admin login does not affect the SSO _oauth2_proxy cookie", async ({
    browser,
  }) => {
    test.skip(
      !ADMIN_USER || !ADMIN_PASS,
      "Set PLANE_ADMIN_USER and PLANE_ADMIN_PASS in .env to run this test"
    );

    // Fresh context so we don't pollute the worker session.
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(GODMODE_URL, { waitUntil: "networkidle", timeout: 30000 });

      const cookiesBefore = await ctx.cookies();
      const ssoBefore = cookiesBefore.find((c) => c.name === AUTH_COOKIE);
      // Cold context — there shouldn't be one. Document the assumption.
      expect(ssoBefore, "Fresh context must have no SSO cookie pre-login").toBeUndefined();

      const emailInput = page
        .locator('input[type="email"], input[name="email"], input[name="username"]')
        .first();
      const passwordInput = page.locator('input[type="password"]').first();
      await emailInput.waitFor({ state: "visible", timeout: 10000 });
      await emailInput.fill(ADMIN_USER!);
      await passwordInput.fill(ADMIN_PASS!);
      await page
        .getByRole("button", { name: /sign in|log in|login|submit/i })
        .first()
        .click({ timeout: 10000 });
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});

      // After admin login: still no SSO cookie. god-mode is its own session
      // universe — it doesn't (and must not) issue the platform-wide
      // _oauth2_proxy cookie.
      const cookiesAfter = await ctx.cookies();
      const ssoAfter = cookiesAfter.find((c) => c.name === AUTH_COOKIE);
      expect(
        ssoAfter,
        `god-mode login must not issue the SSO cookie. Found: ${JSON.stringify(ssoAfter)}`
      ).toBeUndefined();
    } finally {
      await ctx.close();
    }
  });
});
