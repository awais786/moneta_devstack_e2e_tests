import { test, expect } from "../../fixtures";
import { Page } from "@playwright/test";

const COGNITO_DOMAIN = "amazoncognito.com";
const AUTH_COOKIE = "_oauth2_proxy";

const APPS = [
  { name: "Outline (Docs)", url: "https://foss-docs.arbisoft.com" },
  { name: "PM / Onboarding",  url: "https://foss-pm.arbisoft.com" },
  { name: "Penpot (Design)",  url: "https://foss-design.arbisoft.com" },
  { name: "SurfSense (Research)", url: "https://foss-research.arbisoft.com" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isOnCognito(page: Page): Promise<boolean> {
  return page.url().includes(COGNITO_DOMAIN);
}

// ---------------------------------------------------------------------------
// Single session shared across all apps
// ---------------------------------------------------------------------------

test.describe("SSO Session Sharing Across Apps", () => {
  for (const app of APPS) {
    test(`${app.name} — no re-auth required`, async ({ page }) => {
      await page.goto(app.url, { waitUntil: "networkidle", timeout: 30000 });

      // Should NOT be redirected to Cognito
      expect(await isOnCognito(page)).toBe(false);
      expect(page.url()).not.toContain(COGNITO_DOMAIN);
    });

    test(`${app.name} — _oauth2_proxy cookie present`, async ({ context, page }) => {
      await page.goto(app.url, { waitUntil: "networkidle", timeout: 30000 });

      const cookies = await context.cookies(app.url);
      const oauthCookie = cookies.find((c) => c.name === AUTH_COOKIE);
      expect(oauthCookie).toBeDefined();
      expect(oauthCookie!.domain).toMatch(/\.arbisoft\.com/);
    });
  }

  test("switching between all apps requires no re-authentication", async ({ page }) => {
    for (const app of APPS) {
      const appHost = new URL(app.url).hostname;

      await page.goto(app.url, { waitUntil: "networkidle", timeout: 30000 });

      const finalUrl = page.url();
      console.log(`${app.name} → ${finalUrl}`);

      // Must land on the app's own domain, not Cognito or auth proxy
      expect(finalUrl).not.toContain(COGNITO_DOMAIN);
      expect(finalUrl).not.toContain("foss-auth.arbisoft.com");
      expect(new URL(finalUrl).hostname).toBe(appHost);
    }

    // Full round-trip back to first app
    const firstHost = new URL(APPS[0].url).hostname;
    await page.goto(APPS[0].url, { waitUntil: "networkidle", timeout: 30000 });
    expect(new URL(page.url()).hostname).toBe(firstHost);
  });

  test("each app has a valid _oauth2_proxy session cookie", async ({ context, page }) => {
    for (const app of APPS) {
      await page.goto(app.url, { waitUntil: "networkidle", timeout: 30000 });

      // Fetch cookies for the actual landed URL (post-redirect)
      const finalUrl = page.url();
      const cookies = await context.cookies(finalUrl);
      const c = cookies.find((c) => c.name === AUTH_COOKIE);

      console.log(`${app.name} → cookies: ${cookies.map((x) => x.name).join(", ")}`);

      expect(c, `${app.name} missing ${AUTH_COOKIE} cookie`).toBeDefined();
      expect(c!.value).not.toBe("");
      expect(c!.domain).toMatch(/arbisoft\.com/);
    }
  });
});
