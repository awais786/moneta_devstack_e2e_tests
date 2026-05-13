import { test as raw, expect, request, BrowserContext } from "@playwright/test";
import { APP_URLS } from "../../constants";
import { cognitoLogin } from "../../auth-helpers";

const BASE = APP_URLS.SurfSense;
const ADMIN_USER = process.env.SURFSENSE_ADMIN_USER;
const ADMIN_PASS = process.env.SURFSENSE_ADMIN_PASS;

// SurfSense has no global admin — `is_superuser=False` is hard-coded for
// proxy-auth users (surfsense_backend/app/middleware/proxy_auth.py:131).
// Admin is per-SearchSpace via the system roles Owner / Editor / Viewer
// (db.py:352 Permission enum; MEMBERS_MANAGE_ROLES at db.py:417), gated
// server-side by rbac_routes.py:527-528 on the PUT
// /searchspaces/<id>/members/<membership-id> endpoint.
//
// Mirrors the Penpot admin spec one-to-one — different terms, same
// contract: an Owner can mutate a teammate's role through the RBAC
// API and the change is observable in the membership list, and the
// mutation is reversible (restored in finally).

// ---------------------------------------------------------------------------
// JSON helpers (SurfSense's RBAC API is plain JSON, not Transit).
// ---------------------------------------------------------------------------

async function cookieHeaderFor(ctx: BrowserContext, baseUrl: string): Promise<string> {
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function apiGet<T = unknown>(cookieHeader: string, path: string): Promise<{ status: number; body: T | string }> {
  const ctx = await request.newContext({
    extraHTTPHeaders: { cookie: cookieHeader, accept: "application/json" },
  });
  try {
    const res = await ctx.get(`${BASE}${path}`, { maxRedirects: 0 });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status(), body: parsed as T | string };
  } finally {
    await ctx.dispose();
  }
}

