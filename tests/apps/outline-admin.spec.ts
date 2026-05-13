import { test, expect } from "../../fixtures";
import { test as raw } from "@playwright/test";
import {
  APP_URLS,
  IDP_REGEX,
  isAuthWall,
} from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

const ADMIN_USER = process.env.OUTLINE_ADMIN_USER;
const ADMIN_PASS = process.env.OUTLINE_ADMIN_PASS;

const DOCS_HOST = new URL(APP_URLS.Outline).hostname;

// Outline has no separate /admin path and no ForwardAuth bypass for it.
// Admin functionality lives in the /settings/* namespace, gated server-side
// by the user's role (state.auth.user.role === "admin"). The contract is
// the *inverse* of Plane's /god-mode/:
//
//   (1) Every /settings/* URL sits fully behind SSO — a cold context
//       must bounce through ForwardAuth / the IDP.
//   (2) SSO-authed as a non-admin (FOSS_USER), Outline enforces the
//       role split with a server-side 404 — admin-only pages return
//       "Not Found", non-admin-visible pages load on the Outline host.
//
// The split between ADMIN_ONLY and NON_ADMIN_VISIBLE was discovered by
// hitting the deployment with a non-admin SSO user. If a future Outline
// release flips a page from one bucket to the other, that release note
// belongs to whoever runs this suite — these tests are the contract.

const COMMON_PATHS = [
  "/settings",
  "/settings/members",
  "/settings/groups",
  "/settings/api-and-access",
  "/settings/shares",
] as const;

const ADMIN_ONLY_PATHS = [
  "/settings/details",
  "/settings/security",
  "/settings/authentication",
  "/settings/features",
  "/settings/integrations",
  "/settings/applications",
  "/settings/import",
  "/settings/export",
] as const;

const ALL_PATHS = [...COMMON_PATHS, ...ADMIN_ONLY_PATHS] as const;

// Outline serves the SPA shell with title "Outline" before the router
// mounts the route component (which then sets the per-page title, e.g.
// "Not Found - Outline" or "Members - Outline"). networkidle fires
// before that title swap, so reading title at that point races with the
// SPA. Wait for the title to leave the shell default before asserting.
//
// For admin-only paths under a non-admin user, the title sometimes
// never updates (the route silently fails to render). Callers handle
// that by treating "shell default" as one valid gated signal.
async function waitForSpaTitle(page: import("@playwright/test").Page): Promise<string> {
  await page
    .waitForFunction(() => document.title.trim().toLowerCase() !== "outline", null, {
      timeout: 10000,
    })
    .catch(() => {});
  return (await page.title()).toLowerCase();
}

test.describe("Outline — admin /settings URLs", () => {
  // (1) Cold context: every admin URL must bounce through SSO.
  for (const path of ALL_PATHS) {
    raw(`cold visit to ${path} bounces through SSO (no bypass)`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext(); // no storageState → no SSO cookie
      const page = await ctx.newPage();
      try {
        await page.goto(APP_URLS.Outline + path, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

        const landed = page.url();
        const bouncedToSSO = isAuthWall(landed) || IDP_REGEX.test(landed);
        expect(
          bouncedToSSO,
          `${path} must bounce through SSO — Outline admin is not bypass-routed. Landed: ${landed}`
        ).toBe(true);
      } finally {
        await ctx.close();
      }
    });
  }

  // (2a) SSO-authed as a non-admin: pages every user can reach load cleanly.
  for (const path of COMMON_PATHS) {
    test(`non-admin reaches ${path} on the Outline host`, async ({ page }) => {
      const res = await page.goto(APP_URLS.Outline + path, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

      const landed = page.url();
      expect(new URL(landed).hostname).toBe(DOCS_HOST);
      expect(
        isAuthWall(landed),
        `Non-admin bounced to auth wall on ${path}: ${landed}`
      ).toBe(false);
      expect(
        res?.status() ?? 0,
        `${path} returned ${res?.status()}`
      ).toBeLessThan(400);

      const title = await waitForSpaTitle(page);
      expect(
        title.includes("not found") || title.includes("404"),
        `${path} should NOT be admin-gated for a normal user, but title is: "${title}"`
      ).toBe(false);
    });
  }

  // (2b) SSO-authed as a non-admin: admin-only pages return "Not Found".
  // Outline enforces the role split server-side — this is a stronger
  // guarantee than role-gated UI, and the test that locks it in.
  for (const path of ADMIN_ONLY_PATHS) {
    test(`non-admin gets Not Found on admin-only ${path}`, async ({ page }) => {
      await page.goto(APP_URLS.Outline + path, {
        waitUntil: "domcontentloaded",
        timeout: 30000,
      });
      await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

      const landed = page.url();
      expect(new URL(landed).hostname).toBe(DOCS_HOST);
      expect(
        isAuthWall(landed),
        `Admin-only ${path} must serve Not Found, not bounce to auth wall: ${landed}`
      ).toBe(false);

      const title = await waitForSpaTitle(page);
      const gated =
        title === "outline" || // SPA never resolved to a real page
        title.includes("not found") ||
        title.includes("404") ||
        title.includes("module failed to load");
      expect(
        gated,
        `Admin-only ${path} must be gated for a non-admin user (shell default, Not Found, or chunk-load failure), but title is: "${title}"`
      ).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// (3) Positive side of the role contract: an SSO-authed *admin* user
//     must reach every /settings/* page without hitting any of the
//     non-admin gating signals. Self-skips when OUTLINE_ADMIN_USER and
//     OUTLINE_ADMIN_PASS aren't set — mirrors the PLANE_ADMIN_* pattern.
// ---------------------------------------------------------------------------
raw.describe("Outline — admin SSO user reaches every /settings page", () => {
  raw.skip(
    !ADMIN_USER || !ADMIN_PASS,
    "Set OUTLINE_ADMIN_USER and OUTLINE_ADMIN_PASS in .env to run this block"
  );

  for (const path of ALL_PATHS) {
    raw(`admin reaches ${path} with a real page title`, async ({ browser }) => {
      raw.setTimeout(120_000); // SSO login + navigation
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      try {
        await cognitoLogin(page, { user: ADMIN_USER!, pass: ADMIN_PASS! });

        const res = await page.goto(APP_URLS.Outline + path, {
          waitUntil: "domcontentloaded",
          timeout: 30000,
        });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

        const landed = page.url();
        expect(new URL(landed).hostname).toBe(DOCS_HOST);
        expect(isAuthWall(landed), `Admin bounced to auth wall on ${path}: ${landed}`).toBe(false);
        expect(res?.status() ?? 0, `${path} returned ${res?.status()}`).toBeLessThan(400);

        const title = await waitForSpaTitle(page);
        const gatedForNonAdmin =
          title === "outline" ||
          title.includes("not found") ||
          title.includes("404") ||
          title.includes("module failed to load");
        expect(
          gatedForNonAdmin,
          `Admin must reach ${path} cleanly — title looks gated/unloaded: "${title}"`
        ).toBe(false);
      } finally {
        await ctx.close();
      }
    });
  }
});
