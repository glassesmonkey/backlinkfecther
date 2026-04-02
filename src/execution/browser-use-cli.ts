import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface BrowserUseElement {
  index: number;
  descriptor: string;
  text: string;
}

export interface BrowserUseSnapshot {
  raw_text: string;
  url: string;
  title: string;
  elements: BrowserUseElement[];
}

interface BrowserUseEnvelope<T> {
  id?: string;
  success: boolean;
  data?: T;
  error?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function parseStateElements(rawText: string): BrowserUseElement[] {
  const lines = rawText.split(/\r?\n/);
  const elements: BrowserUseElement[] = [];
  let current: BrowserUseElement | undefined;

  for (const line of lines) {
    const trimmed = line.trim();
    const elementMatch = trimmed.match(/^\[(\d+)\](.+)$/);
    if (elementMatch) {
      if (current) {
        current.text = current.text.trim();
        elements.push(current);
      }

      current = {
        index: Number(elementMatch[1]),
        descriptor: elementMatch[2].trim(),
        text: "",
      };
      continue;
    }

    if (!current) {
      continue;
    }

    if (
      !trimmed ||
      trimmed.startsWith("viewport:") ||
      trimmed.startsWith("page:") ||
      trimmed.startsWith("scroll:")
    ) {
      continue;
    }

    current.text = `${current.text} ${trimmed}`.trim();
  }

  if (current) {
    current.text = current.text.trim();
    elements.push(current);
  }

  return elements;
}

async function runBrowserUseCommand<T>(args: {
  cdpUrl: string;
  session: string;
  command: string;
  commandArgs?: string[];
  timeoutMs?: number;
}): Promise<T> {
  const { stdout, stderr } = await execFile(
    "browser-use",
    [
      "--cdp-url",
      args.cdpUrl,
      "--session",
      args.session,
      "--json",
      args.command,
      ...(args.commandArgs ?? []),
    ],
    {
      timeout: args.timeoutMs ?? 20_000,
      maxBuffer: 10 * 1024 * 1024,
    },
  );

  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`browser-use ${args.command} returned no output. ${stderr.trim()}`.trim());
  }

  const envelope = JSON.parse(trimmed) as BrowserUseEnvelope<T>;
  if (!envelope.success || !envelope.data) {
    throw new Error(
      `browser-use ${args.command} failed: ${envelope.error ?? stderr.trim() ?? "Unknown error."}`,
    );
  }

  return envelope.data;
}

export async function getBrowserUseSnapshot(args: {
  cdpUrl: string;
  session: string;
}): Promise<BrowserUseSnapshot> {
  const [stateData, urlData, titleData] = await Promise.all([
    runBrowserUseCommand<{ _raw_text: string }>({
      cdpUrl: args.cdpUrl,
      session: args.session,
      command: "state",
      timeoutMs: 20_000,
    }),
    runBrowserUseCommand<{ result: string }>({
      cdpUrl: args.cdpUrl,
      session: args.session,
      command: "eval",
      commandArgs: ["location.href"],
      timeoutMs: 20_000,
    }),
    runBrowserUseCommand<{ title: string }>({
      cdpUrl: args.cdpUrl,
      session: args.session,
      command: "get",
      commandArgs: ["title"],
      timeoutMs: 20_000,
    }),
  ]);

  return {
    raw_text: stateData._raw_text,
    url: urlData.result,
    title: titleData.title,
    elements: parseStateElements(stateData._raw_text),
  };
}

export async function openBrowserUseUrl(args: {
  cdpUrl: string;
  session: string;
  url: string;
}): Promise<string> {
  const data = await runBrowserUseCommand<{ url: string }>({
    cdpUrl: args.cdpUrl,
    session: args.session,
    command: "open",
    commandArgs: [args.url],
    timeoutMs: 30_000,
  });

  return data.url;
}

export async function clickBrowserUseElement(args: {
  cdpUrl: string;
  session: string;
  index: number;
}): Promise<void> {
  await runBrowserUseCommand<Record<string, unknown>>({
    cdpUrl: args.cdpUrl,
    session: args.session,
    command: "click",
    commandArgs: [String(args.index)],
    timeoutMs: 20_000,
  });
}

export async function saveBrowserUseScreenshot(args: {
  cdpUrl: string;
  session: string;
  filePath: string;
}): Promise<void> {
  await runBrowserUseCommand<Record<string, unknown>>({
    cdpUrl: args.cdpUrl,
    session: args.session,
    command: "screenshot",
    commandArgs: [args.filePath],
    timeoutMs: 30_000,
  });
}

export async function settleBrowserUsePage(ms = 1_500): Promise<void> {
  await sleep(ms);
}
