import { getOwnershipLockPath, readJsonFile, writeJsonFile } from "../memory/data-store.js";

export type BrowserOwner = "scout" | "takeover" | "replay";

interface OwnershipLock {
  owner: BrowserOwner;
  task_id: string;
  acquired_at: string;
  expires_at: string;
}

export async function acquireBrowserOwnership(
  owner: BrowserOwner,
  taskId: string,
  ttlMs = 10 * 60 * 1000,
): Promise<void> {
  const lockPath = getOwnershipLockPath();
  const existing = await readJsonFile<OwnershipLock>(lockPath);

  if (existing && new Date(existing.expires_at).getTime() > Date.now()) {
    throw new Error(
      `Browser is currently owned by ${existing.owner} for task ${existing.task_id} until ${existing.expires_at}.`,
    );
  }

  const now = Date.now();
  await writeJsonFile(lockPath, {
    owner,
    task_id: taskId,
    acquired_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
  } satisfies OwnershipLock);
}

export async function releaseBrowserOwnership(): Promise<void> {
  await writeJsonFile(getOwnershipLockPath(), {
    owner: "scout",
    task_id: "released",
    acquired_at: new Date(0).toISOString(),
    expires_at: new Date(0).toISOString(),
  });
}
