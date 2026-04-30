// All environment-specific values are read from process.env with safe defaults
// so the suite still runs against the production FOSS platform out of the box.
// To target a different deployment (staging, ephemeral, local), override via .env.

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
// Hosts
// ---------------------------------------------------------------------------

export const MAIN_URL          = env("FOSS_BASE_URL",       "https://foss.arbisoft.com");
export const AUTH_PROXY_DOMAIN = env("FOSS_AUTH_PROXY",     "foss-auth.arbisoft.com");
export const COGNITO_DOMAIN    = env("FOSS_COGNITO_DOMAIN", "amazoncognito.com");
export const MPASS_IDP_DOMAIN  = env("FOSS_MPASS_DOMAIN",   "moneta-auth.sandbox.pressingly.net");
export const AUTH_COOKIE       = env("FOSS_AUTH_COOKIE",    "_oauth2_proxy");

// External IDP hosts the oauth2-proxy can hand off to (Cognito or mPass).
// Defaults to both known IDPs; override with comma-separated FOSS_IDP_HOSTS.
export const IDP_HOSTS = csv(
  "FOSS_IDP_HOSTS",
  `${COGNITO_DOMAIN},${MPASS_IDP_DOMAIN}`
);

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export const APP_URLS = {
  Outline:   env("FOSS_APP_OUTLINE",   "https://foss-docs.arbisoft.com"),
  PM:        env("FOSS_APP_PM",        "https://foss-pm.arbisoft.com"),
  Penpot:    env("FOSS_APP_PENPOT",    "https://foss-design.arbisoft.com"),
  SurfSense: env("FOSS_APP_SURFSENSE", "https://foss-research.arbisoft.com"),
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

// Regex matching any FOSS app host or main portal — i.e. the post-login domains.
// Built from MAIN_URL + APP_URLS so it stays in sync if those move.
export const FOSS_HOST_REGEX = (() => {
  const hosts = [MAIN_URL, ...Object.values(APP_URLS)].map((u) => new URL(u).hostname);
  const escaped = [...new Set(hosts)].map((h) => h.replace(/\./g, "\\."));
  return new RegExp(`^https://(${escaped.join("|")})`);
})();
