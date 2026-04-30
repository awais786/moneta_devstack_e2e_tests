import { test, expect } from "../../fixtures";
import { APP_URLS } from "../../constants";
import { registerLinkCoverage } from "../lib/link-coverage";

const BASE = APP_URLS.Penpot;

test.describe("Penpot (Design) — App-Specific", () => {
  test("page title carries Penpot branding", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle", timeout: 30000 });
    expect(await page.title()).toMatch(/penpot/i);
  });
});

registerLinkCoverage({ appName: "Penpot (Design)", baseUrl: BASE });
