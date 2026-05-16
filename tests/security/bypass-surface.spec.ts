// Spec coverage for this file (see docs/spec-coverage.md):
// @spec proxy-auth-middleware#bypass-paths-shall-short-circuit-before-any-auth-processing
// @spec oauth2-proxy-gateway#gateway-shall-run-as-a-single-dedicated-service
// @spec forwardauth-traefik#bypass-routes-per-app-shall-match-the-documented-list

import { test, expect, request, APIResponse } from "@playwright/test";
import { APPS, isAuthWall } from "../../constants";

// Verifies the bypass-router discipline from RULES.md §1 ("Bypass
// discipline"):
//
//   - Static assets and well-known endpoints (favicon, robots, ACME
//     challenge) MUST be reachable without a session cookie. If they
//     bounce to Cognito, the bypass router is missing — every uncached
//     anonymous request would be billed an IDP round-trip and breaks
//     embedded previews / SEO crawlers.
//   - Routes that return user data (root SPA shell, anything under /api/
//     that isn't an explicit bypass) MUST require auth. The Electric
//     /v1/shape exfiltration (2026-04-30) was the textbook failure mode:
//     a routable path with no `mpass-auth` middleware that returned data.
//
// We don't enumerate every app-specific bypass path (those are in RULES.md
// §2 and shift over time). Instead we test universal expectations that
// should hold for every app behind oauth2-proxy + Traefik ForwardAuth.

async function probe(
  ctx: Awaited<ReturnType<typeof request.newContext>>,
  url: string
): Promise<{ status: number; finalUrl: string }> {
  const res: APIResponse = await ctx.get(url, {
    timeout: 15_000,
    maxRedirects: 5,
  });
  return { status: res.status(), finalUrl: res.url() };
}

test.describe("Bypass surface — public paths reachable, protected paths gated", () => {
  for (const app of APPS) {
    // Public-surface paths: these MUST NOT bounce to the auth wall. They
    // either serve content (2xx) or return 404 (path doesn't exist on
    // this app) — both are acceptable. What's NOT acceptable is a 302
    // to Cognito.
    test(`${app.name}: /favicon.ico is reachable without auth`, async () => {
      const ctx = await request.newContext();
      try {
        const { status, finalUrl } = await probe(ctx, `${app.url}/favicon.ico`);
        expect(
          isAuthWall(finalUrl),
          `${app.name}: /favicon.ico bounced to auth wall — static-asset bypass missing. final=${finalUrl}`
        ).toBe(false);
        // 200 (served) or 404 (no favicon configured) are both fine.
        // Anything else (502/503/etc.) signals a deeper problem.
        expect(
          status === 200 || status === 204 || status === 404,
          `${app.name}: /favicon.ico unexpected status ${status}`
        ).toBe(true);
      } finally {
        await ctx.dispose();
      }
    });

    test(`${app.name}: /robots.txt is reachable without auth`, async () => {
      const ctx = await request.newContext();
      try {
        const { status, finalUrl } = await probe(ctx, `${app.url}/robots.txt`);
        expect(
          isAuthWall(finalUrl),
          `${app.name}: /robots.txt bounced to auth wall — search engines / crawlers will be blocked. final=${finalUrl}`
        ).toBe(false);
        expect(
          status === 200 || status === 404,
          `${app.name}: /robots.txt unexpected status ${status}`
        ).toBe(true);
      } finally {
        await ctx.dispose();
      }
    });

    // Note: /.well-known/acme-challenge/ is intentionally NOT tested here.
    // Traefik 3.x only auto-registers the ACME bypass router when a
    // `certresolver=letsencrypt` is configured. This deployment uses
    // mkcert (RULES.md §1 TLS), so the path correctly falls through to
    // the secure catch-all and bounces to auth. Re-add the test when /
    // if a deployment migrates to Let's Encrypt.

    // Protected surface — root path must bounce to auth. We already cover
    // this in sso-login.spec.ts, but repeating here as the inverse-control
    // anchor for this suite: prove the catch-all router is still doing
    // its job alongside the bypass paths above.
    test(`${app.name}: root / requires auth (catch-all gate is live)`, async () => {
      const ctx = await request.newContext();
      try {
        const { status, finalUrl } = await probe(ctx, `${app.url}/`);
        const bouncedToAuth = isAuthWall(finalUrl);

        expect(
          status,
          `${app.name}: root / returned ${status} on ${finalUrl} (server error, cannot validate auth gate)`
        ).toBeLessThan(500);

        const clearlyGated = bouncedToAuth || status === 401 || status === 403;
        expect(
          clearlyGated,
          `${app.name}: root / is not clearly gated (status=${status}, final=${finalUrl})`
        ).toBe(true);
      } finally {
        await ctx.dispose();
      }
    });
  }
});
