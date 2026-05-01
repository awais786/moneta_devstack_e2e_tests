import { test, expect } from "../../fixtures";
import { APP_URLS } from "../../constants";
import { registerLinkCoverage } from "../lib/link-coverage";

const BASE = APP_URLS.Outline;

test.describe("Outline (Docs) — App-Specific", () => {
  test("page title carries Outline branding", async ({ page }) => {
    await page.goto(`${BASE}/home`, { waitUntil: "networkidle", timeout: 30000 });
    expect(await page.title()).toMatch(/outline/i);
  });
});

registerLinkCoverage({ appName: "Outline (Docs)", baseUrl: BASE });
