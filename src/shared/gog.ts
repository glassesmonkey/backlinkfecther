import { runCommand } from "./command.js";

interface GogSearchMessage {
  id: string;
  threadId?: string;
  subject?: string;
  from?: string;
  to?: string;
  date?: string;
  snippet?: string;
  body?: string;
}

interface GogMessagePayload {
  id?: string;
  payload?: {
    headers?: Array<{ name?: string; value?: string }>;
  };
  snippet?: string;
  body?: string;
}

function findHeader(
  headers: Array<{ name?: string; value?: string }> | undefined,
  headerName: string,
): string | undefined {
  return headers?.find((header) => header.name?.toLowerCase() === headerName.toLowerCase())?.value;
}

export async function searchLatestEmail(args: {
  query: string;
  account?: string;
}): Promise<GogSearchMessage | undefined> {
  const commandArgs = [
    "gmail",
    "messages",
    "search",
    args.query,
    "--json",
    "--results-only",
    "--max=1",
    "--include-body",
    "--no-input",
  ];
  if (args.account) {
    commandArgs.splice(0, 0, `--account=${args.account}`);
  }

  const result = await runCommand("gog", commandArgs, 30_000);
  if (result.exit_code !== 0 || !result.stdout.trim()) {
    return undefined;
  }

  const parsed = JSON.parse(result.stdout) as GogSearchMessage[] | GogSearchMessage;
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  return messages[0];
}

export async function getEmailBody(args: {
  messageId: string;
  account?: string;
}): Promise<{ subject?: string; body: string; from?: string; to?: string } | undefined> {
  const commandArgs = [
    "gmail",
    "get",
    args.messageId,
    "--json",
    "--results-only",
    "--format=full",
    "--no-input",
  ];
  if (args.account) {
    commandArgs.splice(0, 0, `--account=${args.account}`);
  }

  const result = await runCommand("gog", commandArgs, 30_000);
  if (result.exit_code !== 0 || !result.stdout.trim()) {
    return undefined;
  }

  const payload = JSON.parse(result.stdout) as GogMessagePayload;
  return {
    subject: findHeader(payload.payload?.headers, "Subject"),
    from: findHeader(payload.payload?.headers, "From"),
    to: findHeader(payload.payload?.headers, "To"),
    body: payload.body ?? payload.snippet ?? "",
  };
}

export function extractMagicLink(body: string): string | undefined {
  const matches = body.match(/https?:\/\/[^\s"'<>]+/g);
  return matches?.[0];
}

export function extractVerificationCode(body: string): string | undefined {
  const codeMatch = body.match(/\b(\d{4,8})\b/);
  return codeMatch?.[1];
}
