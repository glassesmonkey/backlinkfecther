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

interface BrowserUseCommandArgs {
  cdpUrl: string;
  session: string;
  command: string;
  commandArgs?: string[];
  timeoutMs?: number;
}

function normalizeComparableUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    parsed.hash = "";
    if (parsed.pathname.endsWith("/") && parsed.pathname !== "/") {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    return rawUrl.replace(/#.*$/, "").replace(/\/$/, "");
  }
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
      trimmed === "Open Shadow" ||
      trimmed === "Shadow End" ||
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

async function runBrowserUseCommand<T>(args: BrowserUseCommandArgs): Promise<T> {
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

async function runBrowserUseSideEffect(args: BrowserUseCommandArgs): Promise<void> {
  await runBrowserUseCommand<Record<string, unknown>>(args);
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
  try {
    const data = await runBrowserUseCommand<{ url: string }>({
      cdpUrl: args.cdpUrl,
      session: args.session,
      command: "open",
      commandArgs: [args.url],
      timeoutMs: 30_000,
    });

    return data.url;
  } catch (error) {
    const detail = error instanceof Error ? error.message : "browser-use open failed.";
    const currentUrl = await runBrowserUseCommand<{ result: string }>({
      cdpUrl: args.cdpUrl,
      session: args.session,
      command: "eval",
      commandArgs: ["location.href"],
      timeoutMs: 5_000,
    }).then((data) => data.result).catch(() => undefined);

    if (
      currentUrl &&
      normalizeComparableUrl(currentUrl) === normalizeComparableUrl(args.url) &&
      /timeout|aborted/i.test(detail)
    ) {
      return currentUrl;
    }

    throw error;
  }
}

export async function clickBrowserUseElement(args: {
  cdpUrl: string;
  session: string;
  index: number;
}): Promise<void> {
  await runBrowserUseSideEffect({
    cdpUrl: args.cdpUrl,
    session: args.session,
    command: "click",
    commandArgs: [String(args.index)],
    timeoutMs: 20_000,
  });
}

export async function inputBrowserUseElement(args: {
  cdpUrl: string;
  session: string;
  index: number;
  text: string;
}): Promise<void> {
  await runBrowserUseSideEffect({
    cdpUrl: args.cdpUrl,
    session: args.session,
    command: "input",
    commandArgs: [String(args.index), args.text],
    timeoutMs: 20_000,
  });
}

export async function selectBrowserUseElement(args: {
  cdpUrl: string;
  session: string;
  index: number;
  value: string;
}): Promise<void> {
  await runBrowserUseSideEffect({
    cdpUrl: args.cdpUrl,
    session: args.session,
    command: "select",
    commandArgs: [String(args.index), args.value],
    timeoutMs: 20_000,
  });
}

export async function sendBrowserUseKeys(args: {
  cdpUrl: string;
  session: string;
  keys: string;
}): Promise<void> {
  await runBrowserUseSideEffect({
    cdpUrl: args.cdpUrl,
    session: args.session,
    command: "keys",
    commandArgs: [args.keys],
    timeoutMs: 20_000,
  });
}

export async function waitForBrowserUseText(args: {
  cdpUrl: string;
  session: string;
  text: string;
  timeoutMs?: number;
}): Promise<void> {
  await runBrowserUseSideEffect({
    cdpUrl: args.cdpUrl,
    session: args.session,
    command: "wait",
    commandArgs: ["text", ...(args.timeoutMs ? ["--timeout", String(args.timeoutMs)] : []), args.text],
    timeoutMs: (args.timeoutMs ?? 10_000) + 5_000,
  });
}

export async function waitForBrowserUseSelector(args: {
  cdpUrl: string;
  session: string;
  selector: string;
  state?: "attached" | "detached" | "visible" | "hidden";
  timeoutMs?: number;
}): Promise<void> {
  await runBrowserUseSideEffect({
    cdpUrl: args.cdpUrl,
    session: args.session,
    command: "wait",
    commandArgs: [
      "selector",
      ...(args.timeoutMs ? ["--timeout", String(args.timeoutMs)] : []),
      ...(args.state ? ["--state", args.state] : []),
      args.selector,
    ],
    timeoutMs: (args.timeoutMs ?? 10_000) + 5_000,
  });
}

export async function evaluateBrowserUse(args: {
  cdpUrl: string;
  session: string;
  script: string;
}): Promise<string> {
  const data = await runBrowserUseCommand<{ result: string }>({
    cdpUrl: args.cdpUrl,
    session: args.session,
    command: "eval",
    commandArgs: [args.script],
    timeoutMs: 20_000,
  });

  return data.result;
}

export async function getBrowserUseElementText(args: {
  cdpUrl: string;
  session: string;
  index: number;
}): Promise<string> {
  const data = await runBrowserUseCommand<{ text: string }>({
    cdpUrl: args.cdpUrl,
    session: args.session,
    command: "get",
    commandArgs: ["text", String(args.index)],
    timeoutMs: 20_000,
  });

  return data.text;
}

export async function getBrowserUseElementValue(args: {
  cdpUrl: string;
  session: string;
  index: number;
}): Promise<string> {
  const data = await runBrowserUseCommand<{ value: string }>({
    cdpUrl: args.cdpUrl,
    session: args.session,
    command: "get",
    commandArgs: ["value", String(args.index)],
    timeoutMs: 20_000,
  });

  return data.value;
}

export async function saveBrowserUseScreenshot(args: {
  cdpUrl: string;
  session: string;
  filePath: string;
}): Promise<void> {
  await runBrowserUseSideEffect({
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
