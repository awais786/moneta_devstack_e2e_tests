import { test, expect } from "../../fixtures";

const APPS = [
  { name: "Outline",   url: "https://foss-docs.arbisoft.com" },
  { name: "PM",        url: "https://foss-pm.arbisoft.com" },
  { name: "Penpot",    url: "https://foss-design.arbisoft.com" },
  { name: "SurfSense", url: "https://foss-research.arbisoft.com" },
];

test.describe("Cross-App Consistency", () => {
  test("all apps return HTTP 2xx", async ({ page }) => {
    for (const app of APPS) {
      const res = await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      expect(res?.status(), `${app.name} returned non-2xx`).toBeLessThan(400);
    }
  });

  test("all apps have non-empty page titles", async ({ page }) => {
    for (const app of APPS) {
      await page.goto(app.url, { waitUntil: "networkidle", timeout: 30000 });
      const title = await page.title();
      expect(title, `${app.name} has empty title`).not.toBe("");
      expect(title.toLowerCase(), `${app.name} title contains error`).not.toContain("error");
      expect(title, `${app.name} title contains 404`).not.toContain("404");
    }
  });

  test("all apps stay on their own domain after load", async ({ page }) => {
    for (const app of APPS) {
      const expectedHost = new URL(app.url).hostname;
      await page.goto(app.url, { waitUntil: "networkidle", timeout: 30000 });
      const actualHost = new URL(page.url()).hostname;
      expect(actualHost, `${app.name} redirected away`).toBe(expectedHost);
    }
  });

  test("no app shows a login wall when authenticated", async ({ page }) => {
    const loginSelectors = [
      'input[type="password"]',
      'button:has-text("Sign in")',
      'button:has-text("Log in")',
    ];

    for (const app of APPS) {
      await page.goto(app.url, { waitUntil: "networkidle", timeout: 30000 });
      for (const sel of loginSelectors) {
        await expect(
          page.locator(sel).first(),
          `${app.name} shows login wall: ${sel}`
        ).not.toBeVisible();
      }
    }
  });
});
