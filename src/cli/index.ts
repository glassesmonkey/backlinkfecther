import { runClaimNextTaskCommand } from "./claim-next-task.js";
import { runEnqueueSiteCommand } from "./enqueue-site.js";
import { runStartBrowserCommand } from "./start-browser.js";
import { runPreflightCommand } from "./preflight.js";
import { runNextCommand } from "./run-next.js";
import { runTaskFinalizeCommand } from "./task-finalize.js";
import { runTaskPrepareCommand } from "./task-prepare.js";
import { runTaskRecordAgentTraceCommand } from "./task-record-agent-trace.js";

function readFlag(argv: string[], flagName: string): string | undefined {
  const index = argv.indexOf(flagName);
  if (index === -1) {
    return undefined;
  }

  return argv[index + 1];
}

function requireFlag(argv: string[], flagName: string): string {
  const value = readFlag(argv, flagName);
  if (!value) {
    throw new Error(`Missing required flag ${flagName}.`);
  }

  return value;
}

function readBooleanFlag(argv: string[], flagName: string): boolean {
  return argv.includes(flagName);
}

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  const cdpUrl = readFlag(rest, "--cdp-url");

  switch (command) {
    case "start-browser":
      await runStartBrowserCommand({
        port: readFlag(rest, "--port") ? Number(readFlag(rest, "--port")) : undefined,
        headed: readBooleanFlag(rest, "--headed"),
      });
      return;
    case "preflight":
      await runPreflightCommand({ cdpUrl });
      return;
    case "enqueue-site":
      await runEnqueueSiteCommand({
        taskId: requireFlag(rest, "--task-id"),
        directoryUrl: readFlag(rest, "--directory-url") ?? requireFlag(rest, "--target-url"),
        promotedUrl: requireFlag(rest, "--promoted-url"),
        promotedName: readFlag(rest, "--promoted-name"),
        promotedDescription: readFlag(rest, "--promoted-description"),
        submitterEmailBase: readFlag(rest, "--submitter-email-base"),
        confirmSubmit: readBooleanFlag(rest, "--confirm-submit"),
      });
      return;
    case "claim-next-task":
      await runClaimNextTaskCommand({
        owner: readFlag(rest, "--owner") ?? "codex-operator",
      });
      return;
    case "task-prepare":
      await runTaskPrepareCommand({
        taskId: requireFlag(rest, "--task-id"),
        cdpUrl,
      });
      return;
    case "task-record-agent-trace":
      await runTaskRecordAgentTraceCommand({
        taskId: requireFlag(rest, "--task-id"),
        payloadFile: requireFlag(rest, "--payload-file"),
      });
      return;
    case "task-finalize":
      await runTaskFinalizeCommand({
        taskId: requireFlag(rest, "--task-id"),
        cdpUrl,
      });
      return;
    case "run-next":
      await runNextCommand({
        taskId: requireFlag(rest, "--task-id"),
        directoryUrl: readFlag(rest, "--directory-url") ?? requireFlag(rest, "--target-url"),
        promotedUrl: requireFlag(rest, "--promoted-url"),
        promotedName: readFlag(rest, "--promoted-name"),
        promotedDescription: readFlag(rest, "--promoted-description"),
        submitterEmail: readFlag(rest, "--submitter-email"),
        confirmSubmit: readBooleanFlag(rest, "--confirm-submit"),
        cdpUrl,
      });
      return;
    default:
      throw new Error(
        'Unknown command. Use "start-browser", "preflight", "enqueue-site", "claim-next-task", "task-prepare", "task-record-agent-trace", "task-finalize", or "run-next".',
      );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
