import { runStartBrowserCommand } from "./start-browser.js";
import { runPreflightCommand } from "./preflight.js";
import { runNextCommand } from "./run-next.js";

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
        'Unknown command. Use "start-browser", "preflight", or "run-next".',
      );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
