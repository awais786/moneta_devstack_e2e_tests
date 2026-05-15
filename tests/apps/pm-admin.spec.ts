import { test, expect } from "../../fixtures";
import { test as raw } from "@playwright/test";
import { APP_URLS, IDP_REGEX, isAuthWall } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

// Plane workspace-admin contract (foss-server-bundle admin.md):
//   • Distinct from /god-mode (which is local-creds and bypasses SSO —
//     covered in pm-godmode.spec.ts). This spec covers SSO-gated
//     per-workspace admin URLs like /<slug>/settings/members.
//   • FOSS_USER is the owner of a workspace whose slug is `aa` on the
//     sandbox. NORMAL_USER is NOT a member of that workspace — Plane
//     issues each SSO user their own workspace on first login.
//   • On /<slug>/settings/members:
//       - Owner sees the Members table + "Add member" button.
//       - Non-member sees "Workspace not found" (Plane's authorization
//         gate, indistinguishable from a non-existent slug).
//   • Slug parameterized via PLANE_ADMIN_WORKSPACE_SLUG with the
//     sandbox value as default.

const PLANE_WORKSPACE_SLUG = process.env.PLANE_ADMIN_WORKSPACE_SLUG ?? "aa";

const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

const BASE = APP_URLS.PM;
const PM_HOST = new URL(BASE).hostname;
const MEMBERS_URL = `${BASE}/${PLANE_WORKSPACE_SLUG}/settings/members/`;
const PM_HOST_REGEX = new RegExp(`^https?://${PM_HOST.replace(/\./g, "\\.")}`);

// (1) Cold context: the admin URL must bounce through SSO.
raw.describe("Plane — workspace-admin URL (cold context)", () => {
  raw("cold visit to /<slug>/settings/members bounces through SSO", async ({
    browser,
  }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await page.goto(MEMBERS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

      await expect
        .poll(() => isAuthWall(page.url()) || IDP_REGEX.test(page.url()), {
          message: `/${PLANE_WORKSPACE_SLUG}/settings/members must bounce through SSO. Last URL: ${page.url()}`,
          timeout: 15_000,
        })
        .toBe(true);
    } finally {
      await ctx.close();
    }
  });
});

// (2) SSO-authed as NORMAL_USER: not a member of FOSS_USER's
//     workspace, so Plane serves a "Workspace not found" page rather
//     than the Members table. This is Plane's authorization gate —
//     the response code is 200 but the UI is the not-found shell.
raw.describe("Plane — non-admin (non-member) is gated", () => {
  raw.skip(
    !NORMAL_USER || !NORMAL_PASS,
    "Set NORMAL_USER and NORMAL_PASS in .env to run the non-admin contract"
  );

  raw("non-admin sees 'Workspace not found' on owner's settings URL", async ({
    browser,
  }) => {
    raw.setTimeout(120_000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });
      await page.goto(MEMBERS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

      await expect(page).toHaveURL(PM_HOST_REGEX);
      expect(
        isAuthWall(page.url()),
        `Non-admin bounced to auth wall: ${page.url()}`
      ).toBe(false);

      // Plane serves the "Workspace not found" shell with a Go Home link.
      // This is the authorization-denied state, indistinguishable in
      // shape from a non-existent slug.
      await expect(
        page.getByRole("heading", { name: /workspace not found/i }),
        "Non-admin must hit Plane's 'Workspace not found' shell on the owner's workspace settings URL"
      ).toBeVisible({ timeout: 15_000 });

      // And must NOT see the admin Members controls.
      await expect(
        page.getByRole("button", { name: /^add member$/i }),
        "Non-admin must not see the 'Add member' button"
      ).toBeHidden();
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (3) SSO-authed as FOSS_USER (workspace owner): the Members table and
//     "Add member" button render.
// ---------------------------------------------------------------------------
test.describe("Plane — admin (FOSS_USER, workspace owner) reaches owner-only controls", () => {
  test("Owner sees Members heading + 'Add member' on /<slug>/settings/members", async ({
    page,
  }) => {
    await page.goto(MEMBERS_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

    await expect(page).toHaveURL(PM_HOST_REGEX);
    expect(isAuthWall(page.url()), `Admin bounced to auth wall: ${page.url()}`).toBe(false);

    await expect(
      page.getByRole("heading", { name: /members/i }).first(),
      "Owner must see the 'Members' heading on workspace settings"
    ).toBeVisible({ timeout: 15_000 });

    await expect(
      page.getByRole("button", { name: /^add member$/i }),
      "Owner must see the 'Add member' button"
    ).toBeVisible({ timeout: 15_000 });
  });
});
