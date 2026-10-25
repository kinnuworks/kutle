import { expect, test, type Page } from "@playwright/test";

// Each page must render live chain data, keep the layout inside the viewport,
// and log no errors.
const PAGES: { path: string; expect: RegExp }[] = [
  { path: "/#/", expect: /ML-DSA-44 verified on chain · [\d,]+ gas/ },
  { path: "/#/p/1", expect: /Passport #1/ },
  { path: "/#/verify/2", expect: /checks passed/ },
  { path: "/#/recycler", expect: /Batch #1 · 2 passports/ },
  { path: "/#/maker", expect: /unspent/ },
  { path: "/#/attacks", expect: /Replay a reading batch/ },
  { path: "/#/impact", expect: /Second-life handoffs/ },
  { path: "/#/device", expect: /Batches on chain/ },
];

async function noHorizontalScroll(page: Page) {
  const [sw, iw] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(sw).toBeLessThanOrEqual(iw + 1);
}

for (const p of PAGES) {
  test(`loads ${p.path}`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    await page.addInitScript(() => localStorage.setItem("kutle.lang", "en"));
    await page.goto(p.path);
    await expect(page.locator("main")).toContainText(p.expect, { timeout: 30_000 });
    await noHorizontalScroll(page);
    expect(errors.filter((e) => !/fonts\.g/.test(e))).toEqual([]);
  });
}

test("language toggle switches to Turkish", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("kutle.lang", "en"));
  await page.goto("/#/impact");
  await page.getByRole("button", { name: "TR" }).click();
  await expect(page.locator("main")).toContainText("İkinci ömür neyi önler.");
});

test("a reading verifies on chain from the passport page", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("kutle.lang", "en"));
  await page.goto("/#/p/6");
  await page.getByRole("tab", { name: "Legitimate interest" }).click();
  await page.getByRole("button", { name: "Check on chain" }).click();
  await expect(page.locator("main")).toContainText("ReadingLog.verifyReading returned", { timeout: 20_000 });
  await expect(page.locator(".pill--pass", { hasText: "true" })).toBeVisible();
});

test("an attack is refused with the expected decoded error", async ({ page }, info) => {
  test.skip(info.project.name !== "desktop", "one run is enough");
  await page.goto("/#/attacks");
  const card = page.locator("article", { hasText: "Replay a reading batch" });
  await card.getByRole("button", { name: "Send the transaction" }).click();
  await expect(card).toContainText("refused as expected", { timeout: 30_000 });
  await expect(card).toContainText("BadSequence");
});
