import { loadOrCreatePromotedProfile } from "../shared/promoted-profile.js";
import {
  clearPendingFinalize,
  clearWorkerLease,
  ensureDataDirectories,
  listTasks,
  loadTask,
  loadWorkerLease,
  saveTask,
  saveWorkerLease,
} from "../memory/data-store.js";
import { loadBrowserOwnership, reapExpiredBrowserOwnership } from "../execution/ownership-lock.js";
import type { TaskRecord, TaskStatus, WorkerLease } from "../shared/types.js";

const WORKER_LEASE_TTL_MS = 10 * 60 * 1_000 + 30_000;
const RETRY_BACKOFF_MS = 60 * 60 * 1_000;
const MAX_AUTOMATIC_RETRIES = 1;

function buildTask(args: {
  taskId: string;
  directoryUrl: string;
  promotedProfile: TaskRecord["submission"]["promoted_profile"];
  submitterEmailBase?: string;
  confirmSubmit: boolean;
}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: args.taskId,
    target_url: args.directoryUrl,
    hostname: new URL(args.directoryUrl).hostname,
    submission: {
      promoted_profile: args.promotedProfile,
      submitter_email: args.submitterEmailBase,
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

function updateTaskStatus(task: TaskRecord, status: TaskStatus): void {
  task.status = status;
  task.updated_at = new Date().toISOString();
}

function compareByCreatedAt(left: TaskRecord, right: TaskRecord): number {
  return new Date(left.created_at).getTime() - new Date(right.created_at).getTime();
}

function canRetry(task: TaskRecord): boolean {
  if (task.status !== "RETRYABLE") {
    return false;
  }

  if (task.run_count >= MAX_AUTOMATIC_RETRIES + 1) {
    return false;
  }

  return Date.now() - new Date(task.updated_at).getTime() >= RETRY_BACKOFF_MS;
}

async function reapExpiredWorkerLease(): Promise<{ reapedTaskId?: string }> {
  const existingLease = await loadWorkerLease();
  if (!existingLease || new Date(existingLease.expires_at).getTime() > Date.now()) {
    return {};
  }

  await clearWorkerLease();
  await clearPendingFinalize(existingLease.task_id);

  const task = await loadTask(existingLease.task_id);
  if (!task) {
    return { reapedTaskId: existingLease.task_id };
  }

  task.lease_expires_at = undefined;
  task.wait = {
    wait_reason_code: "TASK_TIMEOUT",
    resume_trigger: "A previous bounded worker exceeded the 10 minute runtime lease and will be retried automatically.",
    resolution_owner: "system",
    resolution_mode: "auto_resume",
    evidence_ref: "data/backlink-helper/runtime/task-worker-lease.json",
  };
  task.terminal_class = "outcome_not_confirmed";
  task.notes.push("bounded worker timed out");
  updateTaskStatus(task, "RETRYABLE");
  await saveTask(task);
  return { reapedTaskId: task.id };
}

export async function enqueueSiteTask(args: {
  taskId: string;
  directoryUrl: string;
  promotedUrl: string;
  promotedName?: string;
  promotedDescription?: string;
  submitterEmailBase?: string;
  confirmSubmit: boolean;
}): Promise<TaskRecord> {
  await ensureDataDirectories();

  const promotedProfile = await loadOrCreatePromotedProfile({
    promotedUrl: args.promotedUrl,
    promotedName: args.promotedName,
    promotedDescription: args.promotedDescription,
  });

  const existingTask = await loadTask(args.taskId);
  if (existingTask?.status === "RUNNING") {
    throw new Error(`Task ${args.taskId} is already RUNNING and cannot be re-enqueued.`);
  }

  const task = existingTask
    ? {
        ...existingTask,
        target_url: args.directoryUrl,
        hostname: new URL(args.directoryUrl).hostname,
        submission: {
          promoted_profile: promotedProfile,
          submitter_email: args.submitterEmailBase,
          confirm_submit: args.confirmSubmit,
        },
        wait: undefined,
        skip_reason_code: undefined,
        terminal_class: undefined,
        lease_expires_at: undefined,
      }
    : buildTask({
        taskId: args.taskId,
        directoryUrl: args.directoryUrl,
        promotedProfile,
        submitterEmailBase: args.submitterEmailBase,
        confirmSubmit: args.confirmSubmit,
      });

  updateTaskStatus(task, "READY");
  task.notes.push("Task was enqueued for the bounded single-site worker.");
  await saveTask(task);
  return task;
}

export async function claimNextTask(args: {
  owner: string;
}): Promise<{
  mode: "claimed" | "idle" | "lease_held";
  task?: TaskRecord;
  lease?: WorkerLease;
  reapedTaskId?: string;
}> {
  await ensureDataDirectories();
  const { reapedTaskId } = await reapExpiredWorkerLease();
  await reapExpiredBrowserOwnership();

  const activeLease = await loadWorkerLease();
  if (activeLease && new Date(activeLease.expires_at).getTime() > Date.now()) {
    return {
      mode: "lease_held",
      lease: activeLease,
      reapedTaskId,
    };
  }

  const browserOwnership = await loadBrowserOwnership();
  if (browserOwnership && new Date(browserOwnership.expires_at).getTime() > Date.now()) {
    return {
      mode: "lease_held",
      lease: {
        task_id: browserOwnership.task_id,
        owner: browserOwnership.owner,
        acquired_at: browserOwnership.acquired_at,
        expires_at: browserOwnership.expires_at,
      },
      reapedTaskId,
    };
  }

  const tasks = await listTasks();
  const readyTasks = tasks
    .filter((task) => task.status === "READY")
    .sort(compareByCreatedAt);
  const retryableTasks = tasks
    .filter(canRetry)
    .sort(compareByCreatedAt);

  const nextTask = readyTasks[0] ?? retryableTasks[0];
  if (!nextTask) {
    return {
      mode: "idle",
      reapedTaskId,
    };
  }

  const now = Date.now();
  const lease: WorkerLease = {
    task_id: nextTask.id,
    owner: args.owner,
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + WORKER_LEASE_TTL_MS).toISOString(),
  };

  updateTaskStatus(nextTask, "RUNNING");
  nextTask.wait = undefined;
  nextTask.lease_expires_at = lease.expires_at;
  nextTask.notes.push(`Claimed by ${args.owner} for a bounded worker run.`);
  await saveTask(nextTask);
  await saveWorkerLease(lease);

  return {
    mode: "claimed",
    task: nextTask,
    lease,
    reapedTaskId,
  };
}
