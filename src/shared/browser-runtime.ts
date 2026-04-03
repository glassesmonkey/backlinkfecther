import type { BrowserRuntime, BrowserRuntimeSource } from "./types.js";

export const DEFAULT_CDP_URL = "http://127.0.0.1:9333";
const EXTERNAL_CDP_PORTS = [9222, 9223, 9224, 9229];
const LOOPBACK_HOSTS = ["127.0.0.1", "localhost"];

const RUNTIME_ENV_PRIORITY: Array<{
  key: BrowserRuntimeSource;
  value: string | undefined;
}> = [
  { key: "BACKLINK_BROWSER_CDP_URL", value: process.env.BACKLINK_BROWSER_CDP_URL },
  { key: "BROWSER_USE_CDP_URL", value: process.env.BROWSER_USE_CDP_URL },
  { key: "CHROME_CDP_URL", value: process.env.CHROME_CDP_URL },
];

interface BrowserMetadata {
  browser_name: string;
  protocol_version: string;
}

interface CdpEndpointMetadata {
  browser_name?: string;
  user_agent?: string;
}

async function probeCdpEndpoint(cdpUrl: string): Promise<CdpEndpointMetadata | undefined> {
  if (!cdpUrl.startsWith("http://") && !cdpUrl.startsWith("https://")) {
    return {};
  }

  try {
    const response = await fetch(new URL("/json/version", cdpUrl), {
      signal: AbortSignal.timeout(1_500),
    });

    if (!response.ok) {
      return undefined;
    }

    const payload = (await response.json()) as {
      Browser?: string;
      "User-Agent"?: string;
    };

    if (!payload.Browser) {
      return undefined;
    }

    return {
      browser_name: payload.Browser,
      user_agent: payload["User-Agent"],
    };
  } catch {
    return undefined;
  }
}

function scoreExternalCandidate(metadata: CdpEndpointMetadata): number {
  const userAgent = metadata.user_agent ?? "";
  return userAgent.includes("HeadlessChrome") ? 0 : 10;
}

async function autodiscoverExternalCdpUrl(): Promise<string | undefined> {
  const candidates: Array<{ cdpUrl: string; score: number }> = [];

  for (const port of EXTERNAL_CDP_PORTS) {
    for (const host of LOOPBACK_HOSTS) {
      const candidate = `http://${host}:${port}`;
      const metadata = await probeCdpEndpoint(candidate);
      if (metadata) {
        candidates.push({
          cdpUrl: candidate,
          score: scoreExternalCandidate(metadata),
        });
      }
    }
  }

  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.cdpUrl;
}

export async function resolveCdpUrl(cliValue?: string): Promise<{
  cdpUrl: string;
  source: BrowserRuntimeSource;
}> {
  if (cliValue) {
    return {
      cdpUrl: cliValue,
      source: "cli",
    };
  }

  const match = RUNTIME_ENV_PRIORITY.find((candidate) => candidate.value);
  if (match?.value) {
    return {
      cdpUrl: match.value,
      source: match.key,
    };
  }

  const autodiscovered = await autodiscoverExternalCdpUrl();
  if (autodiscovered) {
    return {
      cdpUrl: autodiscovered,
      source: "autodiscovered_external",
    };
  }

  return {
    cdpUrl: DEFAULT_CDP_URL,
    source: "default_local",
  };
}

async function fetchBrowserMetadata(cdpUrl: string): Promise<BrowserMetadata> {
  if (!cdpUrl.startsWith("http://") && !cdpUrl.startsWith("https://")) {
    return {
      browser_name: "unknown",
      protocol_version: "unknown",
    };
  }

  try {
    const metadataUrl = new URL("/json/version", cdpUrl);
    const response = await fetch(metadataUrl, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return {
        browser_name: "unknown",
        protocol_version: "unknown",
      };
    }

    const payload = (await response.json()) as {
      Browser?: string;
      "Protocol-Version"?: string;
    };

    return {
      browser_name: payload.Browser ?? "unknown",
      protocol_version: payload["Protocol-Version"] ?? "unknown",
    };
  } catch {
    return {
      browser_name: "unknown",
      protocol_version: "unknown",
    };
  }
}

export async function resolveBrowserRuntime(
  cliCdpUrl?: string,
): Promise<BrowserRuntime> {
  const { cdpUrl, source } = await resolveCdpUrl(cliCdpUrl);
  const metadata = await fetchBrowserMetadata(cdpUrl);

  return {
    cdp_url: cdpUrl,
    ok: false,
    source,
    browser_name: metadata.browser_name,
    protocol_version: metadata.protocol_version,
    preflight_checks: {
      cdp_runtime: { ok: false, detail: "Not checked yet." },
      playwright: { ok: false, detail: "Not checked yet." },
      browser_use_cli: { ok: false, detail: "Not checked yet." },
      agent_backend: { ok: false, detail: "Not checked yet." },
      gog: { ok: false, detail: "Not checked yet." },
    },
  };
}
