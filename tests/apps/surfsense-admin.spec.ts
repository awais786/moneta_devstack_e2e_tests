import { test, expect } from "../../fixtures";
import { request, BrowserContext } from "@playwright/test";
import { APP_URLS } from "../../constants";

const BASE = APP_URLS.SurfSense;

// SurfSense has no global admin — `is_superuser=False` is hard-coded for
// proxy-auth users (surfsense_backend/app/middleware/proxy_auth.py:131).
// Admin is per-SearchSpace via three system roles: Owner / Editor /
// Viewer. Member-management is gated on the actor's role permissions
// including `members:manage_roles` (Owner-only by default).
//
// FOSS_USER (worker fixture, == User A) is Owner of SearchSpace #7;
// User B was DB-INSERTed as Editor on the same space. The mutation
// test flips User B's role and restores it in a finally block.
//
// Endpoint shape (probed against the foss sandbox):
//   • GET  /api/v1/searchspaces                — array of {id, name, user_id, is_owner, …}
//   • GET  /api/v1/searchspaces/<id>/members   — array of memberships, each {id, user_id, role_id, is_owner, role: {…}, user_email}
//   • GET  /api/v1/searchspaces/<id>/roles     — array of role rows for that space
//   • PUT  /api/v1/searchspaces/<id>/members/<membership-id>  — body {role_id}
// The sso-rules skill's `/api/rbac/...` path is from upstream; this
// fork mounts everything under `/api/v1/`.

async function cookieHeaderFor(ctx: BrowserContext, baseUrl: string): Promise<string> {
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function apiGet<T = unknown>(
  cookieHeader: string,
  path: string
): Promise<{ status: number; body: T | string }> {
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

type SurfSpace = { id: number; name: string; user_id: string; is_owner: boolean };
type SurfRole = { id: number; name: string; search_space_id: number };
type SurfMember = {
  id: number; // membership id
  user_id: string;
  search_space_id: number;
  role_id: number;
  is_owner: boolean;
  role: { id: number; name: string };
  user_email?: string;
};

test.describe("SurfSense — Owner mutates teammate role via RBAC API", () => {
  test("Owner can promote a teammate and restore the original role", async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);

    let restore: (() => Promise<void>) | null = null;

    try {
      // (1) Land on SurfSense so it issues its own session cookie.
      //     domcontentloaded — the SurfSense SPA keeps long-poll /
      //     subscription connections open and never hits networkidle.
      await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 30000 });

      const cookieHeader = await cookieHeaderFor(context, BASE);

      // (2) Resolve the admin's own user-id.
      const me = await apiGet<{ id?: string }>(cookieHeader, "/users/me");
      expect(me.status, `GET /users/me returned ${me.status}: ${JSON.stringify(me.body).slice(0, 200)}`).toBeLessThan(400);
      const selfId = typeof me.body === "object" && me.body !== null ? (me.body as { id?: string }).id : undefined;
      expect(selfId, "SurfSense /users/me must expose an id").toBeTruthy();

      // (3) Discover SearchSpaces.
      const spaces = await apiGet<SurfSpace[]>(cookieHeader, "/api/v1/searchspaces");
      expect(
        spaces.status,
        `GET /api/v1/searchspaces returned ${spaces.status}: ${JSON.stringify(spaces.body).slice(0, 200)}`
      ).toBeLessThan(400);
      const spaceList = Array.isArray(spaces.body) ? spaces.body : [];
      test.skip(
        spaceList.length === 0,
        `SurfSense Owner has no SearchSpaces visible. body=${JSON.stringify(spaces.body).slice(0, 300)}`
      );

      // (4) Find a space + safe target (non-self, non-Owner) + a role to flip to.
      let chosenSpaceId: number | undefined;
      let chosenMembershipId: number | undefined;
      let originalRoleId: number | undefined;
      let newRoleId: number | undefined;

      for (const space of spaceList) {
        const spaceId = space.id;

        const membersResp = await apiGet<SurfMember[]>(
          cookieHeader,
          `/api/v1/searchspaces/${spaceId}/members`
        );
        if (membersResp.status >= 400) continue;
        const members = Array.isArray(membersResp.body) ? membersResp.body : [];

        const rolesResp = await apiGet<SurfRole[]>(
          cookieHeader,
          `/api/v1/searchspaces/${spaceId}/roles`
        );
        if (rolesResp.status >= 400) continue;
        const roles = Array.isArray(rolesResp.body) ? rolesResp.body : [];

        // Identify Owner role to exclude as a target *and* as a flip target.
        const ownerRole = roles.find(
          (r) => typeof r.name === "string" && r.name.toLowerCase() === "owner"
        );
        const ownerRoleId = ownerRole?.id;

        // Safe target: not self, not Owner.
        const target = members.find(
          (m) => m.user_id !== selfId && m.is_owner !== true && m.role_id !== ownerRoleId
        );
        if (!target) continue;

        // Pick *any other* non-Owner role to flip to.
        const flipTo = roles.find((r) => r.id !== target.role_id && r.id !== ownerRoleId);
        if (!flipTo) continue;

        chosenSpaceId = spaceId;
        chosenMembershipId = target.id;
        originalRoleId = target.role_id;
        newRoleId = flipTo.id;
        break;
      }

      test.skip(
        chosenSpaceId === undefined,
        "No SearchSpace had a non-self non-Owner member with a flippable role."
      );

      // (5) Stage restore before mutating.
      restore = async () => {
        const res = await apiPut(
          cookieHeader,
          `/api/v1/searchspaces/${chosenSpaceId}/members/${chosenMembershipId}`,
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
        `/api/v1/searchspaces/${chosenSpaceId}/members/${chosenMembershipId}`,
        { role_id: newRoleId }
      );
      expect(
        mutate.status,
        `PUT role_id=${newRoleId} returned ${mutate.status}: ${JSON.stringify(mutate.body).slice(0, 300)}`
      ).toBeLessThan(400);

      // (7) Verify via a fresh members fetch.
      const afterResp = await apiGet<SurfMember[]>(
        cookieHeader,
        `/api/v1/searchspaces/${chosenSpaceId}/members`
      );
      expect(afterResp.status).toBeLessThan(400);
      const afterMembers = Array.isArray(afterResp.body) ? afterResp.body : [];
      const afterTarget = afterMembers.find((m) => m.id === chosenMembershipId);
      expect(
        afterTarget,
        `membership ${chosenMembershipId} missing from members list after mutation`
      ).toBeTruthy();
      expect(
        afterTarget!.role_id,
        `expected role_id=${newRoleId} after mutation, got ${afterTarget!.role_id} ` +
          `(member=${JSON.stringify(afterTarget).slice(0, 300)})`
      ).toBe(newRoleId);
    } finally {
      if (restore) await restore();
    }
  });
});
