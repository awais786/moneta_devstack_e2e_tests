import { test, expect } from "../../fixtures";
import { test as raw } from "@playwright/test";
import { APP_URLS, IDP_REGEX, isAuthWall } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

const BASE = APP_URLS.Twenty;
const TWENTY_HOST = new URL(BASE).hostname;
const ADMIN_URL = `${BASE}/settings/admin-panel`;

// Identity model (sso-rules/admin.md): FOSS_USER (User A) is the
// pre-bootstrapped admin with canAccessFullAdminPanel=true on Twenty;
// NORMAL_USER (User B) is the non-admin baseline. Worker fixture uses
// FOSS_USER, so admin-side tests use `test`; non-admin uses an explicit
// cognitoLogin into a fresh context with NORMAL_USER.
const NORMAL_USER = process.env.NORMAL_USER;
const NORMAL_PASS = process.env.NORMAL_PASS;

// Twenty is the only app in the bundle with a real `/admin` URL distinct
// from workspace-level admin. Two separate concepts live behind the same
// URL space:
//   • Global admin — `User.canAccessFullAdminPanel === true`, checked
//     server-side by AdminPanelGuard. Mounted at /settings/admin-panel
//     and the /admin-panel-graphql-api endpoint.
//   • Workspace admin — `WorkspaceMember.role = "Admin"` (UUID
//     20202020-02c2-43f2-b94d-cab1f2b532eb). Unrelated to admin-panel.
//
// There is no first-user-auto-admin and no UI/API path to flip
// `canAccessFullAdminPanel` — bootstrap requires the
// `workspace:bootstrap-sso-admin --email <email>` CLI command (the
// bundle's provision-twenty.sh wires this). So this spec is read-side
// only: it verifies the gate, not promotion. Promotion is exercised
// implicitly — if the bootstrap command works, TWENTY_ADMIN_USER
// reaches the panel; if it didn't, they get the same non-admin signal
// FOSS_USER does, and the admin-side test fails loudly.
//
// Twenty's SPA keeps a GraphQL-subscriptions websocket open, so the
// page never reaches `networkidle` (see tests/apps/twenty.spec.ts and
// link-coverage.ts for the same issue). Use `commit` + an explicit
// render wait.

async function waitForAdminPanelSurface(page: import("@playwright/test").Page): Promise<void> {
  await page
    .waitForFunction(() => {
      const text = (document.body?.innerText ?? "").toLowerCase();
      return text.length > 0;
    }, null, { timeout: 10_000 })
    .catch(() => {});
}

// ---------------------------------------------------------------------------
// (A) Cold context: /settings/admin-panel must bounce through SSO.
// ---------------------------------------------------------------------------

raw.describe("Twenty — admin-panel URL gate (cold context)", () => {
  raw("cold visit to /settings/admin-panel bounces through SSO", async ({
    browser,
  }) => {
    raw.setTimeout(60_000);
    const ctx = await browser.newContext(); // no SSO cookie
    const page = await ctx.newPage();
    try {
      await page.goto(ADMIN_URL, { waitUntil: "commit", timeout: 30_000 });
      // Let any redirect chain settle. `networkidle` is unreliable for
      // Twenty even when authed; for cold context we expect to land on
      // an IDP/auth-wall page anyway, where networkidle works fine.
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});

      const landed = page.url();
      const bouncedToSSO = isAuthWall(landed) || IDP_REGEX.test(landed);
      expect(
        bouncedToSSO,
        `/settings/admin-panel must bounce through SSO — Twenty admin is not bypass-routed. Landed: ${landed}`
      ).toBe(true);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (B) SSO-authed as FOSS_USER (non-admin): the admin panel must be gated.
//
// The exact gating signal depends on Twenty's SPA implementation —
// it could redirect, render an access-denied component, or simply not
// render the admin UI. To make the contract robust to either:
//   • The page must stay on the Twenty host (not bounce to IDP).
//   • The visible content must NOT include admin-panel-specific UI.
// We pick a couple of strings that the admin-panel.resolver.ts surface
// implies are present on the admin page: "Health Status", "Feature
// Flags", "Config Variables", "AI Models". If even ONE renders for a
// non-admin, AdminPanelGuard has been bypassed.
// ---------------------------------------------------------------------------

const ADMIN_UI_MARKERS = [
  /health[\s-]*status/i,
  /feature[\s-]*flags?/i,
  /config[\s-]*variables?/i,
  /ai[\s-]*models?/i,
  /admin[\s-]*panel/i,
];

async function readVisibleText(page: import("@playwright/test").Page): Promise<string> {
  // page.content() includes attributes / hidden nodes; innerText gives
  // user-visible text only, which is what we want for a "would a real
  // admin see this" assertion.
  return await page.evaluate(() => document.body?.innerText ?? "");
}

raw.describe("Twenty — admin-panel gated for non-admin SSO user", () => {
  raw.skip(
    !NORMAL_USER || !NORMAL_PASS,
    "Set NORMAL_USER and NORMAL_PASS in .env to run the non-admin gate"
  );

  raw("non-admin lands on Twenty but admin-panel content is not rendered", async ({
    browser,
  }) => {
    raw.setTimeout(120_000);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    try {
      await cognitoLogin(page, { user: NORMAL_USER!, pass: NORMAL_PASS! });

      await page.goto(ADMIN_URL, { waitUntil: "commit", timeout: 30_000 });
      await waitForAdminPanelSurface(page);

      const landed = page.url();
      expect(new URL(landed).hostname).toBe(TWENTY_HOST);
      expect(
        isAuthWall(landed),
        `Non-admin must not bounce to auth wall on /settings/admin-panel: ${landed}`
      ).toBe(false);

      const visible = await readVisibleText(page);
      const matched = ADMIN_UI_MARKERS.filter((rx) => rx.test(visible));
      expect(
        matched,
        `AdminPanelGuard appears bypassed for NORMAL_USER — admin UI markers visible: ${matched
          .map((r) => r.source)
          .join(", ")}\nFirst 400 chars of visible text: ${visible.slice(0, 400)}`
      ).toEqual([]);
    } finally {
      await ctx.close();
    }
  });
});

// ---------------------------------------------------------------------------
// (C) SSO-authed as TWENTY_ADMIN_USER: the admin panel must render.
// Self-skips when admin creds aren't set (the spec is then purely a
// negative-side test, which is still a strong signal).
// ---------------------------------------------------------------------------

test.describe("Twenty — admin-panel reachable for FOSS_USER (canAccessFullAdminPanel=true)", () => {
  test("admin reaches /settings/admin-panel with admin UI visible", async ({ page }) => {
    test.setTimeout(60_000);

    await page.goto(ADMIN_URL, { waitUntil: "commit", timeout: 30_000 });
    await waitForAdminPanelSurface(page);

    const landed = page.url();
    expect(new URL(landed).hostname).toBe(TWENTY_HOST);
    expect(
      isAuthWall(landed),
      `Admin bounced to auth wall on /settings/admin-panel: ${landed}`
    ).toBe(false);

    const visible = await readVisibleText(page);
    const matched = ADMIN_UI_MARKERS.filter((rx) => rx.test(visible));
    expect(
      matched.length,
      `Admin must see at least one admin-panel UI marker. None of these matched: ${ADMIN_UI_MARKERS.map(
        (r) => r.source
      ).join(", ")}\nFirst 400 chars of visible text: ${visible.slice(0, 400)}`
    ).toBeGreaterThan(0);
  });
});
