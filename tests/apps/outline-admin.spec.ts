import { test, expect } from "../../fixtures";
import { test as raw, request } from "@playwright/test";
import {
  APP_URLS,
  IDP_REGEX,
  isAuthWall,
} from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// Identity model (sso-rules/admin.md): two SSO users across all apps.
//   • FOSS_USER (User A) — admin everywhere. Used by the worker fixture
//     and so is the implicit identity for the `test`-based blocks below.
//   • NORMAL_USER (User B) — non-admin baseline. Loaded explicitly via
//     cognitoLogin() in a fresh context when a test needs to assert the
//     non-admin side of a role contract.
const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

const DOCS_HOST = new URL(APP_URLS.Outline).hostname;

// Outline has no separate /admin path and no ForwardAuth bypass for it.
// Admin functionality lives in the /settings/* namespace, gated server-side
// by the user's role (state.auth.user.role === "admin"). The contract is
// the *inverse* of Plane's /god-mode/:
//
//   (1) Every /settings/* URL sits fully behind SSO — a cold context
//       must bounce through ForwardAuth / the IDP.
//   (2) SSO-authed as a non-admin (NORMAL_USER), Outline enforces the
//       role split with a server-side 404 — admin-only pages return
//       "Not Found", non-admin-visible pages load on the Outline host.
//   (3) SSO-authed as the admin (OUTLINE_ADMIN_USER, == FOSS_USER per
//       admin.md), every /settings page renders cleanly.
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
  // NOTE: /settings/people is the canonical members-admin URL per the
  // outline-admin sso-rules skill, but this fork serves Not Found for
  // both admin and non-admin — the actual members page is /settings/members
  // (in COMMON_PATHS). Don't add /settings/people back without first
  // probing it against this deployment.
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

// (1) Cold context: every admin URL must bounce through SSO.
//     Independent of any identity — uses no fixture, no cookies.
raw.describe("Outline — admin /settings URLs (cold context)", () => {
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
});

// (2) SSO-authed as a *non-admin* (NORMAL_USER, == User B): the role
//     split is enforced server-side. COMMON_PATHS load with a real
//     page title; ADMIN_ONLY_PATHS return Not Found / module-failed /
//     never resolve past the SPA shell. Whole block self-skips when
//     NORMAL_USER creds are unset.
raw.describe("Outline — non-admin role split (NORMAL_USER)", () => {
  raw.skip(
    !NORMAL_USER || !NORMAL_PASS,
    "Set NORMAL_USER and NORMAL_PASS in .env to run the non-admin contract"
  );

  for (const path of COMMON_PATHS) {
    raw(`non-admin reaches ${path} on the Outline host`, async ({ browser }) => {
      raw.setTimeout(120_000);
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      try {
        await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });

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
      } finally {
        await ctx.close();
      }
    });
  }

  for (const path of ADMIN_ONLY_PATHS) {
    raw(`non-admin gets Not Found on admin-only ${path}`, async ({ browser }) => {
      raw.setTimeout(120_000);
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      try {
        await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });

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
      } finally {
        await ctx.close();
      }
    });
  }
});

// ---------------------------------------------------------------------------
// (3) Positive side of the role contract: FOSS_USER (the admin per
//     admin.md) reaches every /settings/* page without hitting the
//     non-admin gating signals. Uses the worker fixture directly.
// ---------------------------------------------------------------------------
test.describe("Outline — admin (FOSS_USER) reaches every /settings page", () => {
  for (const path of ALL_PATHS) {
    test(`admin reaches ${path} with a real page title`, async ({ page }) => {
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
    });
  }
});

