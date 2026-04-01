import { getProfileFilePath, readJsonFile, writeJsonFile } from "../memory/data-store.js";
import type { PromotedProfile } from "./types.js";

function stripHtmlEntityNoise(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTagContent(html: string, pattern: RegExp): string | undefined {
  const match = html.match(pattern);
  return match?.[1] ? stripHtmlEntityNoise(match[1]) : undefined;
}

function inferCategoryHints(text: string): string[] {
  const normalized = text.toLowerCase();
  const hints = new Set<string>();

  const keywordGroups: Array<[string, string[]]> = [
    ["finance", ["finance", "fintech", "bank", "accounting", "bookkeeping", "invoice"]],
    ["productivity", ["productivity", "workflow", "spreadsheet", "automation"]],
    ["automation", ["agent", "automation", "autonomous"]],
    ["business", ["business", "operations", "company"]],
    ["research", ["research", "analysis"]],
  ];

  for (const [hint, keywords] of keywordGroups) {
    if (keywords.some((keyword) => normalized.includes(keyword))) {
      hints.add(hint);
    }
  }

  if (normalized.includes("quickbooks") || normalized.includes("xero")) {
    hints.add("accounting");
    hints.add("finance");
  }

  return [...hints];
}

function pickPromotedName(args: {
  html: string;
  hostname: string;
  overrideName?: string;
}): string {
  if (args.overrideName?.trim()) {
    return args.overrideName.trim();
  }

  const siteName =
    extractTagContent(args.html, /<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ??
    extractTagContent(args.html, /<meta[^>]+name=["']application-name["'][^>]+content=["']([^"']+)["']/i);

  if (siteName) {
    return siteName;
  }

  const title = extractTagContent(args.html, /<title[^>]*>(.*?)<\/title>/is) ?? args.hostname;
  const dashParts = title.split(/\s[-–]\s/).map((part) => part.trim()).filter(Boolean);
  if (dashParts.length > 1) {
    return dashParts[dashParts.length - 1];
  }

  const pipeParts = title.split("|").map((part) => part.trim()).filter(Boolean);
  if (pipeParts.length > 1) {
    return pipeParts[pipeParts.length - 1];
  }

  return title;
}

function pickPromotedDescription(args: {
  html: string;
  overrideDescription?: string;
  fallbackName: string;
}): string {
  if (args.overrideDescription?.trim()) {
    return args.overrideDescription.trim();
  }

  return (
    extractTagContent(args.html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ??
    extractTagContent(args.html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ??
    args.fallbackName
  );
}

async function fetchSiteHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; BacklinerHelper/0.1)",
    },
  });

  if (!response.ok) {
    throw new Error(`Promoted site fetch failed with status ${response.status}.`);
  }

  return response.text();
}

export async function loadOrCreatePromotedProfile(args: {
  promotedUrl: string;
  promotedName?: string;
  promotedDescription?: string;
}): Promise<PromotedProfile> {
  const hostname = new URL(args.promotedUrl).hostname;
  const existing = await readJsonFile<PromotedProfile>(getProfileFilePath(hostname));

  if (
    existing &&
    !args.promotedName &&
    !args.promotedDescription &&
    existing.url === args.promotedUrl
  ) {
    return existing;
  }

  try {
    const html = await fetchSiteHtml(args.promotedUrl);
    const name = pickPromotedName({
      html,
      hostname,
      overrideName: args.promotedName,
    });
    const description = pickPromotedDescription({
      html,
      overrideDescription: args.promotedDescription,
      fallbackName: name,
    });

    const profile: PromotedProfile = {
      url: args.promotedUrl,
      hostname,
      name,
      description,
      category_hints: inferCategoryHints(`${name} ${description}`),
      source:
        args.promotedName || args.promotedDescription ? "cli" : "site_metadata",
    };

    await writeJsonFile(getProfileFilePath(hostname), profile);
    return profile;
  } catch {
    const fallbackProfile: PromotedProfile = {
      url: args.promotedUrl,
      hostname,
      name: args.promotedName?.trim() || hostname.replace(/^www\./, ""),
      description:
        args.promotedDescription?.trim() ||
        `Listing for ${args.promotedName?.trim() || hostname.replace(/^www\./, "")}`,
      category_hints: inferCategoryHints(
        `${args.promotedName ?? ""} ${args.promotedDescription ?? ""}`,
      ),
      source: "fallback",
    };

    await writeJsonFile(getProfileFilePath(hostname), fallbackProfile);
    return fallbackProfile;
  }
}
