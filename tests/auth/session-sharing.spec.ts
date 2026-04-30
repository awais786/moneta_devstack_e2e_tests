import { test, expect } from "../../fixtures";
import { APPS, AUTH_COOKIE, COGNITO_DOMAIN, AUTH_PROXY_DOMAIN } from "../../constants";

test.describe("SSO Session Sharing", () => {
  // Per-app cookie scope — distinct signal from cross-app's auth-wall checks
  for (const app of APPS) {
    test(`${app.name} — _oauth2_proxy cookie scoped to .arbisoft.com`, async ({ context, page }) => {
      await page.goto(app.url, { waitUntil: "networkidle", timeout: 30000 });

      const cookies = await context.cookies(app.url);
      const oauthCookie = cookies.find((c) => c.name === AUTH_COOKIE);

      expect(oauthCookie, `${app.name} missing ${AUTH_COOKIE}`).toBeDefined();
      expect(oauthCookie!.value).not.toBe("");
      expect(oauthCookie!.domain).toMatch(/\.arbisoft\.com/);
    });
  }

  test("round-trip across all apps requires no re-authentication", async ({ page }) => {
    for (const app of APPS) {
      await page.goto(app.url, { waitUntil: "networkidle", timeout: 30000 });
      const landed = page.url();
      console.log(`${app.name} → ${landed}`);

      expect(landed).not.toContain(COGNITO_DOMAIN);
      expect(landed).not.toContain(AUTH_PROXY_DOMAIN);
      expect(new URL(landed).hostname).toBe(new URL(app.url).hostname);
    }

    // Round-trip back to first app — still authed
    await page.goto(APPS[0].url, { waitUntil: "networkidle", timeout: 30000 });
    expect(new URL(page.url()).hostname).toBe(new URL(APPS[0].url).hostname);
  });
});
