import { withConnectedPage } from "../shared/playwright-session.js";
import type { BrowserRuntime, PageSnapshot, ScoutResult, TaskRecord } from "../shared/types.js";

const SUBMIT_CANDIDATE_PATTERN =
  /(submit|add tool|submit tool|submit a tool|add listing|suggest|get listed|list your tool)/i;

function extractHints(text: string): {
  field_hints: string[];
  auth_hints: string[];
  anti_bot_hints: string[];
  evidence_sufficiency: boolean;
} {
  const normalized = text.toLowerCase();

  const field_hints = [
    "website",
    "tool name",
    "business name",
    "email",
    "description",
    "category",
    "pricing",
  ].filter((hint) => normalized.includes(hint));

  const auth_hints = [
    "sign in",
    "log in",
    "create account",
    "register",
    "join",
    "password",
    "continue with google",
  ].filter((hint) => normalized.includes(hint));

  const anti_bot_hints = [
    "captcha",
    "cloudflare",
    "verify you are human",
    "loading captcha",
    "i'm not a robot",
  ].filter((hint) => normalized.includes(hint));

  const evidence_sufficiency =
    normalized.includes("submit") || normalized.includes("tool url") || normalized.includes("tool name");

  return {
    field_hints,
    auth_hints,
    anti_bot_hints,
    evidence_sufficiency,
  };
}

async function collectSubmitCandidates(
  page: import("playwright").Page,
): Promise<string[]> {
  return page.locator("a, button").evaluateAll((elements, patternSource) => {
    const pattern = new RegExp(patternSource, "i");
    return elements
      .map((element) => (element.textContent || "").replace(/\s+/g, " ").trim())
      .filter((text) => text && pattern.test(text))
      .slice(0, 8);
  }, SUBMIT_CANDIDATE_PATTERN.source);
}

export async function runLightweightScout(args: {
  runtime: BrowserRuntime;
  task: TaskRecord;
}): Promise<ScoutResult> {
  return withConnectedPage(args.runtime.cdp_url, async (page) => {
    try {
      const response = await page.goto(args.task.target_url, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });

      const bodyTextExcerpt = await page.locator("body").innerText().catch(() => "");
      const snapshot = {
        url: page.url(),
        title: await page.title(),
        response_status: response?.status(),
        body_text_excerpt: bodyTextExcerpt.slice(0, 3_000),
      } satisfies PageSnapshot;

      const combinedText = `${snapshot.title}\n${snapshot.url}\n${snapshot.body_text_excerpt}`;
      const hints = extractHints(combinedText);
      const submitCandidates = await collectSubmitCandidates(page);
      const surfaceSummary =
        snapshot.response_status && snapshot.response_status >= 500
          ? `Scout reached ${snapshot.url} but the directory returned upstream status ${snapshot.response_status}.`
          : `Scout reached ${snapshot.url} with title "${snapshot.title}".`;

      return {
        ok: true,
        surface_summary: surfaceSummary,
        submit_candidates: submitCandidates,
        page_snapshot: snapshot,
        ...hints,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown navigation failure.";
      return {
        ok: false,
        surface_summary: `Scout could not load ${args.task.target_url}: ${message}`,
        submit_candidates: [],
        page_snapshot: {
          url: args.task.target_url,
          title: "Navigation failed",
          body_text_excerpt: message,
        },
        field_hints: [],
        auth_hints: [],
        anti_bot_hints: [],
        evidence_sufficiency: false,
      };
    }
  });
}
