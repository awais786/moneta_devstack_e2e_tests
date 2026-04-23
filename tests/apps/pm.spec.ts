import { test, expect } from "../../fixtures";

const BASE = "https://foss-pm.arbisoft.com";

test.describe("PM / Onboarding — Multi-App Validation", () => {
  test("home page loads and user is authenticated", async ({ page }) => {
    const res = await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

    expect(res?.status()).toBeLessThan(400);
    expect(page.url()).toContain("foss-pm.arbisoft.com");
    expect(page.url()).not.toContain("amazoncognito.com");
  });

  test("no login wall on home page", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

    const loginSelectors = [
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
      'a:has-text("Login")',
      'input[type="password"]',
    ];

    for (const sel of loginSelectors) {
      await expect(page.locator(sel).first()).not.toBeVisible();
    }
  });

  test("page title is set and meaningful", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
    expect(title.toLowerCase()).not.toContain("error");
    expect(title.toLowerCase()).not.toContain("404");
  });

  test("onboarding content is visible", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

    const bodyText = await page.evaluate(() => document.body.innerText);
    expect(bodyText.length).toBeGreaterThan(50);
    expect(bodyText.toLowerCase()).not.toMatch(/404|not found|forbidden|access denied/);
  });
});
