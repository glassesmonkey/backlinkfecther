import { claimNextTask } from "../control-plane/task-queue.js";

export async function runClaimNextTaskCommand(args: { owner: string }): Promise<void> {
  const result = await claimNextTask(args);
  console.log(JSON.stringify(result, null, 2));
}
