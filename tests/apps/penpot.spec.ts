import { test, expect } from "../../fixtures";

const BASE = "https://foss-design.arbisoft.com";

test.describe("Penpot (Design) — Multi-App Validation", () => {
  test("dashboard loads and user is authenticated", async ({ page }) => {
    const res = await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

    expect(res?.status()).toBeLessThan(400);
    expect(page.url()).toContain("foss-design.arbisoft.com");
    expect(page.url()).not.toContain("amazoncognito.com");
  });

  test("no sign-in wall on dashboard", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

    // Penpot login page has a specific login form
    const loginForm = page.locator('form[class*="login"], [data-testid="login-form"], input[name="email"]');
    await expect(loginForm.first()).not.toBeVisible();
  });

  test("page title matches Penpot branding", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
    const title = await page.title();
    expect(title).toMatch(/penpot/i);
    expect(title.toLowerCase()).not.toContain("error");
  });

  test("dashboard has navigable content", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log(bodyText);
    expect(bodyText.length).toBeGreaterThan(50);

    // Should not show generic error page
    expect(bodyText.toLowerCase()).not.toMatch(/404|not found|forbidden|access denied/);
  });

  test("new file or projects page accessible", async ({ page }) => {
    // Penpot redirects authenticated users to /dashboard/
    await page.goto(`${BASE}/dashboard/`, { waitUntil: "networkidle", timeout: 30000 });

    expect(page.url()).toContain("foss-design.arbisoft.com");
    expect(page.url()).not.toContain("amazoncognito.com");

    const title = await page.title();
    expect(title.toLowerCase()).not.toContain("404");
  });
});
