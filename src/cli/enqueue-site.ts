import { enqueueSiteTask } from "../control-plane/task-queue.js";

export async function runEnqueueSiteCommand(args: {
  taskId: string;
  directoryUrl: string;
  promotedUrl: string;
  promotedName?: string;
  promotedDescription?: string;
  submitterEmailBase?: string;
  confirmSubmit: boolean;
}): Promise<void> {
  const task = await enqueueSiteTask(args);
  console.log(JSON.stringify(task, null, 2));
}
