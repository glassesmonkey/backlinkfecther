import { acquireBrowserOwnership, releaseBrowserOwnership } from "../execution/ownership-lock.js";
import { runTrajectoryReplay } from "../execution/replay.js";
import { runLightweightScout } from "../execution/scout.js";
import {
  runAgentDrivenBrowserUseLoop,
  runTakeoverFinalization,
} from "../execution/takeover.js";
import {
  ensureDataDirectories,
  getArtifactFilePath,
  loadTask,
  saveTask,
  writeJsonFile,
} from "../memory/data-store.js";
import { loadTrajectoryPlaybook, saveTrajectoryPlaybook } from "../memory/trajectory-playbook.js";
import { resolveBrowserRuntime } from "../shared/browser-runtime.js";
import { validateAgentBackendConfig } from "../agent/decider.js";
import { runPreflight } from "../shared/preflight.js";
import { loadOrCreatePromotedProfile } from "../shared/promoted-profile.js";
import type { PromotedProfile, TaskRecord, TaskStatus } from "../shared/types.js";

function buildTask(args: {
  taskId: string;
  directoryUrl: string;
  promotedProfile: PromotedProfile;
  submitterEmail?: string;
  confirmSubmit: boolean;
}): TaskRecord {
  const hostname = new URL(args.directoryUrl).hostname;
  const now = new Date().toISOString();

  return {
    id: args.taskId,
    target_url: args.directoryUrl,
    hostname,
    submission: {
      promoted_profile: args.promotedProfile,
      submitter_email: args.submitterEmail,
      confirm_submit: args.confirmSubmit,
    },
    status: "READY",
    created_at: now,
    updated_at: now,
    run_count: 0,
    escalation_level: "none",
    takeover_attempts: 0,
    phase_history: [],
    latest_artifacts: [],
    notes: [],
  };
}

function refreshTask(task: TaskRecord, args: {
  directoryUrl: string;
  promotedProfile: PromotedProfile;
  submitterEmail?: string;
  confirmSubmit: boolean;
}): TaskRecord {
  task.target_url = args.directoryUrl;
  task.hostname = new URL(args.directoryUrl).hostname;
  task.submission = {
    promoted_profile: args.promotedProfile,
    submitter_email: args.submitterEmail ?? task.submission?.submitter_email,
    confirm_submit: args.confirmSubmit,
  };
  return task;
}

function updateTaskStatus(task: TaskRecord, status: TaskStatus): void {
  task.status = status;
  task.updated_at = new Date().toISOString();
}

function appendUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

