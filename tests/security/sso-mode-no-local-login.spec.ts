import { test, expect } from "@playwright/test";
import { APPS, isAuthWall, AppName } from "../../constants";

// Verifies the `AUTH_TYPE=SSO` header-trust gate hides local
// login/register/forgot-password UI on every app. RULES.md §1 ("AUTH_TYPE
// gate"): "The SPA must also hide local login/register/forgot-password UI
// when SSO is set."
//
// If local login UI is reachable in SSO mode, two regressions are
// possible:
//
//   1. A user who somehow lands on the local form may set a local
//      password that diverges from their Cognito identity — silently
//      forking the account.
//   2. The local password form is a credential-harvesting surface for
//      anyone who manages to inject a link to it (phishing). The whole
//      point of SSO mode is to remove it.
//
// Test shape: for each app, navigate to known local-auth routes. Expect:
// either a redirect to the IDP (no local form ever rendered) OR the
// resulting page has no reachable `<input type="password">`.

// Per-app local-auth routes that exist in the upstream codebase. Apps in
// SSO mode either redirect these to the IDP or render a stub page with
// no password input.
const LOCAL_AUTH_ROUTES: Record<AppName, string[]> = {
  PM: ["/sign-in", "/auth", "/accounts/sign-in"],
  Outline: ["/auth/email", "/login"],
  Penpot: ["/#/auth/login", "/#/auth/register", "/#/auth/recovery-request"],
  SurfSense: ["/login", "/auth/login"],
  Twenty: ["/sign-in", "/welcome"],
};

test.describe("AUTH_TYPE=SSO gate — local login/register UI must be hidden", () => {
  for (const app of APPS) {
    for (const route of LOCAL_AUTH_ROUTES[app.name]) {
      test(`${app.name} ${route}: no reachable password input`, async ({ page }) => {
        // Fresh context (no SSO cookie). If the app still bounces us to
        // the IDP, the SSO gate is doing its job at the routing layer.
        // If we stay on the app, the SPA must not render a password
        // form — the gate must be enforced at the UI layer too.
        const res = await page
          .goto(`${app.url}${route}`, { waitUntil: "domcontentloaded", timeout: 30_000 })
          .catch(() => null);

        const landedUrl = page.url();

        // If we bounced to the IDP, the route is gated at routing — pass.
        if (isAuthWall(landedUrl)) return;

        // Stayed on the app host (or somewhere else FOSS). Status >= 400
        // is also fine — the route is gone / unreachable.
        if (res && res.status() >= 400) return;

        // Give SPAs ~1s to hydrate; if a password form was going to
        // render, it does so within hydration.
        await page.waitForTimeout(1500);

        const passwordInputs = await page
          .locator('input[type="password"]')
          .count();

        expect(
          passwordInputs,
          `${app.name} ${route}: rendered ${passwordInputs} password input(s) at ${landedUrl} — SSO mode must hide local login UI (RULES.md §1 "AUTH_TYPE gate"). Either the route should redirect to the IDP or the SPA should not render the password form when SSO is enabled.`
        ).toBe(0);
      });
    }
  }
});
