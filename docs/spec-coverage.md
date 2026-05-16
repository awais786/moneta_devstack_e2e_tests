# SSO Contract → E2E Coverage Matrix

Traceability matrix between [awais786/sso-rules-moneta openspec contract](https://github.com/awais786/sso-rules-moneta/tree/main/openspec/specs) and this Playwright suite. Each requirement maps to either a covering test, a documented partial, or a deferred entry in [spec-coverage-deferred.md](spec-coverage-deferred.md).

**How to update:** when a new spec requirement lands upstream, either add a covering test with a `// @spec <module>#<requirement-slug>` tag above the `test()` call, or add an entry to `spec-coverage-deferred.md` explaining why it's not testable in this suite. `scripts/check-spec-coverage.sh` enforces that every requirement is in one column or the other.

**Legend:**
- ✅ Full — assertion directly pins the behaviour
- 🟡 Partial — covered indirectly or with a documented limitation
- ⚠️ Deferred — see [spec-coverage-deferred.md](spec-coverage-deferred.md) for rationale

---

## proxy-auth-middleware

| Requirement | Coverage | Test |
|---|---|---|
| Bypass paths SHALL short-circuit before any auth processing | ✅ | `tests/security/bypass-surface.spec.ts`, `tests/apps/pm-godmode.spec.ts` |
| Authenticated sessions with matching or absent proxy identity SHALL short-circuit | ⚠️ Deferred | — |
| Identity mismatch SHALL flush the existing session immediately | ✅ | `tests/flows/identity-switch-after-relogin.spec.ts` |
| Unauthenticated requests with a valid proxy identity SHALL auto-provision and log in | ✅ | `tests/auth/sso-login.spec.ts` |
| Email normalisation SHALL be applied uniformly | 🟡 Partial | `tests/auth/identity-consistency.spec.ts` (pins final email, not normalisation rules) |
| Concurrent creation races SHALL fall back to read | ⚠️ Deferred | — |
| email-shape detection on header values SHALL avoid polynomial-backtracking regex | ⚠️ Deferred | — (per-fork `sso-audit.sh` Row 21 catches static regression) |

## oauth2-proxy-gateway

| Requirement | Coverage | Test |
|---|---|---|
| gateway SHALL run as a single dedicated service | 🟡 Partial | `tests/security/bypass-surface.spec.ts` (every protected path hits the same gateway) |
| gateway SHALL use OIDC Discovery against the Cognito issuer | ⚠️ Deferred | — |
| cookie domain SHALL be the platform parent domain | ✅ | `tests/auth/session-sharing.spec.ts`, `tests/auth/sso-login.spec.ts` |
| gateway SHALL emit X-Auth-Request-* headers on authenticated responses | ✅ | `tests/auth/identity-consistency.spec.ts` |
| cookie secret SHALL be 32 random bytes, base64-encoded | ⚠️ Deferred | — |
| gateway SHALL use a redis-backed session store | ⚠️ Deferred | — |
| gateway SHALL pass access token to downstream apps when requested | ⚠️ Deferred | — |
| gateway SHALL use the configurable identity claim | ⚠️ Deferred | — |
| single shared callback URL | ⚠️ Deferred | — |

## forwardauth-traefik

| Requirement | Coverage | Test |
|---|---|---|
| a single mpass-auth middleware SHALL be defined on the oauth2-proxy service | 🟡 Partial | `tests/security/header-spoofing.spec.ts` (auth gate) |
| every protected app router SHALL apply mpass-auth | ✅ | `tests/security/header-spoofing.spec.ts` |
| bypass paths SHALL route via higher-priority routers without mpass-auth | ✅ | `tests/security/bypass-surface.spec.ts`, `tests/security/strip-on-bypass.spec.ts` |
| bypass routes per app SHALL match the documented list | ✅ | `tests/security/bypass-surface.spec.ts`, `tests/apps/pm-godmode.spec.ts` |
| header overwrite SHALL be enforced | ✅ | `tests/security/header-spoofing.spec.ts` (with documented partial — see file comment) |
| backend ports SHALL be bound to 127.0.0.1 only | ⚠️ Deferred | — (infra-level; not reachable from CI) |
| auth-response headers SHALL include exactly the three required headers | ⚠️ Deferred | — |

## session-lifecycle

| Requirement | Coverage | Test |
|---|---|---|
| the system SHALL maintain two distinct session layers | ✅ | `tests/auth/sso-login.spec.ts`, `tests/auth/session-sharing.spec.ts` |
| Layer 1 SHALL refresh transparently against OIDC | ⚠️ Deferred | — |
| Layer 1 expiry while Layer 2 is valid SHALL re-auth transparently | ⚠️ Deferred | — |
| Layer 2 expiry while Layer 1 is valid SHALL re-establish session from headers | ⚠️ Deferred | — |
| simultaneous expiry of both layers SHALL redirect to mPass login | 🟡 Partial | `tests/auth/session-lifecycle.spec.ts` (cookie deletion proxies for expiry) |
| mPass-side session revocation SHALL be honoured on next refresh | ⚠️ Deferred | — |
| per-app session TTLs SHALL be uniformly configurable | ⚠️ Deferred | — (config-level, not behavioural) |
| Layer-2 session renewal SHALL be guarded against three regression paths | ⚠️ Deferred | — |
| bridge state TTL SHALL be 3 minutes | ⚠️ Deferred | — |

## cognito-claim-mapping

| Requirement | Coverage | Test |
|---|---|---|
| standard claim → header mapping | ✅ | `tests/auth/identity-consistency.spec.ts` |
| identity claim SHALL be configurable when email is unreliable | ⚠️ Deferred | — |
| claim mapping SHALL be the same across the cookie flow and the JWT-bearer flow | ⚠️ Deferred | — |
| id_token vs access_token audience claim SHALL both be accepted | ⚠️ Deferred | — |
| display name SHALL be derived without round-trip when possible | ⚠️ Deferred | — |

## logout-flow

| Requirement | Coverage | Test |
|---|---|---|
| per-app "Logout" SHALL be navigation-only | 🟡 Partial | `tests/flows/login-logout-flow.spec.ts` (covers main portal logout flow; per-app navigation-only invariant inferred) |
| per-app "Logout" SHALL NOT be relied on for security | ⚠️ Deferred | — (negative policy; verified by reasoning, not test) |
| portal "logout all" SHALL clear only the _oauth2_proxy cookie | ✅ | `tests/auth/session-lifecycle.spec.ts` |
| stale app-native sessions SHALL be reaped on next request, not eagerly | ✅ | `tests/auth/session-lifecycle.spec.ts` ("deleting cookie locks every app") |
| Cognito SSO teardown is operator-callable but not surfaced as a user action | ⚠️ Deferred | — (operator-only, not user-facing) |
| logout SHALL be observable and idempotent | 🟡 Partial | `tests/auth/session-lifecycle.spec.ts` (cookie replay test) |
| Cognito allowlist SHALL include the portal main page | ⚠️ Deferred | — (Cognito-side config, not reachable from CI) |

## workspace-auto-join

| Requirement | Coverage | Test |
|---|---|---|
| auto-join SHALL run on every login, not just on user creation | ⚠️ Deferred | — |
| auto-join SHALL skip when no workspace exists yet | ⚠️ Deferred | — |
| auto-join target SHALL be the oldest workspace | ⚠️ Deferred | — |
| auto-join role SHALL be the app's regular-member role, not Admin or Guest | ⚠️ Deferred | — |
| auto-join SHALL mark onboarding complete on the user profile | ⚠️ Deferred | — |
| per-app workspace model SHALL be documented in workspaces.md | ⚠️ Deferred | — (doc requirement, not behavioural) |
| auto-join SHALL NOT leak across apps | ⚠️ Deferred | — |

---

## Adding new coverage

When you write a new test that pins a spec requirement, add a one-line tag immediately above the `test()` call:

```ts
// @spec proxy-auth-middleware#identity-mismatch-shall-flush
test("user switch reflects in /me on next request", async ({ context }) => {
  // ...
});
```

The slug is the requirement title, lowercased, with `SHALL`/`SHALL NOT`/etc. preserved literally and non-alphanumerics collapsed to `-`. Match the format already used in [scripts/check-spec-coverage.sh](../scripts/check-spec-coverage.sh) — when you add a tag the script's coverage count goes up automatically; no doc edit needed.

When you can't write a test (infra-only, Cognito-side, policy-level), add an entry to [spec-coverage-deferred.md](spec-coverage-deferred.md) instead.
