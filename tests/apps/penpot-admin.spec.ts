import { test, expect } from "../../fixtures";
import { request, BrowserContext } from "@playwright/test";
import { APP_URLS } from "../../constants";
import { extractPenpotTransitField } from "../lib/penpot-transit";

const BASE = APP_URLS.Penpot;

// FOSS_USER (worker fixture identity) is the admin per sso-rules/admin.md
// — Owner of their own Penpot Default team. No dedicated PENPOT_ADMIN_USER
// env var needed; the worker fixture's session has the right cookies.

// Penpot has no /admin URL. Admin is a *state* of a profile with respect
// to a team: the role lives on the team_profile_rel row, and the
// permission gate is enforced server-side inside the RPC handler
// `update-team-member-role` (backend/src/app/rpc/commands/teams.clj,
// schema requires :team-id, :member-id, :role ∈ {:owner :admin :editor
// :viewer}, gated on `(or is-owner is-admin)`).
//
// What this spec verifies, end-to-end:
//   • An SSO-authed Penpot admin user can mutate a teammate's role
//     through the RPC and observe the change.
//   • The change is reversible — we restore the original role in a
//     finally block so the deployment is left as we found it.
//
// Why this matters: the role gate is the *only* thing standing between
// any team member and the admin surface (rename team, add/remove
// members, change permissions, transfer ownership). If the gate breaks
// open, every team member is effectively an admin. If it breaks shut,
// the admin can't manage the team they own. Either failure is silent
// without a contract test pinning the round-trip.

// ---------------------------------------------------------------------------
// Transit-JSON helpers — Penpot RPC requests/responses use Transit JSON.
// We already have a response extractor in tests/lib/penpot-transit.ts;
// here we add the encoder for request bodies and a wrapper for POSTs.
// ---------------------------------------------------------------------------

type TransitValue = string | number | boolean | null | TransitValue[] | { [k: string]: TransitValue };

// Encode a plain JS object into Penpot's Transit-JSON "map" form:
//   { teamId: "...", role: "admin" }
//   → ["^ ", "~:team-id", "...", "~:role", "~:admin"]
// Keys are converted from camelCase to :kebab-case keywords; string
// values whose field name is "role" are wrapped as keyword (since
// Penpot's schema requires keyword role values). Everything else is
// passed through as-is.
function toTransitMap(obj: Record<string, string | boolean | number>): TransitValue[] {
  const out: TransitValue[] = ["^ "];
  for (const [k, v] of Object.entries(obj)) {
    const kebab = k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase());
    out.push(`~:${kebab}`);
    if (k === "role" && typeof v === "string") {
      out.push(`~:${v}`);
    } else {
      out.push(v as TransitValue);
    }
  }
  return out;
}

async function cookieHeaderFor(ctx: BrowserContext, baseUrl: string): Promise<string> {
  const cookies = await ctx.cookies(baseUrl);
  return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
}

async function rpcGet(cookieHeader: string, command: string): Promise<unknown> {
  const ctx = await request.newContext({
    extraHTTPHeaders: { cookie: cookieHeader },
  });
  try {
    const res = await ctx.get(`${BASE}/api/rpc/command/${command}`, { maxRedirects: 0 });
    if (!res.ok()) {
      throw new Error(`GET ${command} → ${res.status()}: ${(await res.text()).slice(0, 300)}`);
    }
    return await res.json();
  } finally {
    await ctx.dispose();
  }
}

