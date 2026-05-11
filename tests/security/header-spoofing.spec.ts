import { test, expect, request, APIResponse } from "@playwright/test";
import { APPS, isAuthWall } from "../../constants";

// Verifies the `strip-auth-headers@docker` Traefik middleware actually
// strips inbound `X-Auth-Request-*` headers before requests reach the
// backend. Without that middleware (or if it's placed AFTER `mpass-auth`),
// any external client can spoof identity by setting:
//
//   X-Auth-Request-Email: attacker@evil.com
//   X-Auth-Request-User:  attacker
//
// Backends in this stack are configured with `AUTH_TYPE=SSO`, which makes
// them trust these headers as authoritative identity. Strip middleware is
// the only thing standing between an attacker and full account takeover.
//
// Test shape: send the spoofed headers with NO session cookie. Expected:
// indistinguishable from an unauth'd request — bounces to the auth wall
// (Cognito / mPass) or returns 4xx. A 2xx with app content means the
// headers got through.

const SPOOFED_HEADERS = {
  "X-Auth-Request-Email": "attacker@evil.example",
  "X-Auth-Request-User": "attacker",
  // oauth2-proxy also forwards these, so cover the full set the bundle
  // configures backends to trust.
  "X-Auth-Request-Preferred-Username": "attacker",
  "X-Forwarded-Email": "attacker@evil.example",
  "X-Forwarded-User": "attacker",
};

async function fetchFinal(
  ctx: Awaited<ReturnType<typeof request.newContext>>,
  url: string,
  headers: Record<string, string> = {}
): Promise<APIResponse> {
  // Follow redirects so we land where the request actually resolves.
  // Playwright follows by default; cap at 5 to avoid infinite loops.
  return ctx.get(url, { headers, timeout: 20_000, maxRedirects: 5 });
}

test.describe("Header spoofing — strip-auth-headers middleware", () => {
  for (const app of APPS) {
    test(`${app.name}: spoofed X-Auth-Request-* without cookie does not grant access`, async () => {
      const ctx = await request.newContext({
        ignoreHTTPSErrors: false,
        // Fresh context — no SSO cookie.
      });

      try {
        const spoofed = await fetchFinal(ctx, `${app.url}/`, SPOOFED_HEADERS);
        const finalUrl = spoofed.url();
        const status = spoofed.status();

        const bouncedToAuth = isAuthWall(finalUrl);
        const refused = status >= 400;

        expect(
          bouncedToAuth || refused,
          `${app.name}: spoofed-header request without cookie did NOT bounce to auth and did NOT 4xx — likely strip-auth-headers middleware is missing or misordered. final=${finalUrl} status=${status}`
        ).toBe(true);

        // Strong assertion: if it didn't bounce to auth, status must be a
        // hard reject (not a 2xx that leaks user content).
        if (!bouncedToAuth) {
          expect(
            status,
            `${app.name}: spoofed-header request stayed on host with non-error status ${status} — possible identity bypass. final=${finalUrl}`
          ).toBeGreaterThanOrEqual(400);
        }
      } finally {
        await ctx.dispose();
      }
    });
  }
});