export async function runNextTask(args: {
  taskId: string;
  directoryUrl: string;
  promotedUrl: string;
  promotedName?: string;
  promotedDescription?: string;
  submitterEmail?: string;
  confirmSubmit: boolean;
  cdpUrl?: string;
}): Promise<{ task: TaskRecord; runtime_ok: boolean }> {
  await ensureDataDirectories();

  const promotedProfile = await loadOrCreatePromotedProfile({
    promotedUrl: args.promotedUrl,
    promotedName: args.promotedName,
    promotedDescription: args.promotedDescription,
  });

  const runtime = await runPreflight(await resolveBrowserRuntime(args.cdpUrl));
  if (!runtime.ok) {
    throw new Error(
      `Preflight failed: ${JSON.stringify(runtime.preflight_checks, null, 2)}`,
    );
  }

  const existingTask = await loadTask(args.taskId);
  const task = existingTask
    ? refreshTask(existingTask, {
        directoryUrl: args.directoryUrl,
        promotedProfile,
        submitterEmail: args.submitterEmail,
        confirmSubmit: args.confirmSubmit,
      })
    : buildTask({
        taskId: args.taskId,
        directoryUrl: args.directoryUrl,
        promotedProfile,
        submitterEmail: args.submitterEmail,
        confirmSubmit: args.confirmSubmit,
      });

  task.run_count += 1;
  task.wait = undefined;
  task.terminal_class = undefined;
  task.skip_reason_code = undefined;
  updateTaskStatus(task, "RUNNING");
  await saveTask(task);

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
        return { task, runtime_ok: true };
      }
    } finally {
      await releaseBrowserOwnership();
    }
  }

  if (!runtime.preflight_checks.browser_use_cli.ok) {
    task.last_takeover_outcome = "Agent-first execution requires browser-use CLI, but it is unavailable in the current runtime.";
    task.wait = {
      wait_reason_code: "BROWSER_USE_CLI_UNAVAILABLE",
      resume_trigger: "Retry after browser-use CLI is installed and visible in PATH.",
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "runs/latest-preflight.json",
    };
    task.terminal_class = "outcome_not_confirmed";
    task.notes.push(task.last_takeover_outcome);
    updateTaskStatus(task, "RETRYABLE");
    await saveTask(task);
    return { task, runtime_ok: true };
  }

  const agentBackendValidation = validateAgentBackendConfig();
  if (!agentBackendValidation.ok) {
    task.last_takeover_outcome = "Agent-first execution requires a configured agent backend, but the current backend validation failed.";
    task.wait = {
      wait_reason_code: "AGENT_BACKEND_UNAVAILABLE",
      resume_trigger: agentBackendValidation.detail,
      resolution_owner: "system",
      resolution_mode: "auto_resume",
      evidence_ref: "runs/latest-preflight.json",
    };
    task.terminal_class = "outcome_not_confirmed";
    task.notes.push(task.last_takeover_outcome);
    updateTaskStatus(task, "RETRYABLE");
    await saveTask(task);
    return { task, runtime_ok: true };
  }

  task.escalation_level = "scout";
  task.phase_history.push("scout");
  await acquireBrowserOwnership("scout", task.id);

  let scoutArtifactPath = getArtifactFilePath(task.id, "scout");
  let effectiveTargetUrl = task.target_url;
  let scoutResult;
  try {
    scoutResult = await runLightweightScout({ runtime, task });
    await writeJsonFile(scoutArtifactPath, scoutResult);
    task.latest_artifacts.push(scoutArtifactPath);
    task.notes.push(scoutResult.surface_summary);

    if (!scoutResult.ok || (scoutResult.page_snapshot.response_status ?? 0) >= 500) {
      task.wait = {
        wait_reason_code: !scoutResult.ok ? "DIRECTORY_NAVIGATION_FAILED" : "DIRECTORY_UPSTREAM_5XX",
        resume_trigger: "Retry later after the directory becomes reachable again.",
        resolution_owner: "system",
        resolution_mode: "auto_resume",
        evidence_ref: scoutArtifactPath,
      };
      task.terminal_class =
        (scoutResult.page_snapshot.response_status ?? 0) >= 500 ? "upstream_5xx" : undefined;
      updateTaskStatus(task, "RETRYABLE");
      await saveTask(task);
      return { task, runtime_ok: true };
    }

    if (scoutResult.page_snapshot.url && scoutResult.page_snapshot.url !== task.target_url) {
      effectiveTargetUrl = scoutResult.page_snapshot.url;
      task.target_url = scoutResult.page_snapshot.url;
      task.hostname = new URL(scoutResult.page_snapshot.url).hostname;
      task.notes.push(`Canonicalized target URL to ${scoutResult.page_snapshot.url} based on scout.`);
    }
  } finally {
    await releaseBrowserOwnership();
  }

  task.escalation_level = "takeover";
  task.takeover_attempts += 1;
  task.last_takeover_at = new Date().toISOString();
  const takeoverTask = {
    ...task,
    target_url: effectiveTargetUrl,
  };
  const takeoverArtifacts: string[] = [];
  const takeoverNotes: string[] = [];

  task.phase_history.push("takeover:agent-loop");
  await acquireBrowserOwnership("takeover:agent-loop", task.id);

  let agentLoopResult;
  try {
    agentLoopResult = await runAgentDrivenBrowserUseLoop({
      runtime,
      task: takeoverTask,
      scout: scoutResult,
    });
  } finally {
    await releaseBrowserOwnership();
  }

  if (agentLoopResult.takeover_result) {
    const takeoverResult = agentLoopResult.takeover_result;
    task.last_takeover_outcome = takeoverResult.detail;
    appendUnique(task.latest_artifacts, [...takeoverArtifacts, ...takeoverResult.artifact_refs]);
    if (takeoverResult.wait) {
      task.wait = takeoverResult.wait;
    }
    task.terminal_class = takeoverResult.terminal_class;
    task.skip_reason_code = takeoverResult.skip_reason_code;
    task.notes.push(...takeoverNotes, takeoverResult.detail);
    updateTaskStatus(task, takeoverResult.next_status);
    await saveTask(task);
    return { task, runtime_ok: true };
  }

  if (!agentLoopResult.handoff) {
    throw new Error("Agent-driven browser-use loop returned neither a final result nor a finalization handoff.");
  }

  takeoverArtifacts.push(...agentLoopResult.handoff.artifact_refs);
  takeoverNotes.push(agentLoopResult.handoff.detail);

  task.phase_history.push("takeover:finalization");
  await acquireBrowserOwnership("finalization:playwright", task.id);

  try {
    const takeoverResult = await runTakeoverFinalization({
      runtime,
      task: takeoverTask,
      handoff: agentLoopResult.handoff,
    });

    task.last_takeover_outcome = takeoverResult.detail;
    appendUnique(task.latest_artifacts, [...takeoverArtifacts, ...takeoverResult.artifact_refs]);
    if (takeoverResult.wait) {
      task.wait = takeoverResult.wait;
    }
    task.terminal_class = takeoverResult.terminal_class;
    task.skip_reason_code = takeoverResult.skip_reason_code;
    task.notes.push(...takeoverNotes, takeoverResult.detail);

    if (takeoverResult.playbook) {
      await saveTrajectoryPlaybook(takeoverResult.playbook);
      task.trajectory_playbook_ref = task.hostname;
    }

    updateTaskStatus(task, takeoverResult.next_status);
    await saveTask(task);

    return { task, runtime_ok: true };
  } finally {
    await releaseBrowserOwnership();
  }
}
