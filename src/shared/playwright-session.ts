import { chromium } from "playwright";

export async function withConnectedPage<T>(
  cdpUrl: string,
  run: (page: import("playwright").Page) => Promise<T>,
): Promise<T> {
  const browser = await chromium.connectOverCDP(cdpUrl);

  try {
    const context =
      browser.contexts()[0] ?? (await browser.newContext({ ignoreHTTPSErrors: true }));
    const page = context.pages()[0] ?? (await context.newPage());
    return await run(page);
  } finally {
    await browser.close();
  }
}
