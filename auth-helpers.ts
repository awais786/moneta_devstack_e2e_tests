import { Page } from "@playwright/test";
import { MAIN_URL, IDP_REGEX, FOSS_HOST_REGEX } from "./constants";

export async function cognitoLogin(
  page: Page,
  opts?: { user?: string; pass?: string }
): Promise<void> {
  const user = opts?.user ?? process.env.FOSS_USER;
  const pass = opts?.pass ?? process.env.FOSS_PASS;
  if (!user || !pass) {
    throw new Error(
      "cognitoLogin: provide {user, pass} or set FOSS_USER + FOSS_PASS in env"
    );
  }

  await page.goto(MAIN_URL, { waitUntil: "domcontentloaded" });

  if (!IDP_REGEX.test(page.url())) {
    const loginCta = page
      .getByRole("button", { name: /(log\s*in|sign\s*in)/i })
      .or(page.getByRole("link", { name: /(log\s*in|sign\s*in)/i }))
      .first();
    await loginCta.click({ timeout: 10000 });
  }

  await page.waitForURL(IDP_REGEX, { timeout: 45000 });

  const passwordChooser = page.getByRole("button", { name: /(password login|username and password)/i });
  if (await passwordChooser.count()) {
    await passwordChooser.first().click();
  }

  const userInput = page.locator(
    'input[name="username"], input[name="mpassNumber"], input[placeholder*="username" i], input[placeholder*="mPass" i], input[type="text"]'
  ).first();
  await userInput.waitFor({ state: "visible", timeout: 30000 });
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
