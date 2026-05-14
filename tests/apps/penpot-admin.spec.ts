import { test, expect } from "../../fixtures";
import { request, BrowserContext } from "@playwright/test";
import { APP_URLS } from "../../constants";

const BASE = APP_URLS.Penpot;

// Penpot has no /admin URL. Admin is a *state* of a profile with respect
// to a team: the role lives on the team_profile_rel row, and the
// permission gate is enforced server-side inside the RPC handler
// `update-team-member-role` (backend/src/app/rpc/commands/teams.clj,
// schema requires :team-id, :member-id, :role ∈ {:owner :admin :editor
// :viewer}, gated on `(or is-owner is-admin)`).
//
// FOSS_USER (worker fixture, == User A per sso-rules/admin.md) is Owner
// of their own Default team; User B is Editor on that same team
// (Penpot/admin.md tied a 2-member fixture to the same workspace so
// admin UI scenarios can be exercised).
//
// What this spec verifies, end-to-end:
//   • The admin can mutate User B's role through the RPC and observe
//     the change in a re-fetched member list.
//   • The change is reversible — we restore the original role in a
//     finally block.
//
// Implementation notes:
//   • Penpot RPC responses default to Transit-JSON but accept
//     `Accept: application/json` and then return camelCase plain
//     JSON. We use JSON throughout — the Transit decoders have to
//     handle reference syntax (`^0`, `^1`, …) and nested permissions
//     which adds complexity for no benefit on the test side.
//   • For writes, the documented Content-Type is
//     `application/transit+json`. We've found POST with
//     `application/json` and snake-case-friendly keys also works for
//     `update-team-member-role`.

