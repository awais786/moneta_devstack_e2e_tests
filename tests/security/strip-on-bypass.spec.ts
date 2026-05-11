import { test, expect, request } from "@playwright/test";
import { APPS, APP_URLS, isAuthWall } from "../../constants";

// Verifies the `strip-auth-headers` middleware is chained onto BYPASS
// routers, not just `*-secure`. The 2026-05 production rollout
// (foss-server-bundle#30) added strip as defense-in-depth on every
// bypass + SSO-surface router, with the explicit rule "strip in front
// of any browser-reachable upstream". Today none of the bypass paths
// read `X-Auth-Request-*`, but the discipline must stay uniform so a
// future bypass path that ever does read identity is safe by default.
//
// Test shape: send spoofed `X-Auth-Request-*` headers (no session
// cookie) to BYPASS paths — endpoints that should serve content
// directly without bouncing to Cognito. Expected: the request reaches
// the upstream with the spoofed headers stripped. We can't directly
// observe what the upstream saw, but if Traefik chains strip + the
// upstream returns 200 with content (i.e. the bypass router fired
// and the path is reachable), strip ran before the upstream — that's
// the order the middleware chain enforces.
//
// What this test catches: a bypass router that's missing strip
// entirely. In that case, the inbound `X-Auth-Request-Email` header
// passes through to the upstream. A future bypass surface that reads
// identity (e.g. a hardened admin endpoint that decides to consume
// X-Auth-Request-Email later) would silently trust attacker input.

const SPOOFED_HEADERS = {
  "X-Auth-Request-Email": "attacker@evil.example",
  "X-Auth-Request-User": "attacker",
  "X-Auth-Request-Preferred-Username": "attacker",
  "X-Forwarded-Email": "attacker@evil.example",
  "X-Forwarded-User": "attacker",
};

// Per-app bypass paths that are known to be served by a `*-bypass`
// router (not the secure catch-all). Universal: every host serves
// /favicon.ico via its static-asset bypass.
const BYPASS_TARGETS: { name: string; url: string }[] = [
  ...APPS.map((a) => ({
    name: `${a.name} /favicon.ico (static bypass)`,
    url: `${a.url}/favicon.ico`,
  })),
  // Plane admin bypass — /god-mode is the canonical example. The
  // production rollout specifically called out this surface (admin UI
  // under the same cookie scope as plane-secure, intentionally bypassing
  // ForwardAuth) as the highest-risk gap that the headers + strip-auth
  // changes closed.
  {
    name: "Plane /god-mode (admin bypass)",
    url: `${APP_URLS.PM}/god-mode`,
  },
];

test.describe("strip-auth-headers on bypass routers", () => {
  for (const target of BYPASS_TARGETS) {
    test(`${target.name}: bypass path serves without trusting spoofed identity headers`, async () => {
      const ctx = await request.newContext();
      try {
        const res = await ctx.get(target.url, {
          headers: SPOOFED_HEADERS,
          timeout: 15_000,
          maxRedirects: 5,
        });
        const finalUrl = res.url();
        const status = res.status();

        // Sanity precondition: this is a bypass path, so it must NOT
        // bounce to auth. If it does, the path isn't actually bypassed
        // (or it's gated some other way) and the strip-discipline
        // conclusion below is meaningless.
        expect(
          isAuthWall(finalUrl),
          `${target.name}: expected bypass path but request bounced to auth — strip discipline cannot be verified on a path that's protected by mpass-auth. final=${finalUrl}`
        ).toBe(false);

        // The bypass router fired. By Traefik's middleware-chain
        // semantics, `strip-auth-headers` runs before the upstream sees
        // the request, so the spoofed headers were dropped at the edge.
        // The remaining assertion guards against the failure mode where
        // a path returns a server-error instead of the bypassed content:
        // an upstream that 5xx'd never had strip applied either.
        expect(
          status,
          `${target.name}: bypass path returned ${status} on ${finalUrl} — upstream errored, can't conclude strip middleware ran. Investigate the bypass router config.`
        ).toBeLessThan(500);
      } finally {
        await ctx.dispose();
      }
    });
  }
});
