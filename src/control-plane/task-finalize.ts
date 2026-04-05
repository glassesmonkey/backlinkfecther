import { acquireBrowserOwnership, releaseBrowserOwnership } from "../execution/ownership-lock.js";
import { upsertAccountRecord } from "../memory/account-registry.js";
import { putCredential } from "../memory/credential-vault.js";
import {
  clearPendingFinalize,
  clearWorkerLease,
  ensureDataDirectories,
  getPendingFinalizePath,
  loadTask,
  readJsonFile,
  saveTask,
} from "../memory/data-store.js";
import { saveTrajectoryPlaybook } from "../memory/trajectory-playbook.js";
import { resolveBrowserRuntime } from "../shared/browser-runtime.js";
import { generateCredentialRef } from "../shared/email.js";
import { runPreflight } from "../shared/preflight.js";
import type {
  AccountDraft,
  FinalizeResult,
  TakeoverHandoff,
  TaskRecord,
} from "../shared/types.js";
import { runTakeoverFinalization } from "../execution/takeover.js";

interface PendingFinalizeRecord {
  handoff: TakeoverHandoff;
  account?: AccountDraft;
}

function appendUnique(target: string[], values: string[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

export async function finalizeTask(args: {
  taskId: string;
  cdpUrl?: string;
}): Promise<FinalizeResult> {
  await ensureDataDirectories();
  const task = await loadTask(args.taskId);
  if (!task) {
    throw new Error(`Task ${args.taskId} does not exist.`);
  }

  const pendingFinalize = await readJsonFile<PendingFinalizeRecord>(getPendingFinalizePath(args.taskId));
  if (!pendingFinalize?.handoff) {
    throw new Error(`Task ${args.taskId} does not have a pending finalization payload.`);
  }

  const runtime = await runPreflight(await resolveBrowserRuntime(args.cdpUrl));
  if (!runtime.ok) {
    throw new Error(`Preflight failed: ${JSON.stringify(runtime.preflight_checks, null, 2)}`);
  }

  task.phase_history.push("takeover:finalization");
  await acquireBrowserOwnership("finalization:playwright", task.id);

  let finalResult: FinalizeResult;
  try {
    finalResult = await runTakeoverFinalization({
      runtime,
      task,
      handoff: pendingFinalize.handoff,
    });
  } finally {
    await releaseBrowserOwnership();
  }

  task.wait = finalResult.wait;
  task.status = finalResult.next_status;
  task.updated_at = new Date().toISOString();
  task.terminal_class = finalResult.terminal_class;
  task.skip_reason_code = finalResult.skip_reason_code;
  task.last_takeover_outcome = finalResult.detail;
  task.lease_expires_at = undefined;
  appendUnique(task.latest_artifacts, [
    ...pendingFinalize.handoff.artifact_refs,
    ...finalResult.artifact_refs,
  ]);
  task.notes.push(finalResult.detail);

  let accountCreated = false;
  let credentialRef = pendingFinalize.account?.credential_ref;
  if (pendingFinalize.account) {
    if (pendingFinalize.account.credential_payload) {
      credentialRef =
        credentialRef ??
        generateCredentialRef(pendingFinalize.account.hostname, pendingFinalize.account.email_alias);
      await putCredential(credentialRef, pendingFinalize.account.credential_payload);
    }

    const account = await upsertAccountRecord({
      hostname: pendingFinalize.account.hostname,
      email: pendingFinalize.account.email,
      emailAlias: pendingFinalize.account.email_alias,
      authMode: pendingFinalize.account.auth_mode,
      verified:
        pendingFinalize.account.verified ||
        finalResult.next_status === "WAITING_SITE_RESPONSE" ||
        finalResult.next_status === "DONE",
      loginUrl: pendingFinalize.account.login_url,
      submitUrl: pendingFinalize.account.submit_url ?? task.target_url,
      credentialRef,
      registrationResult: pendingFinalize.account.last_registration_result,
    });
    accountCreated = true;
    task.account_ref = account.hostname;
  }

  if (finalResult.playbook) {
    await saveTrajectoryPlaybook(finalResult.playbook);
    task.trajectory_playbook_ref = finalResult.playbook.hostname;
  }

  await saveTask(task);
  await clearPendingFinalize(args.taskId);
  await clearWorkerLease();

  return {
    ...finalResult,
    account_created: accountCreated,
    credential_ref: credentialRef,
  };
}