// ---------------------------------------------------------------------------
// (4) Mutation round-trip — FOSS_USER (admin) flips another user's role
//     via the documented RPC (POST /api/users.update_role, gated by
//     UserRoleHelper.isRoleLower at
//     server/middlewares/authentication.ts:391). Promote → verify →
//     restore in a finally block. Test self-skips when no safe target
//     exists (need a non-self, non-admin user).
// ---------------------------------------------------------------------------
test.describe("Outline — admin mutates user role via /api/users.update_role", () => {
  test("admin can promote a teammate and restore the original role", async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);

    // Establish Outline's own session cookie on top of the SSO cookie.
    await page.goto(APP_URLS.Outline + "/home", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    const cookies = await context.cookies(APP_URLS.Outline);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

    const apiCtx = await request.newContext({
      extraHTTPHeaders: {
        cookie: cookieHeader,
        "content-type": "application/json",
        accept: "application/json",
      },
    });

    let restore: (() => Promise<void>) | null = null;

    try {
      // (1) Resolve the admin's own id so we don't mutate ourselves.
      const meRes = await apiCtx.post(`${APP_URLS.Outline}/api/auth.info`, {
        data: {},
        maxRedirects: 0,
      });
      expect(meRes.ok(), `auth.info → ${meRes.status()}`).toBe(true);
      const meBody = (await meRes.json()) as { data?: { user?: { id?: string } } };
      const selfId = meBody.data?.user?.id;
      expect(selfId, "auth.info must expose user.id").toBeTruthy();

      // (2) List users; pick the first non-self, non-admin target.
      //     users.list paginates — first page is enough for typical
      //     deployments. If you need to scan deeper, add limit/offset.
      const listRes = await apiCtx.post(`${APP_URLS.Outline}/api/users.list`, {
        data: { limit: 100 },
        maxRedirects: 0,
      });
      expect(
        listRes.ok(),
        `users.list → ${listRes.status()}: ${(await listRes.text()).slice(0, 300)}`
      ).toBe(true);
      const listBody = (await listRes.json()) as {
        data?: { id: string; role: string; name?: string }[];
      };
      const users = listBody.data ?? [];
      const target = users.find((u) => u.id !== selfId && u.role !== "admin");
      test.skip(
        !target,
        `No safe target in /api/users.list — need a non-self non-admin user. Got ${users.length} users.`
      );

      const originalRole = target!.role;
      const newRole = originalRole === "admin" ? "member" : "admin";

      // (3) Stage restore before mutating.
      restore = async () => {
        const res = await apiCtx.post(`${APP_URLS.Outline}/api/users.update_role`, {
          data: { id: target!.id, role: originalRole },
          maxRedirects: 0,
        });
        if (!res.ok()) {
          // eslint-disable-next-line no-console
          console.error(
            `Outline admin spec: FAILED TO RESTORE role for user ${target!.id} ` +
              `(${target!.name ?? "?"}). status=${res.status()} body=${(await res.text()).slice(0, 300)}`
          );
        }
      };

      // (4) Mutate.
      const mutateRes = await apiCtx.post(`${APP_URLS.Outline}/api/users.update_role`, {
        data: { id: target!.id, role: newRole },
        maxRedirects: 0,
      });
      expect(
        mutateRes.ok(),
        `users.update_role to ${newRole} → ${mutateRes.status()}: ${(await mutateRes.text()).slice(0, 300)}`
      ).toBe(true);

      // (5) Verify via a fresh users.list lookup.
      const afterRes = await apiCtx.post(`${APP_URLS.Outline}/api/users.list`, {
        data: { limit: 100 },
        maxRedirects: 0,
      });
      expect(afterRes.ok()).toBe(true);
      const afterBody = (await afterRes.json()) as {
        data?: { id: string; role: string }[];
      };
      const afterTarget = (afterBody.data ?? []).find((u) => u.id === target!.id);
      expect(
        afterTarget,
        `target user ${target!.id} missing from users.list after mutation`
      ).toBeTruthy();
      expect(
        afterTarget!.role,
        `expected role=${newRole} after mutation, got role=${afterTarget!.role}`
      ).toBe(newRole);
    } finally {
      if (restore) await restore();
      await apiCtx.dispose();
    }
  });
});
