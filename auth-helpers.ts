import { Page } from "@playwright/test";

const BASE_URL = "https://foss.arbisoft.com";
const COGNITO_PATTERN = /amazoncognito\.com/;
const FOSS_PATTERN = /arbisoft\.com(?!.*amazoncognito)/;

export async function cognitoLogin(page: Page): Promise<void> {
  const user = process.env.FOSS_USER;
  const pass = process.env.FOSS_PASS;
  if (!user || !pass) {
    throw new Error("FOSS_USER and FOSS_PASS env vars required");
  }

  await page.goto(BASE_URL, { waitUntil: "domcontentloaded" });
  await page.waitForURL(COGNITO_PATTERN, { timeout: 15000 });

  await page.waitForSelector('input[name="username"], input[type="text"]', { timeout: 10000 });
  await page.fill('input[name="username"], input[type="text"]', user);
  await page.click('button[type="submit"], button:has-text("Next"), button:has-text("Sign in")');

  await page.waitForSelector('input[name="password"], input[type="password"]', { timeout: 10000 });
  await page.fill('input[name="password"], input[type="password"]', pass);
  await page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Login")');

  await page.waitForURL(FOSS_PATTERN, { timeout: 20000 });
  await page.waitForLoadState("networkidle");
}
