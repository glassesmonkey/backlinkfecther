import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import type { TaskRecord } from "../shared/types.js";

export const DATA_ROOT = path.resolve(process.cwd(), "data/backlink-helper");

export const DATA_DIRECTORIES = {
  accounts: path.join(DATA_ROOT, "accounts"),
  artifacts: path.join(DATA_ROOT, "artifacts"),
  playbooks: path.join(DATA_ROOT, "playbooks", "sites"),
  profiles: path.join(DATA_ROOT, "profiles"),
  reports: path.join(DATA_ROOT, "reports"),
  runs: path.join(DATA_ROOT, "runs"),
  runtime: path.join(DATA_ROOT, "runtime"),
  tasks: path.join(DATA_ROOT, "tasks"),
} as const;

export async function ensureDataDirectories(): Promise<void> {
  await Promise.all(
    Object.values(DATA_DIRECTORIES).map((directoryPath) =>
      mkdir(directoryPath, { recursive: true }),
    ),
  );
}

export async function readJsonFile<T>(
  filePath: string,
): Promise<T | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException;
    if (typedError.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
}

export async function writeJsonFile(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function hostnameToKey(hostname: string): string {
  return hostname.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
}

export function getTaskFilePath(taskId: string): string {
  return path.join(DATA_DIRECTORIES.tasks, `${taskId}.json`);
}

export function getArtifactFilePath(taskId: string, artifactName: string): string {
  return path.join(DATA_DIRECTORIES.artifacts, `${taskId}-${artifactName}.json`);
}

export function getOwnershipLockPath(): string {
  return path.join(DATA_DIRECTORIES.runtime, "browser-ownership-lock.json");
}

export function getPlaybookFilePath(hostname: string): string {
  return path.join(DATA_DIRECTORIES.playbooks, `${hostnameToKey(hostname)}.json`);
}

export function getProfileFilePath(hostname: string): string {
  return path.join(DATA_DIRECTORIES.profiles, `${hostnameToKey(hostname)}.json`);
}

export async function loadTask(taskId: string): Promise<TaskRecord | undefined> {
  return readJsonFile<TaskRecord>(getTaskFilePath(taskId));
}

export async function saveTask(task: TaskRecord): Promise<void> {
  await writeJsonFile(getTaskFilePath(task.id), task);
}
