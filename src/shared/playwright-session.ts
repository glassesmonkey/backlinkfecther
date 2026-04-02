import { chromium } from "playwright";

function pickPreferredPage(
  contexts: import("playwright").BrowserContext[],
  preferredUrl?: string,
): import("playwright").Page | undefined {
  const pages = contexts.flatMap((context) => context.pages());

  if (preferredUrl) {
    const exactMatch = pages.find((page) => page.url() === preferredUrl);
    if (exactMatch) {
      return exactMatch;
    }

    const prefixMatch = pages.find((page) => preferredUrl.startsWith(page.url()) || page.url().startsWith(preferredUrl));
    if (prefixMatch) {
      return prefixMatch;
    }
  }

  const lastNonBlankPage = [...pages]
    .reverse()
    .find((page) => page.url() && page.url() !== "about:blank");
  if (lastNonBlankPage) {
    return lastNonBlankPage;
  }

  return pages.at(-1);
}

export async function withConnectedPage<T>(
  cdpUrl: string,
  run: (page: import("playwright").Page) => Promise<T>,
  options: { preferredUrl?: string } = {},
): Promise<T> {
  const browser = await chromium.connectOverCDP(cdpUrl);

  try {
    const context =
      browser.contexts()[0] ?? (await browser.newContext({ ignoreHTTPSErrors: true }));
    const page =
      pickPreferredPage(browser.contexts(), options.preferredUrl) ??
      context.pages()[0] ??
      (await context.newPage());
    return await run(page);
  } finally {
    await browser.close();
  }
}
