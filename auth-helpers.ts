import { Page } from "@playwright/test";
import { MAIN_URL, IDP_REGEX, FOSS_HOST_REGEX } from "./constants";

export async function cognitoLogin(page: Page): Promise<void> {
  const user = process.env.FOSS_USER;
  const pass = process.env.FOSS_PASS;
  if (!user || !pass) {
    throw new Error("FOSS_USER and FOSS_PASS env vars required");
  }

  await page.goto(MAIN_URL, { waitUntil: "domcontentloaded" });

  if (!IDP_REGEX.test(page.url())) {
    await page.getByRole("button", { name: /^login|sign in/i }).first().click();
  }

  await page.waitForURL(IDP_REGEX, { timeout: 20000 });

  const passwordChooser = page.getByRole("button", { name: /password login|username and password/i });
  if (await passwordChooser.count()) {
    await passwordChooser.first().click();
  }

  const userInput = page.locator(
    'input[name="username"], input[name="mpassNumber"], input[placeholder*="username" i], input[placeholder*="mPass" i], input[type="text"]'
  ).first();
  await userInput.waitFor({ state: "visible", timeout: 15000 });
  await userInput.click();
  await userInput.pressSequentially(user, { delay: 30 });

  const passInput = page.locator('input[type="password"], input[name="password"]').first();
  await passInput.waitFor({ state: "visible", timeout: 10000 });
  await passInput.click();
  await passInput.pressSequentially(pass, { delay: 30 });

  await page.getByRole("button", { name: /^(login|sign in|submit)$/i }).first().click();

  await page.waitForURL(FOSS_HOST_REGEX, { timeout: 45000 });
  await page.waitForLoadState("networkidle");
}
