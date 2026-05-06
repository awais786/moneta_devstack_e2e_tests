import { test, expect } from "../../fixtures";
import {
  APPS,
  AUTH_COOKIE,
  COGNITO_DOMAIN,
  AUTH_PROXY_DOMAIN,
  COOKIE_DOMAIN,
  COOKIE_DOMAIN_REGEX,
} from "../../constants";

// Reasonable session-cookie expiry window. Lower bound: a freshly-issued
// cookie should have at least 5 minutes left (otherwise the session will
// expire mid-test). Upper bound: anything > 30 days is a misconfiguration —
// SSO cookies are not "remember me" persistent identity tokens.
const MIN_REMAINING_SECONDS = 5 * 60;
const MAX_REMAINING_SECONDS = 30 * 24 * 60 * 60;

// Cookies that actually carry identity / session bearer state. Other
// persistent cookies (CSRF tokens, locale, "last signed in" UX hints) are
// conventionally long-lived and are not part of the SSO TTL contract.
const AUTH_COOKIE_PATTERNS: RegExp[] = [
  /^_oauth2_proxy/i,
  /session(id|_id|-id)?$/i,
  /^access[_-]?token$/i,
  /^auth[_-]?token$/i,
  /^id[_-]?token$/i,
  /^refresh[_-]?token$/i,
  /^jwt$/i,
  /^JSESSIONID$/,
  /^PHPSESSID$/,
];

function isAuthCookie(name: string): boolean {
  return AUTH_COOKIE_PATTERNS.some((p) => p.test(name));
}

test.describe("SSO Session Sharing", () => {
  test("_oauth2_proxy cookie is shared across all FOSS subdomains", async ({ context, page }) => {
    // Warm one app so the cookie is in the jar, then assert one cookie covers
    // every app's host (it's scoped to .${COOKIE_DOMAIN} — same cookie everywhere).
    await page.goto(APPS[0].url, { waitUntil: "networkidle", timeout: 30000 });

    for (const app of APPS) {
      const cookies = await context.cookies(app.url);
      const c = cookies.find((c) => c.name === AUTH_COOKIE);
      expect(c, `${app.name} missing ${AUTH_COOKIE}`).toBeDefined();
      expect(c!.value, `${app.name} has empty cookie`).not.toBe("");
      expect(
        c!.domain,
        `${app.name} cookie not on .${COOKIE_DOMAIN}`
      ).toMatch(COOKIE_DOMAIN_REGEX);
    }
  });

  test("_oauth2_proxy cookie has a valid future expiry within session bounds", async ({
    context,
    page,
  }) => {
    await page.goto(APPS[0].url, { waitUntil: "networkidle", timeout: 30000 });
    const cookies = await context.cookies(APPS[0].url);
    const c = cookies.find((c) => c.name === AUTH_COOKIE);
    expect(c).toBeDefined();

    // Playwright returns expires=-1 for browser-session cookies (cleared on
    // browser close). The SSO cookie must be persistent across browser
    // restarts within its TTL — anything else breaks tab-restore + multi-day
    // device usage.
    expect(c!.expires, "SSO cookie must not be a browser-session cookie").toBeGreaterThan(0);

    const nowSec = Math.floor(Date.now() / 1000);
    const remaining = c!.expires - nowSec;
    expect(
      remaining,
      `SSO cookie already expired (expires=${c!.expires}, now=${nowSec})`
    ).toBeGreaterThan(0);
    expect(
      remaining,
      `SSO cookie expires in <${MIN_REMAINING_SECONDS}s (${remaining}s) — TTL too short or skewed`
    ).toBeGreaterThan(MIN_REMAINING_SECONDS);
    expect(
      remaining,
      `SSO cookie expires in >${MAX_REMAINING_SECONDS}s (${remaining}s, ${(remaining / 86400).toFixed(1)} days) — likely misconfigured TTL`
    ).toBeLessThan(MAX_REMAINING_SECONDS);
  });

  test("auth/session cookies on every app have valid future expiry within session bounds", async ({
    context,
    page,
  }) => {
    test.setTimeout(180_000);
    const nowSec = Math.floor(Date.now() / 1000);
    const failures: string[] = [];

    for (const app of APPS) {
      // `domcontentloaded` — Twenty keeps a websocket (no networkidle) AND
      // does a client-side redirect after first paint (aborts `load`).
      // DCL fires the moment HTML is parsed: cookies are already in the
      // jar at that point, and we're past any post-DCL navigation.
      await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      const cookies = await context.cookies(app.url);

      for (const c of cookies) {
        if (!isAuthCookie(c.name)) continue;
        // expires=-1 → browser-session cookie. CSRF and similar throwaway
        // cookies use this; pattern filter already excludes them, but be
        // safe.
        if (c.expires <= 0) continue;

        if (c.expires <= nowSec) {
          failures.push(
            `${app.name}: auth cookie ${c.name} (domain=${c.domain}) is already expired (expires=${c.expires})`
          );
          continue;
        }
        const remaining = c.expires - nowSec;
        if (remaining > MAX_REMAINING_SECONDS) {
          failures.push(
            `${app.name}: auth cookie ${c.name} (domain=${c.domain}) expires in ${(remaining / 86400).toFixed(1)} days — > ${MAX_REMAINING_SECONDS / 86400} day SSO TTL limit`
          );
        }
      }
    }

    expect(failures, `Auth cookie expiry violations:\n${failures.join("\n")}`).toEqual([]);
  });

  test("round-trip across all apps requires no re-authentication", async ({ page }) => {
    test.setTimeout(180_000);
    for (const app of APPS) {
      // `domcontentloaded` — see note in the cookie-expiry test above.
      await page.goto(app.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      const landed = page.url();
      console.log(`${app.name} → ${landed}`);

      expect(landed).not.toContain(COGNITO_DOMAIN);
      expect(landed).not.toContain(AUTH_PROXY_DOMAIN);
      expect(new URL(landed).hostname).toBe(new URL(app.url).hostname);
    }

    // Round-trip back to first app — still authed
    await page.goto(APPS[0].url, { waitUntil: "domcontentloaded", timeout: 60000 });
    expect(new URL(page.url()).hostname).toBe(new URL(APPS[0].url).hostname);
  });
});
