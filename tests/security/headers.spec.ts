import { test, expect, request } from "@playwright/test";
import { APPS, MAIN_URL } from "../../constants";

// HTTP security headers contract. These are set by the `security-headers`
// Traefik middleware on every `*-secure` router (foss-server-bundle
// docker-compose.yml). The middleware fires BEFORE mpass-auth, so headers
// are present on both authed responses and the 302 redirect to the IDP —
// no login is needed to verify them.
//
// Spec references:
//   HSTS:           RFC 6797
//   X-Content-Type: https://owasp.org/www-project-secure-headers/
//   Frame-Options:  https://developer.mozilla.org/en-US/docs/Web/HTTP/Headers/X-Frame-Options
//   Referrer:       https://www.w3.org/TR/referrer-policy/
//   Permissions:    https://w3c.github.io/webappsec-permissions-policy/

interface HeaderRule {
  name: string;
  // Predicate runs in lower-case-string mode. Header is normalised by the
  // checker before being passed in.
  matches: (value: string) => boolean;
  why: string;
}

const HEADER_RULES: HeaderRule[] = [
  {
    name: "strict-transport-security",
    matches: (v) =>
      /max-age=\d+/.test(v) &&
      Number(v.match(/max-age=(\d+)/)?.[1] ?? "0") >= 15552000 && // ≥ 180 days
      v.includes("includesubdomains"),
    why: "HSTS must include max-age ≥ 6 months and includeSubdomains to protect every foss-* host",
  },
  {
    name: "x-content-type-options",
    matches: (v) => v === "nosniff",
    why: "Blocks MIME-sniffing-driven XSS; must be exactly 'nosniff'",
  },
  {
    name: "x-frame-options",
    matches: (v) => v === "deny" || v === "sameorigin",
    why: "Clickjacking defence; DENY or SAMEORIGIN required",
  },
  {
    name: "referrer-policy",
    matches: (v) =>
      [
        "no-referrer",
        "no-referrer-when-downgrade",
        "same-origin",
        "strict-origin",
        "strict-origin-when-cross-origin",
      ].includes(v),
    why: "Must not leak full URLs (no `unsafe-url` / `origin`-only) to third parties",
  },
  {
    name: "permissions-policy",
    matches: (v) =>
      // Require the four powerful APIs to be denied by default. Other
      // values may follow.
      ["camera", "microphone", "geolocation"].every((feature) =>
        new RegExp(`${feature}\\s*=\\s*\\(\\s*\\)`).test(v)
      ),
    why: "Sensitive APIs (camera, microphone, geolocation) must be disallowed by default",
  },
];

async function fetchHeaders(url: string): Promise<Record<string, string>> {
  const ctx = await request.newContext({ ignoreHTTPSErrors: false });
  try {
    // maxRedirects: 0 — we want the immediate response from the FOSS host,
    // not the headers from a downstream IDP page.
    const res = await ctx.get(url, { maxRedirects: 0 });
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(res.headers())) {
      headers[k.toLowerCase()] = String(v).toLowerCase();
    }
    return headers;
  } finally {
    await ctx.dispose();
  }
}

test.describe("Security headers", () => {
  for (const target of [
    { name: "Main portal", url: MAIN_URL },
    ...APPS.map((a) => ({ name: a.name, url: a.url })),
  ]) {
    test(`${target.name} sets the canonical security headers`, async () => {
      const headers = await fetchHeaders(target.url);
      const failures: string[] = [];

      for (const rule of HEADER_RULES) {
        const value = headers[rule.name];
        if (value === undefined) {
          failures.push(`${rule.name}: missing — ${rule.why}`);
          continue;
        }
        if (!rule.matches(value)) {
          failures.push(`${rule.name}: "${value}" does not satisfy contract — ${rule.why}`);
        }
      }

      expect(
        failures,
        `${target.name} (${target.url}) header violations:\n${failures.join("\n")}`
      ).toEqual([]);
    });
  }
});
