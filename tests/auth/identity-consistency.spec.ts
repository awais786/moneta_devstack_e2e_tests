import { test, expect } from "../../fixtures";
import { request, BrowserContext } from "@playwright/test";
import { APP_URLS } from "../../constants";

// Verifies every backend's view of the logged-in user converges on the
// same email. RULES.md §1 ("SSO chain") requires `DEFAULT_EMAIL_DOMAIN` to
// be set identically on every app container — otherwise a bare-username
// Cognito subject gets synthesized differently per app and the same
// physical user shows up as two distinct identities to the stack.
//
// Live deployment ground truth (probed 2026-05-11): Cognito returns a
// bare username (`1020010000019120`), so the synthesis path IS
// exercised. Every app's `/me`-style endpoint returns
// `1020010000019120@askii.ai` — proving DEFAULT_EMAIL_DOMAIN is
// consistent across backends.
//
// Endpoint shapes differ per app (there's no uniform `/me`). The table
// below encodes each app's identity endpoint and the path to its email
// field. New apps land in the table with their own shape.
//
// Twenty is intentionally omitted: its `/rest/*` endpoints require a
// JWT Bearer (not the SSO cookie), and the SPA hides email/password
// fields by design (correct per RULES.md §1 "Identity-managed fields",
// verified by sso-mode-no-local-login.spec.ts). Twenty's identity is
// already gated by the same oauth2-proxy that feeds the other four,
// so divergence there would only be possible if Twenty's SSO controller
// transformed the email — and that's a single hot path, easily audited.

type Probe = {
  app: keyof typeof APP_URLS;
  description: string;
  fetch: (ctx: BrowserContext, baseUrl: string) => Promise<string>;
};

async function postJSON<T>(
  cookieHeader: string,
  url: string,
  body: object = {}
): Promise<T> {
  const ctx = await request.newContext({
    extraHTTPHeaders: { cookie: cookieHeader, "content-type": "application/json" },
  });
  try {
    const res = await ctx.post(url, { data: body, maxRedirects: 0 });
    if (!res.ok()) {
      throw new Error(`POST ${url} → ${res.status()}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    await ctx.dispose();
  }
}

async function getJSON<T>(cookieHeader: string, url: string): Promise<T> {
  const ctx = await request.newContext({
    extraHTTPHeaders: { cookie: cookieHeader },
  });
  try {
    const res = await ctx.get(url, { maxRedirects: 0 });
    if (!res.ok()) {
      throw new Error(`GET ${url} → ${res.status()}: ${(await res.text()).slice(0, 200)}`);
    }
    return (await res.json()) as T;
  } finally {
    await ctx.dispose();
  }
}

async function cookieHeaderFor(ctx: BrowserContext, baseUrl: string): Promise<string> {
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

// Penpot speaks Transit-JSON: arrays where odd-indexed entries are keys
// like `~:email` and the following entry is the value.
function extractTransitEmail(body: unknown): string {
  if (!Array.isArray(body)) throw new Error("Penpot response is not Transit-JSON");
  const idx = body.indexOf("~:email");
  if (idx < 0 || idx + 1 >= body.length) {
    throw new Error("Penpot Transit response has no :email key");
  }
  return String(body[idx + 1]);
}

const PROBES: Probe[] = [
  {
    app: "PM",
    description: "Plane GET /api/users/me/",
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      const j = await getJSON<{ email: string }>(ch, `${baseUrl}/api/users/me/`);
      return j.email;
    },
  },
  {
    app: "Outline",
    description: "Outline POST /api/auth.info",
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      const j = await postJSON<{ data: { user: { email: string } } }>(
        ch,
        `${baseUrl}/api/auth.info`
      );
      return j.data.user.email;
    },
  },
  {
    app: "Penpot",
    description: "Penpot GET /api/rpc/command/get-profile",
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      const j = await getJSON<unknown>(ch, `${baseUrl}/api/rpc/command/get-profile`);
      return extractTransitEmail(j);
    },
  },
  {
    app: "SurfSense",
    description: "SurfSense GET /users/me",
    fetch: async (ctx, baseUrl) => {
      const ch = await cookieHeaderFor(ctx, baseUrl);
      const j = await getJSON<{ email: string }>(ch, `${baseUrl}/users/me`);
      return j.email;
    },
  },
];

test.describe("Cross-app identity consistency", () => {
  test("every backend resolves the logged-in user to the same email", async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);

    // Warm each app once so per-host cookies are in the jar. Penpot and
    // SurfSense in particular set their own session cookies on top of
    // the SSO cookie, and those cookies are what their /me endpoints
    // authenticate against.
    for (const probe of PROBES) {
      const baseUrl = APP_URLS[probe.app];
      await page.goto(baseUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }

    const results: { app: string; email: string }[] = [];
    const errors: { app: string; error: string }[] = [];

    for (const probe of PROBES) {
      try {
        const email = await probe.fetch(context, APP_URLS[probe.app]);
        results.push({ app: probe.app, email });
      } catch (e) {
        errors.push({ app: probe.app, error: (e as Error).message });
      }
    }

    expect(
      errors,
      `identity probe(s) failed:\n${JSON.stringify(errors, null, 2)}`
    ).toEqual([]);

    // Every probe must return a string that looks like an email.
    for (const r of results) {
      expect(
        r.email,
        `${r.app}: identity endpoint returned non-email value "${r.email}"`
      ).toMatch(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
    }

    const distinct = new Set(results.map((r) => r.email.toLowerCase()));
    expect(
      distinct.size,
      `backends disagree on the user's email — DEFAULT_EMAIL_DOMAIN likely diverges across containers. Per-app view:\n${JSON.stringify(results, null, 2)}`
    ).toBe(1);
  });
});
