// ---------------------------------------------------------------------------
// Environment configuration
// ---------------------------------------------------------------------------
// Single source of truth: FOSS_BASE_URL (the main portal). Everything else
// — per-app hosts, ForwardAuth host, cookie domain — is derived from it
// using the FOSS naming convention:
//
//   FOSS_BASE_URL           = https://foss.<domain>
//   ForwardAuth host        = foss-auth.<domain>
//   Outline (Docs)          = https://foss-docs.<domain>
//   Plane (PM)              = https://foss-pm.<domain>
//   Penpot (Design)         = https://foss-design.<domain>
//   SurfSense (Research)    = https://foss-research.<domain>
//   Cookie domain           = <domain>
//
// Pointing the suite at a different deployment is a one-line .env change:
//   FOSS_BASE_URL=https://foss.example.com
//
// IDP hosts (Cognito + mPass) genuinely differ between deployments and are
// kept as separate env vars (FOSS_COGNITO_DOMAIN, FOSS_MPASS_DOMAIN).
// ---------------------------------------------------------------------------

const env = (key: string, fallback: string): string => {
  const v = process.env[key]?.trim();
  return v && v.length > 0 ? v : fallback;
};

const csv = (key: string, fallback: string): string[] =>
  env(key, fallback)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// ---------------------------------------------------------------------------
// Hosts (derived from MAIN_URL)
// ---------------------------------------------------------------------------

export const MAIN_URL = env("FOSS_BASE_URL", "https://foss.arbisoft.com");

// Derive the platform domain by stripping the leading subdomain label:
//   foss.arbisoft.com → arbisoft.com
//   foss.example.com  → example.com
const PLATFORM_DOMAIN = (() => {
  const host = new URL(MAIN_URL).hostname;
  const labels = host.split(".");
  if (labels.length < 2) {
    throw new Error(
      `FOSS_BASE_URL hostname "${host}" must have at least two labels (e.g. foss.example.com)`
    );
  }
  return labels.slice(1).join(".");
})();

const SCHEME = new URL(MAIN_URL).protocol; // "https:" usually

const sub = (prefix: string): string => `${SCHEME}//${prefix}.${PLATFORM_DOMAIN}`;

export const AUTH_PROXY_DOMAIN = `foss-auth.${PLATFORM_DOMAIN}`;
export const COOKIE_DOMAIN     = PLATFORM_DOMAIN;

export const COOKIE_DOMAIN_REGEX = new RegExp(
  `\\.${COOKIE_DOMAIN.replace(/\./g, "\\.")}$`
);

export const AUTH_COOKIE = env("FOSS_AUTH_COOKIE", "_oauth2_proxy");

// IDPs vary by deployment — sandbox uses mPass on pressingly.net, prod will
// likely use a different mPass host. Cognito domain is generic AWS infra.
export const COGNITO_DOMAIN   = env("FOSS_COGNITO_DOMAIN", "amazoncognito.com");
export const MPASS_IDP_DOMAIN = env("FOSS_MPASS_DOMAIN",   "moneta-auth.sandbox.pressingly.net");

export const IDP_HOSTS = csv(
  "FOSS_IDP_HOSTS",
  `${COGNITO_DOMAIN},${MPASS_IDP_DOMAIN}`
);

// ---------------------------------------------------------------------------
// Apps (derived from PLATFORM_DOMAIN)
// ---------------------------------------------------------------------------

export const APP_URLS = {
  Outline:   sub("foss-docs"),
  PM:        sub("foss-pm"),
  Penpot:    sub("foss-design"),
  SurfSense: sub("foss-research"),
} as const;

export type AppName = keyof typeof APP_URLS;

export const APPS: ReadonlyArray<{ name: AppName; url: string }> =
  (Object.entries(APP_URLS) as [AppName, string][]).map(([name, url]) => ({
    name,
    url,
  }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function isAuthWall(url: string): boolean {
  return url.includes(AUTH_PROXY_DOMAIN) || IDP_HOSTS.some((h) => url.includes(h));
}

// Regex matching any IDP host (escaped). Used by login flow to detect the IDP step.
export const IDP_REGEX = new RegExp(
  IDP_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|")
);

// Regex matching any FOSS app host or main portal — the post-login domains.
// Built from MAIN_URL + APP_URLS so it stays in sync.
export const FOSS_HOST_REGEX = (() => {
  const hosts = [MAIN_URL, ...Object.values(APP_URLS)].map((u) => new URL(u).hostname);
  const escaped = [...new Set(hosts)].map((h) => h.replace(/\./g, "\\."));
  return new RegExp(`^https://(${escaped.join("|")})`);
})();
