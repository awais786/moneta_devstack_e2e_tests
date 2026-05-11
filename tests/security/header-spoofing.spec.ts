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
//       spoofed `X-Auth-Request-Email` for a DIFFERENT user. The
//       request reaches the backend (so the full chain runs); we
//       assert the returned identity is the cookie-derived one.
//
//       LIMITATIONS — this is a partial check, not iron-clad proof:
//
//       1. Traefik's ForwardAuth often REPLACES inbound headers
//          listed in `authResponseHeaders` with oauth2-proxy's value
//          rather than appending. If your stack replaces, the
//          attacker's value gets overwritten by mpass-auth even if
//          strip is removed — the test passes on a misconfiguration
//          it claims to catch.
//       2. If Traefik appends (creating duplicate headers), backend
//          behavior diverges: Django/Express/FastAPI/Node all handle
//          duplicate `X-Auth-Request-Email` differently (first wins,
//          last wins, comma-joined, error). The test only catches
//          the "first wins" backends.
//
//       What this test DOES reliably catch:
//          - mpass-auth accidentally removed from the router (the
//            inbound header would be the ONLY one present →
//            attacker identity returned)
//          - Backend that explicitly prefers inbound headers over
//            ForwardAuth-injected ones (rare but exists in misconfig)
//
//       What it does NOT catch: a missing `strip-auth-headers` on
//       stacks where Traefik replaces. RULES.md §1 keeps that as an
//       audit invariant; the live test here is a partial backstop.

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
  Penpot: async (ctx, extra) => {
    const cookie = await cookieHeaderFor(ctx, APP_URLS.Penpot);
    const c = await request.newContext({ extraHTTPHeaders: { cookie, ...extra } });
    try {
      const r = await c.get(`${APP_URLS.Penpot}/api/rpc/command/get-profile`);
      const body = (await r.json()) as unknown;
      // Penpot speaks Transit-JSON: a flat array with `~:email` followed
      // by the value. Mirrors the extractor in identity-consistency.
      if (!Array.isArray(body)) throw new Error("Penpot non-Transit response");
      const idx = body.indexOf("~:email");
      if (idx < 0 || idx + 1 >= body.length) {
        throw new Error("Penpot Transit response missing :email");
      }
      return String(body[idx + 1]);
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
      test(`${appName}: spoofed X-Auth-Request-Email does not flip backend identity (partial)`, async ({
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

        // PARTIAL check — see file-header LIMITATIONS comment. A pass
        // here means the spoof didn't reach the backend (or did and the
        // backend ignored it). A divergence means the spoof reached
        // the backend AND was preferred over mpass-auth's value —
        // that's a hard fail.
        expect(
          observed,
          `${appName}: backend returned the SPOOFED email when a forged X-Auth-Request-Email was sent alongside a valid cookie. The inbound header reached the upstream AND was preferred over mpass-auth's value. attacker=${SPOOFED_HEADERS["X-Auth-Request-Email"]} legitimate=${legitimate} observed=${observed}`
        ).toBe(legitimate);
      });
    }
  });
});