async function apiPut(
  cookieHeader: string,
  path: string,
  body: object
): Promise<{ status: number; body: unknown }> {
  const ctx = await request.newContext({
    extraHTTPHeaders: {
      cookie: cookieHeader,
      "content-type": "application/json",
      accept: "application/json",
    },
  });
  try {
    const res = await ctx.fetch(`${BASE}${path}`, {
      method: "PUT",
      data: body,
      maxRedirects: 0,
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
    return { status: res.status(), body: parsed };
  } finally {
    await ctx.dispose();
  }
}

// SurfSense responses generally use snake_case. To avoid being fragile
// to minor name drift between fork versions, accept either camelCase or
// snake_case for the IDs we care about.
function pick<T = unknown>(obj: unknown, ...keys: string[]): T | undefined {
  if (typeof obj !== "object" || obj === null) return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) if (o[k] !== undefined) return o[k] as T;
  return undefined;
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

raw.describe("SurfSense — Owner mutates teammate role via RBAC API", () => {
  raw.skip(
    !ADMIN_USER || !ADMIN_PASS,
    "Set SURFSENSE_ADMIN_USER and SURFSENSE_ADMIN_PASS in .env to run this spec"
  );

  raw("Owner can promote a teammate and restore the original role", async ({ browser }) => {
    raw.setTimeout(180_000);

    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    let restore: (() => Promise<void>) | null = null;

    try {
      // (1) SSO login as the SurfSense Owner.
      await cognitoLogin(page, { user: ADMIN_USER!, pass: ADMIN_PASS! });
      await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

      const cookieHeader = await cookieHeaderFor(ctx, BASE);

      // (2) Resolve the admin's own user-id to avoid mutating ourselves.
      const me = await apiGet<{ id?: string | number }>(cookieHeader, "/users/me");
      expect(me.status, `GET /users/me returned ${me.status}: ${JSON.stringify(me.body).slice(0, 200)}`).toBeLessThan(400);
      const selfId = pick<string | number>(me.body, "id", "user_id", "userId");
      expect(selfId, "SurfSense /users/me must expose an id").toBeTruthy();

      // (3) Discover SearchSpaces. SurfSense's standard path is
      //     /api/searchspaces; if a fork variant differs we'll see the
      //     status code in the failure message and adjust.
      const spaces = await apiGet<unknown[]>(cookieHeader, "/api/searchspaces");
      expect(
        spaces.status,
        `GET /api/searchspaces returned ${spaces.status}: ${JSON.stringify(spaces.body).slice(0, 200)}`
      ).toBeLessThan(400);
      const spaceList = Array.isArray(spaces.body) ? spaces.body : [];
      raw.skip(
        spaceList.length === 0,
        `SurfSense Owner has no SearchSpaces visible. body=${JSON.stringify(spaces.body).slice(0, 300)}`
      );

      // (4) Find a SearchSpace + iterate members + roles until we have a
      //     safe target (non-self, non-Owner) and a role to flip to.
      let chosenSpaceId: string | number | undefined;
      let chosenMembershipId: string | number | undefined;
      let originalRoleId: string | number | undefined;
      let newRoleId: string | number | undefined;
      let ownerRoleName: string | undefined;

      for (const space of spaceList) {
        const spaceId = pick<string | number>(space, "id", "search_space_id", "searchSpaceId");
        if (!spaceId) continue;

        const membersResp = await apiGet<unknown[]>(
          cookieHeader,
          `/api/rbac/searchspaces/${spaceId}/members`
        );
        if (membersResp.status >= 400) continue;
        const members = Array.isArray(membersResp.body) ? membersResp.body : [];

        const rolesResp = await apiGet<unknown[]>(
          cookieHeader,
          `/api/rbac/searchspaces/${spaceId}/roles`
        );
        if (rolesResp.status >= 400) continue;
        const roles = Array.isArray(rolesResp.body) ? rolesResp.body : [];

        // Owner role is the one we don't want to assign and don't want to
        // demote *from*. Identify it by name === "Owner" (system role).
        const ownerRole = roles.find((r) => {
          const name = pick<string>(r, "name", "role_name");
          return typeof name === "string" && name.toLowerCase() === "owner";
        });
        ownerRoleName = ownerRole ? pick<string>(ownerRole, "name", "role_name") : undefined;
        const ownerRoleId = ownerRole
          ? pick<string | number>(ownerRole, "id", "role_id", "roleId")
          : undefined;

        // Pick a member who is NOT the admin themselves AND NOT an Owner.
        const target = members.find((m) => {
          const userId = pick<string | number>(m, "user_id", "userId");
          const isOwner = pick<boolean>(m, "is_owner", "isOwner") === true;
          const memberRoleId = pick<string | number>(m, "role_id", "roleId");
          const isOwnerByRole = ownerRoleId !== undefined && memberRoleId === ownerRoleId;
          return userId !== selfId && !isOwner && !isOwnerByRole;
        });
        if (!target) continue;

        const memId = pick<string | number>(target, "membership_id", "id", "membershipId");
        const curRoleId = pick<string | number>(target, "role_id", "roleId");
        if (memId === undefined || curRoleId === undefined) continue;

        // Pick *any other* non-Owner role to flip to.
        const flipTo = roles.find((r) => {
          const rid = pick<string | number>(r, "id", "role_id", "roleId");
          return rid !== undefined && rid !== curRoleId && rid !== ownerRoleId;
        });
        if (!flipTo) continue;

        chosenSpaceId = spaceId;
        chosenMembershipId = memId;
        originalRoleId = curRoleId;
        newRoleId = pick<string | number>(flipTo, "id", "role_id", "roleId");
        break;
      }

      raw.skip(
        chosenSpaceId === undefined,
        `No SearchSpace had a non-self non-Owner member with a flippable role. Owner role found: ${ownerRoleName ?? "(none)"}`
      );

      // (5) Stage restore before mutating.
      restore = async () => {
        const res = await apiPut(
          cookieHeader,
          `/api/rbac/searchspaces/${chosenSpaceId}/members/${chosenMembershipId}`,
          { role_id: originalRoleId }
        );
        if (res.status >= 400) {
          // eslint-disable-next-line no-console
          console.error(
            `SurfSense admin spec: FAILED TO RESTORE role for membership ${chosenMembershipId} ` +
              `on SearchSpace ${chosenSpaceId}. status=${res.status} body=${JSON.stringify(res.body).slice(0, 300)}`
          );
        }
      };

      // (6) Mutate.
      const mutate = await apiPut(
        cookieHeader,
        `/api/rbac/searchspaces/${chosenSpaceId}/members/${chosenMembershipId}`,
        { role_id: newRoleId }
      );
      expect(
        mutate.status,
        `PUT role_id=${newRoleId} returned ${mutate.status}: ${JSON.stringify(mutate.body).slice(0, 300)}`
      ).toBeLessThan(400);

      // (7) Verify via a fresh members fetch.
      const afterResp = await apiGet<unknown[]>(
        cookieHeader,
        `/api/rbac/searchspaces/${chosenSpaceId}/members`
      );
      expect(afterResp.status).toBeLessThan(400);
      const afterMembers = Array.isArray(afterResp.body) ? afterResp.body : [];
      const afterTarget = afterMembers.find(
        (m) => pick<string | number>(m, "membership_id", "id", "membershipId") === chosenMembershipId
      );
      expect(
        afterTarget,
        `membership ${chosenMembershipId} missing from members list after mutation`
      ).toBeTruthy();
      const afterRoleId = pick<string | number>(afterTarget!, "role_id", "roleId");
      expect(
        afterRoleId,
        `expected role_id=${newRoleId} after mutation, got ${afterRoleId} (member=${JSON.stringify(afterTarget).slice(0, 300)})`
      ).toBe(newRoleId);
    } finally {
      if (restore) await restore();
      await ctx.close();
    }
  });
});
