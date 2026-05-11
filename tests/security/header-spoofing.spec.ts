import { test, expect } from "../../fixtures";
import { request, BrowserContext } from "@playwright/test";
import { APPS, APP_URLS, isAuthWall } from "../../constants";

// Two tests, addressing two distinct failure modes:
//
//   (A) "auth-gate present"  — unauthenticated request with spoofed
//       `X-Auth-Request-*` headers must NOT be granted access. This
//       proves `mpass-auth` is in front of `/`, but does NOT exercise
//       the strip middleware (the request is rejected before any
//       backend sees it). Kept as a sanity guard against a regression
//       where mpass-auth is accidentally removed from a router.
//
//   (B) "strip-auth-headers is wired" — authenticated request with a
//       spoofed `X-Auth-Request-Email` for a DIFFERENT user must
//       return the legitimate (cookie-derived) user's identity, not
//       the attacker's. This is the actual strip-middleware test: the
//       request reaches the backend (so the chain runs end-to-end),
//       and the assertion observes whether the attacker's header
//       value was scrubbed before reaching it.
//
// RULES.md §1 "SSO chain" requires `strip-auth-headers, mpass-auth`
// in that order. Without strip — or with strip placed AFTER mpass-auth
// — a forged `X-Auth-Request-Email` reaches the backend alongside the
// legitimate one added by mpass-auth. HTTP duplicate-header semantics
// vary by server: the backend might trust either value. Either way,
// the attacker can flip identity for any logged-in session by adding
// the header to their own requests.

const SPOOFED_HEADERS = {
  "X-Auth-Request-Email": "attacker@evil.example",
  "X-Auth-Request-User": "attacker",
  "X-Auth-Request-Preferred-Username": "attacker",
  "X-Forwarded-Email": "attacker@evil.example",
  "X-Forwarded-User": "attacker",
};

async function cookieHeaderFor(ctx: BrowserContext, baseUrl: string): Promise<string> {
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// Authed identity probes per backend. Same shape as
// `tests/auth/identity-consistency.spec.ts` — kept inline rather than
// shared because the two tests assert different things (consistency
// vs. resistance to spoofing) and decoupling lets each evolve.
type IdentityProbe = (
  ctx: BrowserContext,
  extraHeaders: Record<string, string>
) => Promise<string>;

const IDENTITY_PROBES: Record<string, IdentityProbe> = {
  PM: async (ctx, extra) => {
    const cookie = await cookieHeaderFor(ctx, APP_URLS.PM);
    const c = await request.newContext({ extraHTTPHeaders: { cookie, ...extra } });
    try {
      const r = await c.get(`${APP_URLS.PM}/api/users/me/`);
      const j = (await r.json()) as { email: string };
      return j.email;
    } finally {
      await c.dispose();
    }
  },
  Outline: async (ctx, extra) => {
    const cookie = await cookieHeaderFor(ctx, APP_URLS.Outline);
    const c = await request.newContext({
      extraHTTPHeaders: { cookie, "content-type": "application/json", ...extra },
    });
    try {
      const r = await c.post(`${APP_URLS.Outline}/api/auth.info`, { data: {} });
      const j = (await r.json()) as { data: { user: { email: string } } };
      return j.data.user.email;
    } finally {
      await c.dispose();
    }
  },
  SurfSense: async (ctx, extra) => {
    const cookie = await cookieHeaderFor(ctx, APP_URLS.SurfSense);
    const c = await request.newContext({ extraHTTPHeaders: { cookie, ...extra } });
    try {
      const r = await c.get(`${APP_URLS.SurfSense}/users/me`);
      const j = (await r.json()) as { email: string };
      return j.email;
    } finally {
      await c.dispose();
    }
  },
};

test.describe("Header spoofing", () => {
  // (A) — auth gate sanity. Cheap and runs without login. Catches a
  // missing mpass-auth on the secure router.
  test.describe("auth gate (unauth'd)", () => {
    for (const app of APPS) {
      test(`${app.name}: spoofed X-Auth-Request-* without cookie does not grant access`, async () => {
        const ctx = await request.newContext();
        try {
          const r = await ctx.get(`${app.url}/`, {
            headers: SPOOFED_HEADERS,
            timeout: 20_000,
            maxRedirects: 5,
          });
          const finalUrl = r.url();
          const status = r.status();
          const ok = isAuthWall(finalUrl) || status >= 400;
          expect(
            ok,
            `${app.name}: unauth'd request reached ${finalUrl} with status ${status} — mpass-auth is not in front of / on this router.`
          ).toBe(true);
        } finally {
          await ctx.dispose();
        }
      });
    }
  });

  // (B) — strip middleware validation. Sends a spoofed
  // X-Auth-Request-Email for a DIFFERENT user, with the legitimate
  // session cookie attached. If strip is in place, the backend sees
  // only mpass-auth's added header (the real user); if strip is
  // missing or misordered, the backend sees the attacker's value too
  // and at least one identity probe returns it.
  test.describe("strip middleware (authed)", () => {
    for (const appName of Object.keys(IDENTITY_PROBES) as Array<keyof typeof IDENTITY_PROBES>) {
      test(`${appName}: spoofed X-Auth-Request-Email is stripped before backend sees it`, async ({
        context,
        page,
      }) => {
        // Warm the host so per-app cookies (Outline/SurfSense session
        // cookies, Plane Django session, Penpot opaque session) land
        // in the jar before the probe.
        const baseUrl = APP_URLS[appName as keyof typeof APP_URLS];
        await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });

        const legitimate = await IDENTITY_PROBES[appName](context, {});
        expect(
          legitimate,
          `${appName}: baseline /me probe must return an email`
        ).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);

        const observed = await IDENTITY_PROBES[appName](context, SPOOFED_HEADERS);

        expect(
          observed,
          `${appName}: backend returned the SPOOFED email when a forged X-Auth-Request-Email header was sent alongside a valid cookie. strip-auth-headers is missing or runs after mpass-auth. attacker=${SPOOFED_HEADERS["X-Auth-Request-Email"]} legitimate=${legitimate} observed=${observed}`
        ).toBe(legitimate);
      });
    }
  });
});
