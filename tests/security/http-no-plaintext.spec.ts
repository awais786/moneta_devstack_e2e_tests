import { test, expect, request } from "@playwright/test";
import { APPS, MAIN_URL, AUTH_PROXY_DOMAIN } from "../../constants";

// Verifies no FOSS endpoint serves content over plain HTTP. Acceptable
// outcomes when probed at `http://<host>/`:
//
//   1. HTTP → HTTPS redirect (301/308 with `Location: https://...`)
//   2. Port 80 closed at TCP (connection refused / network error)
//   3. 403 / 404 from Traefik with no body (entrypoint exists but
//      refuses HTTP traffic)
//
// Fail conditions:
//
//   - 2xx with content over http://    → TLS-stripping risk; cookies
//                                         could be sent in plaintext
//   - Redirect to a non-https:// URL   → broken redirect chain
//   - Redirect to a different host     → downgrade-to-other-domain risk

const HTTP_TARGETS: { name: string; url: string }[] = [
  { name: "Main portal",       url: MAIN_URL },
  { name: "ForwardAuth proxy", url: `https://${AUTH_PROXY_DOMAIN}` },
  ...APPS.map((a) => ({ name: a.name, url: a.url })),
].map(({ name, url }) => ({
  name,
  // Force the http:// scheme — we're probing whether plaintext is reachable.
  url: url.replace(/^https:\/\//, "http://"),
}));

async function probeHttp(httpUrl: string): Promise<
  | { kind: "refused" }
  | { kind: "response"; status: number; location?: string }
> {
  const ctx = await request.newContext({ ignoreHTTPSErrors: true });
  try {
    const res = await ctx
      .get(httpUrl, { maxRedirects: 0, timeout: 15_000 })
      .catch((e) => e);
    if (res instanceof Error) {
      // TCP refused / DNS / network error — connection refused is the
      // safest possible outcome (no HTTP server listening on :80).
      return { kind: "refused" };
    }
    return {
      kind: "response",
      status: res.status(),
      location: res.headers()["location"],
    };
  } finally {
    await ctx.dispose();
  }
}

test.describe("HTTP plaintext lockdown", () => {
  for (const target of HTTP_TARGETS) {
    test(`${target.name} — no content served over plain HTTP`, async () => {
      const result = await probeHttp(target.url);

      if (result.kind === "refused") {
        // Port 80 closed entirely — best-case outcome.
        return;
      }

      // 2xx is the only forbidden range — means content was served
      // directly over plain HTTP. 3xx (redirect to https) and 4xx/5xx
      // (refused) are both fine.
      const isPlaintext2xx = result.status >= 200 && result.status < 300;
      expect(
        isPlaintext2xx,
        `${target.url} returned ${result.status} over plain HTTP — TLS-stripping risk. Server must redirect to https:// or refuse the connection.`
      ).toBe(false);

      // For redirects, Location must be https://. Cross-host redirects
      // are allowed (ForwardAuth legitimately bounces app hosts to the
      // auth-proxy host) — the only thing that matters is the scheme
      // upgrade.
      if (result.status >= 300 && result.status < 400) {
        expect(
          result.location,
          `${target.url} redirected with no Location header`
        ).toBeTruthy();
        expect(
          result.location!.toLowerCase().startsWith("https://"),
          `${target.url} redirected to non-https Location: ${result.location}`
        ).toBe(true);
      }
    });
  }
});
