import { test, expect } from "@playwright/test";
test("live market, chart, frames, overlays and desktop screenshot", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Market overview" }),
  ).toBeVisible();
  await expect(page.getByTestId("market-price")).not.toHaveText("—", {
    timeout: 60000,
  });
  await expect(
    page.getByTestId("candle-chart").locator("canvas").first(),
  ).toBeVisible({ timeout: 90000 });
  for (const frame of ["4H", "1D", "1W", "1H"]) {
    await page.getByRole("button", { name: frame, exact: true }).click();
    await expect(
      page.getByTestId("candle-chart").locator("canvas").first(),
    ).toBeVisible({ timeout: 90000 });
  }
  await page.getByRole("button", { name: "EMA20", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "EMA20", exact: true }),
  ).toHaveAttribute("aria-pressed", "false");
  await page.getByRole("button", { name: "EMA20", exact: true }).click();
  await expect(page.locator(".zone").first()).toBeVisible({ timeout: 90000 });
  await expect(page.locator(".feed")).toHaveText("LIVE", { timeout: 45000 });
  await page.waitForTimeout(12000); // Long enough to catch erroneous sequence-gap reconnect loops.
  await expect(page.locator(".feed")).toHaveText("LIVE", { timeout: 15000 });
  await page.screenshot({
    path: "../../docs/dashboard-desktop.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
test("feed staleness and disconnection are visible (test-only synthetic transport)", async ({
  page,
}) => {
  await page.routeWebSocket("**/ws/markets*", (ws) => {
    ws.send(
      JSON.stringify({
        type: "ticker",
        price: "100",
        time: "2020-01-01T00:00:00Z",
        source_product: "TEST-ONLY",
      }),
    );
  });
  await page.goto("/dashboard");
  await expect(page.locator(".feed")).toHaveText("STALE");
});
test("navigation, risk calculation, and actual backtest", async ({ page }) => {
  await page.goto("/settings");
  await page.getByLabel("Entry price", { exact: true }).fill("100");
  await page.getByLabel("Exit price", { exact: true }).fill("110");
  await page.getByLabel("Stop price", { exact: true }).fill("95");
  await page
    .getByRole("button", { name: "Calculate net risk / reward" })
    .click();
  await expect(page.getByText("NET PROFIT", { exact: true })).toBeVisible();
  await page.goto("/backtesting");
  await page.getByRole("button", { name: "Run backtest", exact: true }).click();
  await expect(page.getByText("Portfolio equity", { exact: true })).toBeVisible(
    { timeout: 120000 },
  );
  for (const path of ["markets", "models", "signals", "analysis/XRP-USDC"]) {
    await page.goto("/" + path);
    await expect(page.locator("h1")).toBeVisible();
  }
});
test("API failure and mobile layout", async ({ page }) => {
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ detail: "Test-only simulated outage" }),
    }),
  );
  await page.goto("/dashboard");
  await expect(page.getByRole("alert").first()).toContainText(
    "Data unavailable",
    { timeout: 20000 },
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({
    path: "../../docs/dashboard-mobile-outage.png",
    fullPage: true,
  });
});