async function cookieHeaderFor(ctx: BrowserContext, baseUrl: string): Promise<string> {
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function rpcGet<T = unknown>(cookieHeader: string, command: string): Promise<T> {
  const ctx = await request.newContext({
    extraHTTPHeaders: { cookie: cookieHeader, accept: "application/json" },
  });
  try {
    const res = await ctx.get(`${BASE}/api/rpc/command/${command}`, { maxRedirects: 0 });
    if (!res.ok()) {
      throw new Error(`GET ${command} → ${res.status()}: ${(await res.text()).slice(0, 300)}`);
    }
    return (await res.json()) as T;
  } finally {
    await ctx.dispose();
  }
}

async function rpcPost(
  cookieHeader: string,
  command: string,
  body: Record<string, string>
): Promise<{ status: number; body: unknown }> {
  const ctx = await request.newContext({
    extraHTTPHeaders: {
      cookie: cookieHeader,
      "content-type": "application/json",
      accept: "application/json",
    },
  });
  try {
    const res = await ctx.post(`${BASE}/api/rpc/command/${command}`, {
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

// Penpot get-teams response (Accept: application/json):
//   [{
//     id, name, modifiedAt, createdAt, isDefault, features: […],
//     permissions: { type, isOwner, isAdmin, canEdit }
//   }, …]
type PenpotTeam = {
  id: string;
  name: string;
  isDefault: boolean;
  permissions: { isOwner: boolean; isAdmin: boolean; canEdit: boolean };
};

// Penpot get-team-members response:
//   [{
//     id, profileId, teamId, email, name, fullname,
//     isOwner, isAdmin, canEdit, isActive, modifiedAt, createdAt
//   }, …]
// Note: `id` and `profileId` are the same value in practice — both
// point at the profile row. update-team-member-role wants member-id
// = that profile-id.
type PenpotMember = {
  id: string;
  profileId: string;
  email: string;
  isOwner: boolean;
  isAdmin: boolean;
  canEdit: boolean;
};

test.describe("Penpot — admin mutates team-member role via RPC", () => {
  test("admin can promote a teammate and restore the original role", async ({
    context,
  }) => {
    test.setTimeout(120_000);

    let restore: (() => Promise<void>) | null = null;

    try {
      // (1) Use the SSO cookie directly — Penpot's RPC accepts it via
      //     ForwardAuth without first landing on the SPA (same pattern
      //     as tests/auth/identity-consistency.spec.ts). Avoids the
      //     SPA's hash-route redirect chain that times out goto.
      const cookieHeader = await cookieHeaderFor(context, BASE);

      // (2) Resolve the admin's own profile id (to avoid mutating self).
      const profile = await rpcGet<{ id: string }>(cookieHeader, "get-profile");
      const selfId = profile.id;
      expect(selfId, "admin profile must have an id").toBeTruthy();

      // (3) Find a team where the admin is owner or admin. get-teams
      //     returns ONLY teams the user is a member of — typically just
      //     their own Default team, but we iterate to be robust.
      const teams = await rpcGet<PenpotTeam[]>(cookieHeader, "get-teams");
      const adminTeam = teams.find(
        (t) => t.permissions?.isOwner === true || t.permissions?.isAdmin === true
      );
      test.skip(
        !adminTeam,
        `FOSS_USER is not owner/admin on any Penpot team — nothing to mutate. teams=${JSON.stringify(teams).slice(0, 300)}`
      );

      const teamId = adminTeam!.id;

      // (4) Pull members and find a non-self non-owner target.
      const members = await rpcGet<PenpotMember[]>(
        cookieHeader,
        `get-team-members?team-id=${teamId}`
      );
      const target = members.find((m) => m.id !== selfId && m.isOwner !== true);
      test.skip(
        !target,
        `team ${teamId} has no member safe to mutate (need a non-self, non-owner). ` +
          `members=${JSON.stringify(members).slice(0, 400)}`
      );

      // Reconstruct the original role from is-owner/is-admin/can-edit
      // booleans (Penpot encodes role as those three flags rather than
      // a single string).
      const originalRole: string = target!.isOwner
        ? "owner"
        : target!.isAdmin
        ? "admin"
        : target!.canEdit === false
        ? "viewer"
        : "editor";

      // Pick a target role that's actually a change. Never set :owner
      // (transfer is a separate, riskier operation).
      const newRole = originalRole === "admin" ? "editor" : "admin";

      // (5) Stage the restore step BEFORE mutating so the finally block
      //     puts the role back even if verification throws.
      restore = async () => {
        const { status, body } = await rpcPost(cookieHeader, "update-team-member-role", {
          "team-id": teamId,
          "member-id": target!.id,
          role: originalRole,
        });
        if (status >= 400) {
          // eslint-disable-next-line no-console
          console.error(
            `Penpot admin spec: FAILED TO RESTORE role for member ${target!.id} on team ${teamId}. ` +
              `status=${status} body=${JSON.stringify(body).slice(0, 300)}`
          );
        }
      };

      // (6) Promote / demote.
      const mutate = await rpcPost(cookieHeader, "update-team-member-role", {
        "team-id": teamId,
        "member-id": target!.id,
        role: newRole,
      });
      expect(
        mutate.status,
        `update-team-member-role to ${newRole} returned ${mutate.status}: ` +
          `${JSON.stringify(mutate.body).slice(0, 300)}`
      ).toBeLessThan(400);

      // (7) Verify via a fresh get-team-members.
      const afterMembers = await rpcGet<PenpotMember[]>(
        cookieHeader,
        `get-team-members?team-id=${teamId}`
      );
      const afterTarget = afterMembers.find((m) => m.id === target!.id);
      expect(afterTarget, "target member missing from members list after mutation").toBeTruthy();

      if (newRole === "admin") {
        expect(
          afterTarget!.isAdmin,
          `expected isAdmin=true after promoting to admin, got member=${JSON.stringify(afterTarget).slice(0, 300)}`
        ).toBe(true);
      } else if (newRole === "editor") {
        expect(
          afterTarget!.isAdmin,
          `expected isAdmin=false after demoting to editor, got member=${JSON.stringify(afterTarget).slice(0, 300)}`
        ).toBe(false);
      }
    } finally {
      if (restore) await restore();
    }
  });
});
