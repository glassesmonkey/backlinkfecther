import { acquireBrowserOwnership, releaseBrowserOwnership } from "../execution/ownership-lock.js";
import { runTrajectoryReplay } from "../execution/replay.js";
import { runLightweightScout } from "../execution/scout.js";
import { getAccountForHostname } from "../memory/account-registry.js";
import { getCredential } from "../memory/credential-vault.js";
import {
  ensureDataDirectories,
  getArtifactFilePath,
  loadTask,
  saveTask,
  writeJsonFile,
} from "../memory/data-store.js";
import { loadTrajectoryPlaybook } from "../memory/trajectory-playbook.js";
import { resolveBrowserRuntime } from "../shared/browser-runtime.js";
import { buildMailboxQuery, buildPlusAlias } from "../shared/email.js";
import { runPreflight } from "../shared/preflight.js";
import type { PrepareResult, TaskRecord, TaskStatus } from "../shared/types.js";

function updateTaskStatus(task: TaskRecord, status: TaskStatus): void {
  task.status = status;
  task.updated_at = new Date().toISOString();
}

function inferRegistrationRequired(task: TaskRecord, scoutTextHints: string[]): boolean {
  if (!task.submission.submitter_email) {
    return false;
  }

  return scoutTextHints.some((hint) =>
    ["create account", "register", "join", "password", "sign in", "log in"].includes(hint.toLowerCase()),
  );
}

export async function prepareTaskForAgent(args: {
  taskId: string;
  cdpUrl?: string;
}): Promise<PrepareResult> {
  await ensureDataDirectories();
  const task = await loadTask(args.taskId);
  if (!task) {
    throw new Error(`Task ${args.taskId} does not exist.`);
  }

  const runtime = await runPreflight(await resolveBrowserRuntime(args.cdpUrl));
  if (!runtime.ok) {
    throw new Error(`Preflight failed: ${JSON.stringify(runtime.preflight_checks, null, 2)}`);
  }

  const replayPlaybook = await loadTrajectoryPlaybook(task.hostname);
  if (replayPlaybook) {
    task.escalation_level = "replay";
    task.trajectory_playbook_ref = task.hostname;
    task.phase_history.push("replay");
    await acquireBrowserOwnership("replay", task.id);

    try {
      const replayResult = await runTrajectoryReplay({
        cdpUrl: runtime.cdp_url,
        task,
        playbook: replayPlaybook,
      });

      task.latest_artifacts.push(...replayResult.artifact_refs);
      task.notes.push(replayResult.detail);
      if (replayResult.ok) {
        task.wait = replayResult.wait;
        task.terminal_class = replayResult.terminal_class;
        task.skip_reason_code = replayResult.skip_reason_code;
        updateTaskStatus(task, replayResult.next_status);
        await saveTask(task);

        return {
          mode: "replay_completed",
          task,
          effective_target_url: task.target_url,
          replay_hit: true,
        };
      }
    } finally {
      await releaseBrowserOwnership();
    }
  }

  if (!runtime.preflight_checks.browser_use_cli.ok) {
    task.wait = {
      wait_reason_code: "BROWSER_USE_CLI_UNAVAILABLE",
      resume_trigger: "Retry after browser-use CLI is installed and visible in PATH.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "data/backlink-helper/runs/latest-preflight.json",
    };
    task.terminal_class = "outcome_not_confirmed";
    task.notes.push("task-prepare stopped because browser-use CLI is unavailable.");
    updateTaskStatus(task, "RETRYABLE");
    await saveTask(task);
    return {
      mode: "task_stopped",
      task,
      effective_target_url: task.target_url,
      replay_hit: Boolean(replayPlaybook),
    };
  }

  task.escalation_level = "scout";
  task.phase_history.push("scout");
  await acquireBrowserOwnership("scout", task.id);

  const scoutArtifactPath = getArtifactFilePath(task.id, "scout");
  try {
    const scout = await runLightweightScout({ runtime, task });
    await writeJsonFile(scoutArtifactPath, scout);
    task.latest_artifacts.push(scoutArtifactPath);
    task.notes.push(scout.surface_summary);

    if (!scout.ok || (scout.page_snapshot.response_status ?? 0) >= 500) {
      task.wait = {
        wait_reason_code: !scout.ok ? "DIRECTORY_NAVIGATION_FAILED" : "DIRECTORY_UPSTREAM_5XX",
        resume_trigger: "Retry later after the directory becomes reachable again.",
        resolution_owner: "system",
        resolution_mode: "auto_resume",
        evidence_ref: scoutArtifactPath,
      };
      task.terminal_class =
        (scout.page_snapshot.response_status ?? 0) >= 500 ? "upstream_5xx" : undefined;
      updateTaskStatus(task, "RETRYABLE");
      await saveTask(task);
      return {
        mode: "task_stopped",
        task,
        effective_target_url: task.target_url,
        replay_hit: Boolean(replayPlaybook),
        scout_artifact_ref: scoutArtifactPath,
        scout,
      };
    }

    if (scout.page_snapshot.url && scout.page_snapshot.url !== task.target_url) {
      task.target_url = scout.page_snapshot.url;
      task.hostname = new URL(scout.page_snapshot.url).hostname;
      task.notes.push(`Canonicalized target URL to ${scout.page_snapshot.url} based on scout.`);
    }

    const accountCandidate = await getAccountForHostname(task.hostname);
    const accountCredentials = accountCandidate?.credential_ref
      ? await getCredential(accountCandidate.credential_ref).catch(() => undefined)
      : undefined;
    if (accountCandidate) {
      task.account_ref = accountCandidate.hostname;
    }

    const registrationRequired =
      !accountCandidate &&
      inferRegistrationRequired(task, [...scout.auth_hints, ...scout.submit_candidates]);
    const registrationEmailAlias = registrationRequired
      ? buildPlusAlias(task.submission.submitter_email, task.hostname)
      : undefined;
    const mailboxQuery = registrationEmailAlias
      ? buildMailboxQuery(registrationEmailAlias)
      : undefined;

    if (registrationRequired && !runtime.preflight_checks.gog.ok) {
      task.wait = {
        wait_reason_code: "GOG_UNAVAILABLE",
        resume_trigger: "Retry after gog is installed and authorized for the mailbox account.",
        resolution_owner: "system",
        resolution_mode: "auto_resume",
        evidence_ref: "data/backlink-helper/runs/latest-preflight.json",
      };
      task.terminal_class = "outcome_not_confirmed";
      task.notes.push("task-prepare stopped because gog is unavailable for an email-registration flow.");
      updateTaskStatus(task, "RETRYABLE");
      await saveTask(task);
      return {
        mode: "task_stopped",
        task,
        effective_target_url: task.target_url,
        replay_hit: Boolean(replayPlaybook),
        scout_artifact_ref: scoutArtifactPath,
        scout,
        account_candidate: accountCandidate,
        account_credentials: accountCredentials,
        registration_required: registrationRequired,
        registration_email_alias: registrationEmailAlias,
        mailbox_query: mailboxQuery,
      };
    }

    await saveTask(task);
    return {
      mode: "ready_for_agent_loop",
      task,
      effective_target_url: task.target_url,
      replay_hit: Boolean(replayPlaybook),
      scout_artifact_ref: scoutArtifactPath,
      scout,
      account_candidate: accountCandidate,
      account_credentials: accountCredentials,
      registration_required: registrationRequired,
      registration_email_alias: registrationEmailAlias,
      mailbox_query: mailboxQuery,
    };
  } finally {
    await releaseBrowserOwnership();
  }
}