async function rpcPost(
  cookieHeader: string,
  command: string,
  body: Record<string, string | boolean | number>
): Promise<{ status: number; body: unknown }> {
  const ctx = await request.newContext({
    extraHTTPHeaders: {
      cookie: cookieHeader,
      "content-type": "application/transit+json",
    },
  });
  try {
    const res = await ctx.post(`${BASE}/api/rpc/command/${command}`, {
      data: JSON.stringify(toTransitMap(body)),
      maxRedirects: 0,
    });
    // Don't throw on non-2xx — caller wants to inspect status (e.g.
    // assert :insufficient-permissions came back as a 4xx, not a 5xx).
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

// ---------------------------------------------------------------------------
// Transit array shape walker — get-teams / get-team-members responses are
// arrays of Transit maps. Find the value at a key inside a Transit map,
// and walk a list of maps.
// ---------------------------------------------------------------------------

function transitMapGet(map: unknown, key: `~:${string}`): unknown {
  if (!Array.isArray(map) || map[0] !== "^ ") return undefined;
  for (let i = 1; i < map.length; i += 2) {
    if (map[i] === key) return map[i + 1];
  }
  return undefined;
}

function transitListOfMaps(body: unknown): unknown[] {
  // Penpot wraps lists either as a bare JSON array of Transit maps, or
  // under a `~:result` key in an outer Transit map. Try both.
  if (Array.isArray(body)) {
    if (body[0] === "^ ") {
      // Outer map — look for ~:result.
      const result = transitMapGet(body, "~:result");
      return Array.isArray(result) ? (result as unknown[]) : [];
    }
    return body as unknown[];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

test.describe("Penpot — admin mutates team-member role via RPC", () => {
  test("admin can promote a teammate and restore the original role", async ({
    context,
    page,
  }) => {
    test.setTimeout(120_000);

    let restore: (() => Promise<void>) | null = null;

    try {
      // (1) Land on Penpot so the app issues its own session cookie on
      //     top of the SSO cookie already in the worker fixture state.
      await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });

      const cookieHeader = await cookieHeaderFor(context, BASE);

      // (2) Resolve the admin's own profile-id so we can avoid mutating
      //     ourselves.
      const profile = await rpcGet(cookieHeader, "get-profile");
      const selfId = extractPenpotTransitField(profile, "~:id");
      expect(selfId, "admin profile must have an id").toBeTruthy();

      // (3) Find a team where the admin is owner or admin.
      const teamsResp = await rpcGet(cookieHeader, "get-teams");
      const teams = transitListOfMaps(teamsResp);
      const adminTeam = teams.find((t) => {
        const isOwner = transitMapGet(t, "~:is-owner");
        const isAdmin = transitMapGet(t, "~:is-admin");
        return isOwner === true || isAdmin === true;
      });
      test.skip(
        !adminTeam,
        `FOSS_USER is not owner/admin on any Penpot team — nothing to mutate. teams=${JSON.stringify(teams).slice(0, 300)}`
      );

      const teamId = transitMapGet(adminTeam!, "~:id") as string;
      expect(teamId, "admin team must have an id").toBeTruthy();

      // (4) Pull team members and find a *safe* mutation target:
      //     someone who isn't the admin themselves and isn't the owner.
      const membersResp = await rpcGet(cookieHeader, `get-team-members?team-id=${teamId}`);
      const members = transitListOfMaps(membersResp);
      const target = members.find((m) => {
        const id = transitMapGet(m, "~:id");
        const isOwner = transitMapGet(m, "~:is-owner");
        return id !== selfId && isOwner !== true;
      });
      test.skip(
        !target,
        `team ${teamId} has no member safe to mutate (need a non-self, non-owner). members=${JSON.stringify(members).slice(0, 300)}`
      );

      const memberId = transitMapGet(target!, "~:id") as string;
      // Penpot's team-member shape encodes the role across is-admin /
      // is-owner booleans rather than a single role string. Reconstruct
      // an :editor | :admin | :viewer | :owner keyword from those flags.
      const isAdminFlag = transitMapGet(target!, "~:is-admin") === true;
      const isOwnerFlag = transitMapGet(target!, "~:is-owner") === true;
      const canEdit = transitMapGet(target!, "~:can-edit");
      const originalRole: string = isOwnerFlag
        ? "owner"
        : isAdminFlag
        ? "admin"
        : canEdit === false
        ? "viewer"
        : "editor";

      // Pick a target role that's actually a change. Never set :owner
      // (transfer is a separate, riskier operation).
      const newRole = originalRole === "admin" ? "editor" : "admin";

      // (5) Stage the restore step BEFORE we mutate, so even if the
      //     verify step throws, the finally block puts the role back.
      restore = async () => {
        const { status, body } = await rpcPost(cookieHeader, "update-team-member-role", {
          teamId,
          memberId,
          role: originalRole,
        });
        // Don't fail the restore if it 4xx's — log so a human can intervene.
        if (status >= 400) {
          // eslint-disable-next-line no-console
          console.error(
            `Penpot admin spec: FAILED TO RESTORE role for member ${memberId} on team ${teamId}. status=${status} body=${JSON.stringify(body).slice(0, 300)}`
          );
        }
      };

      // (6) Promote/demote.
      const mutate = await rpcPost(cookieHeader, "update-team-member-role", {
        teamId,
        memberId,
        role: newRole,
      });
      expect(
        mutate.status,
        `update-team-member-role to ${newRole} returned ${mutate.status}: ${JSON.stringify(mutate.body).slice(0, 300)}`
      ).toBeLessThan(400);

      // (7) Verify via a fresh get-team-members.
      const afterResp = await rpcGet(cookieHeader, `get-team-members?team-id=${teamId}`);
      const afterMembers = transitListOfMaps(afterResp);
      const afterTarget = afterMembers.find(
        (m) => transitMapGet(m, "~:id") === memberId
      );
      expect(afterTarget, "target member missing from members list after mutation").toBeTruthy();

      const afterIsAdmin = transitMapGet(afterTarget!, "~:is-admin") === true;
      if (newRole === "admin") {
        expect(
          afterIsAdmin,
          `expected ~:is-admin=true after promoting to admin, got member=${JSON.stringify(afterTarget).slice(0, 300)}`
        ).toBe(true);
      } else if (newRole === "editor") {
        expect(
          afterIsAdmin,
          `expected ~:is-admin=false after demoting to editor, got member=${JSON.stringify(afterTarget).slice(0, 300)}`
        ).toBe(false);
      }
    } finally {
      if (restore) await restore();
    }
  });
});
