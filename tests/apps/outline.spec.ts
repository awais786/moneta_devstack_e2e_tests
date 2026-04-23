import { test, expect } from "../../fixtures";

const BASE = "https://foss-docs.arbisoft.com";

const PAGES = [
  { name: "Home",    path: "/home" },
  { name: "Popular", path: "/home/popular" },
  { name: "Recent",  path: "/home/recent" },
  { name: "Created", path: "/home/created" },
];

const AUTH_INDICATORS = [
  '[data-testid="sidebar-account"]',
  'button[aria-label*="account" i]',
  'img[alt*="avatar" i]',
  '.account',
  '[class*="Avatar"]',
  '[class*="avatar"]',
];

const UNAUTH_INDICATORS = [
  'a[href*="login"]',
  'button:has-text("Sign in")',
  'button:has-text("Log in")',
];

test.describe("Outline (Docs) — Multi-App Validation", () => {
  test("home page loads and user is authenticated", async ({ page }) => {
    const res = await page.goto(`${BASE}/home`, { waitUntil: "networkidle", timeout: 30000 });

    expect(res?.status()).toBeLessThan(400);
    expect(page.url()).toContain("foss-docs.arbisoft.com");

    // No unauthenticated indicators
    for (const sel of UNAUTH_INDICATORS) {
      await expect(page.locator(sel).first()).not.toBeVisible();
    }

    // At least one auth indicator present
    let authed = false;
    for (const sel of AUTH_INDICATORS) {
      if (await page.locator(sel).first().isVisible()) {
        authed = true;
        break;
      }
    }
    if (!authed) {
      // Fallback: page has actual content (not a login wall)
      const bodyText = await page.evaluate(() => document.body.innerText);
      expect(bodyText.length).toBeGreaterThan(100);
    }
  });

  for (const { name, path } of PAGES) {
    test(`${name} page — navigates and loads content`, async ({ page }) => {
      await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30000 });

      expect(page.url()).toContain(path);
      expect(page.url()).not.toContain("amazoncognito.com");

      await expect(page.locator("body")).not.toBeEmpty();

      // Page title should be meaningful
      const title = await page.title();
      expect(title.length).toBeGreaterThan(0);
      expect(title.toLowerCase()).not.toContain("error");
      expect(title.toLowerCase()).not.toContain("404");
    });
  }

  test("navigation between pages stays authenticated", async ({ page }) => {
    for (const { path } of PAGES) {
      await page.goto(`${BASE}${path}`, { waitUntil: "networkidle", timeout: 30000 });
      expect(page.url()).toContain("foss-docs.arbisoft.com");
      expect(page.url()).not.toContain("amazoncognito.com");
    }
  });

  test("page titles are consistent with Outline branding", async ({ page }) => {
    await page.goto(`${BASE}/home`, { waitUntil: "networkidle", timeout: 30000 });
    const title = await page.title();
    // Outline sets titles like "Home - Outline"
    expect(title).toMatch(/outline/i);
  });
});
