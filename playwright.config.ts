import { defineConfig, devices } from "@playwright/test";
import * as dotenv from "dotenv";

dotenv.config();

const BASE_URL = process.env.FOSS_BASE_URL?.trim() || "https://foss.arbisoft.com";
const defaultSlowMo = process.env.CI ? "0" : "2000";
const parsedSlowMo = Number(process.env.PW_SLOW_MO_MS ?? defaultSlowMo);
const SLOW_MO_MS = Number.isFinite(parsedSlowMo) && parsedSlowMo >= 0 ? parsedSlowMo : 2000;

// Browser selection
//   default          → chromium only (fast local + CI smoke)
//   BROWSERS=all     → chromium + firefox + webkit
//   BROWSERS=firefox → just firefox (comma-separated list also accepted)
//   BROWSERS=chromium,webkit → chromium + webkit
const ALL_BROWSERS = ["chromium", "firefox", "webkit"] as const;
type BrowserName = (typeof ALL_BROWSERS)[number];

function selectedBrowsers(): BrowserName[] {
  const raw = (process.env.BROWSERS ?? "chromium").trim().toLowerCase();
  if (raw === "all") return [...ALL_BROWSERS];

  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const valid = requested.filter((b): b is BrowserName =>
    (ALL_BROWSERS as readonly string[]).includes(b)
  );
  if (valid.length === 0) {
    throw new Error(
      `BROWSERS="${process.env.BROWSERS}" matched no known browser. Use "all" or any of: ${ALL_BROWSERS.join(", ")}`
    );
  }
  return valid;
}

const DEVICE_BY_BROWSER: Record<BrowserName, string> = {
  chromium: "Desktop Chrome",
  firefox:  "Desktop Firefox",
  webkit:   "Desktop Safari",
};

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 1,
  reporter: [
    ["html", { open: "never" }],
    ["list"],
    // JSON reporter — lets CI extract a plain failure list for Slack.
    ["json", { outputFile: "test-results/report.json" }],
  ],

  use: {
    baseURL: BASE_URL,
    // Visual pacing for local debugging; override with PW_SLOW_MO_MS=0 when needed.
    launchOptions: { slowMo: SLOW_MO_MS },
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    trace: "retain-on-failure",
  },

  projects: selectedBrowsers().map((name) => ({
    name,
    use: { ...devices[DEVICE_BY_BROWSER[name]] },
  })),
});
