import { Page } from "@playwright/test";
import { test, expect } from "../../fixtures";
import { isAuthWall } from "../../constants";

// L1 — first path segment after redirect must NOT be one of these.
const RESERVED_PATH_SEGMENTS = new Set([
  "auth", "login", "signin", "sign-in", "sign_in", "signup", "sign-up",
  "logout", "sign_out", "signout", "oauth2", "onboarding",
  "create-workspace", "invitations", "god-mode", "accounts", "api",
  "static", "_next",
]);

// L8 — paths matching this regex are dropped from the discovery set.
const LOGOUT_PATH_RE = /\/(logout|sign_out|signout)/i;

export async function resolveStartUrl(page: Page, baseUrl: string): Promise<string> {
  const expectedHost = new URL(baseUrl).hostname;
  await page.goto(baseUrl, { waitUntil: "networkidle", timeout: 30000 });

  const u = new URL(page.url());
  if (u.hostname !== expectedHost) {
    throw new Error(`Expected ${expectedHost}, landed on ${page.url()}`);
  }
  const first = u.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
  if (first && RESERVED_PATH_SEGMENTS.has(first)) {
    throw new Error(
      `Start URL on reserved path "${first}" — user may have no default workspace: ${page.url()}`
    );
  }
  return page.url();
}

export async function collectInternalHrefs(page: Page, host: string): Promise<string[]> {
  const hrefs = await page.$$eval("a[href]", (anchors) =>
    anchors.map((a) => (a as HTMLAnchorElement).href).filter(Boolean)
  );

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of hrefs) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "https:") continue;
    if (url.hostname !== host) continue;
    if (LOGOUT_PATH_RE.test(url.pathname)) continue;

    const key = url.origin + url.pathname + url.search;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

export interface LinkCoverageOptions {
  appName: string;
  baseUrl: string;
  /** Register the click-coverage test (L7). Slow — one full reload per link. */
  includeClickTest?: boolean;
}

export function registerLinkCoverage({
  appName,
  baseUrl,
  includeClickTest = true,
}: LinkCoverageOptions): void {
  const HOST = new URL(baseUrl).hostname;

  test.describe(`${appName} — Link Coverage`, () => {
    // L1 + L2
    test("start page exposes at least one internal link", async ({ page }) => {
      const start = await resolveStartUrl(page, baseUrl);
      const links = await collectInternalHrefs(page, HOST);
      console.log(`[${appName}] start=${start}`);
      console.log(`[${appName}] discovered ${links.length} links`);
      expect(
        links.length,
        `${appName}: expected internal links from ${start}`
      ).toBeGreaterThan(0);
    });

    // L3 + L4 + L5 + L6
    test("every internal link loads without auth wall or error", async ({ page }) => {
      await resolveStartUrl(page, baseUrl);
      const links = await collectInternalHrefs(page, HOST);
      expect(links.length).toBeGreaterThan(0);

      const failures: { url: string; reason: string }[] = [];
      for (const href of links) {
        const res = await page
          .goto(href, { waitUntil: "networkidle", timeout: 30000 })
          .catch((e) => {
            failures.push({ url: href, reason: `goto threw: ${e.message}` });
            return null;
          });
        if (!res) continue;

        const status = res.status();
        const landed = page.url();

        if (status >= 400) {
          failures.push({ url: href, reason: `HTTP ${status}` });
          continue;
        }
        if (isAuthWall(landed)) {
          failures.push({ url: href, reason: `bounced to auth wall: ${landed}` });
          continue;
        }
        if (new URL(landed).hostname !== HOST) {
          failures.push({ url: href, reason: `left ${HOST}, landed on ${landed}` });
          continue;
        }
        const title = (await page.title()).toLowerCase();
        if (title.includes("404") || title.includes("not found")) {
          failures.push({ url: href, reason: `404 title: ${title}` });
        }
      }

      expect(
        failures,
        `${appName} broken links:\n${JSON.stringify(failures, null, 2)}`
      ).toEqual([]);
    });

    // L7
    if (includeClickTest) {
      test("clicking each visible link navigates within host", async ({ page }) => {
        const start = await resolveStartUrl(page, baseUrl);
        const links = await collectInternalHrefs(page, HOST);
        expect(links.length).toBeGreaterThan(0);

        const failures: { href: string; reason: string }[] = [];
        for (const href of links) {
          await page.goto(start, { waitUntil: "networkidle", timeout: 30000 });

          const u = new URL(href);
          const link = page.locator(`a[href="${u.pathname}${u.search}"]`).first();
          if (!(await link.isVisible().catch(() => false))) continue;

          await Promise.all([
            page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {}),
            link.click({ timeout: 10000 }).catch((e) => {
              failures.push({ href, reason: `click threw: ${e.message}` });
            }),
          ]);

          const landed = page.url();
          if (isAuthWall(landed)) {
            failures.push({ href, reason: `bounced to auth wall: ${landed}` });
          } else if (new URL(landed).hostname !== HOST) {
            failures.push({ href, reason: `left ${HOST}: ${landed}` });
          }
        }

        expect(
          failures,
          `${appName} click failures:\n${JSON.stringify(failures, null, 2)}`
        ).toEqual([]);
      });
    }
  });
}
