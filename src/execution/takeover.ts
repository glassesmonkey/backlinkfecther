import path from "node:path";

import { createAgentDecider } from "../agent/decider.js";
import {
  clickBrowserUseElement,
  getBrowserUseSnapshot,
  inputBrowserUseElement,
  openBrowserUseUrl,
  saveBrowserUseScreenshot,
  selectBrowserUseElement,
  sendBrowserUseKeys,
  settleBrowserUsePage,
  waitForBrowserUseSelector,
  waitForBrowserUseText,
} from "./browser-use-cli.js";
import {
  DATA_DIRECTORIES,
  getArtifactFilePath,
  writeJsonFile,
} from "../memory/data-store.js";
import { withConnectedPage } from "../shared/playwright-session.js";
import type {
  AgentDecision,
  AgentDecisionAction,
  AgentDecisionInput,
  AgentLoopTrace,
  AgentLoopTraceStep,
  AgentObservation,
  AgentObservationElement,
  BrowserRuntime,
  ReplayStep,
  ScoutResult,
  TakeoverResult,
  TaskRecord,
  TerminalClass,
  TrajectoryPlaybook,
  WaitMetadata,
} from "../shared/types.js";

export interface ProposedOutcome {
  next_status: TakeoverResult["next_status"];
  detail: string;
  wait?: WaitMetadata;
  terminal_class?: TerminalClass;
  skip_reason_code?: string;
}

export interface TakeoverHandoff {
  detail: string;
  artifact_refs: string[];
  current_url: string;
  recorded_steps: ReplayStep[];
  agent_trace_ref: string;
  agent_backend: string;
  agent_steps_count: number;
  proposed_outcome?: ProposedOutcome;
}

export interface AgentLoopResult {
  handoff?: TakeoverHandoff;
  takeover_result?: TakeoverResult;
}

export const UNATTENDED_POLICY = {
  allow_paid_listing: false,
  allow_reciprocal: false,
  allow_captcha_bypass: false,
  allow_google_oauth_chooser: true,
  allow_password_login: false,
  allow_2fa: false,
} as const;

const AGENT_LOOP_MAX_DURATION_MS = 15 * 60 * 1_000;
const AGENT_LOOP_MAX_ACTIONS = 120;
const MAX_REPEATED_SURFACE_COUNT = 4;
const MAX_REPEATED_ACTION_COUNT = 3;
const MAX_NO_PROGRESS_STREAK = 12;
const MAX_STATE_ELEMENTS = 120;

function inferWait(
  code: string,
  resolutionOwner: WaitMetadata["resolution_owner"],
  resolutionMode: WaitMetadata["resolution_mode"],
  resumeTrigger: string,
  evidenceRef: string,
): WaitMetadata {
  return {
    wait_reason_code: code,
    resume_trigger: resumeTrigger,
    resolution_owner: resolutionOwner,
    resolution_mode: resolutionMode,
    evidence_ref: evidenceRef,
  };
}

function inferTerminalAuditWait(
  code: string,
  evidenceRef: string,
  summary: string,
): WaitMetadata {
  return inferWait(
    code,
    "none",
    "terminal_audit",
    `Terminal audit only. ${summary}`,
    evidenceRef,
  );
}

function inferAutoResumeWait(
  code: string,
  owner: WaitMetadata["resolution_owner"],
  resumeTrigger: string,
  evidenceRef: string,
): WaitMetadata {
  return inferWait(code, owner, "auto_resume", resumeTrigger, evidenceRef);
}

function looksLikePaidGate(bodyText: string): boolean {
  const normalized = bodyText.toLowerCase();
  return (
    normalized.includes("sponsor") ||
    normalized.includes("subscription") ||
    normalized.includes("paid listing") ||
    normalized.includes("one-time payment") ||
    normalized.includes("submit pay") ||
    normalized.includes("checkout") ||
    normalized.includes("stripe") ||
    normalized.includes("upgrade listing") ||
    /pricing[\s\S]{0,40}(popular|business|plan|\$)/i.test(bodyText) ||
    /\$\s?\d/.test(bodyText)
  );
}

function isAllowedGoogleOauthTransition(bodyText: string, currentUrl: string): boolean {
  const normalized = bodyText.toLowerCase();
  return (
    UNATTENDED_POLICY.allow_google_oauth_chooser &&
    (currentUrl.includes("accounts.google.com") ||
      normalized.includes("continue with google") ||
      normalized.includes("login with google") ||
      normalized.includes("sign in with google"))
  );
}

function inferCurrentOutcome(args: {
  currentUrl: string;
  bodyText: string;
  evidenceRef: string;
}): ProposedOutcome {
  const normalized = args.bodyText.toLowerCase();

  if (looksLikePaidGate(args.bodyText)) {
    return {
      next_status: "WAITING_POLICY_DECISION",
      detail: "Directory reached a paid or sponsored listing flow and was classified as a terminal audit state.",
      wait: inferTerminalAuditWait(
        "PAID_OR_SPONSORED_LISTING",
        args.evidenceRef,
        "Payment and sponsorship decisions are reported for audit, not resumed automatically.",
      ),
      terminal_class: "paid_listing",
    };
  }

  if (
    normalized.includes("captcha") ||
    normalized.includes("loading captcha") ||
    normalized.includes("i'm not a robot") ||
    normalized.includes("verify you are human")
  ) {
    return {
      next_status: "WAITING_POLICY_DECISION",
      detail: "Submission hit CAPTCHA or managed bot verification and was classified as a terminal audit state.",
      wait: inferTerminalAuditWait(
        "CAPTCHA_BLOCKED",
        args.evidenceRef,
        "CAPTCHA and managed anti-bot gates are not resumed automatically.",
      ),
      terminal_class: "captcha_blocked",
    };
  }

  if (!isAllowedGoogleOauthTransition(args.bodyText, args.currentUrl)) {
    if (
      normalized.includes("password") ||
      normalized.includes("sign in") ||
      normalized.includes("log in") ||
      normalized.includes("2fa") ||
      normalized.includes("two-factor") ||
      normalized.includes("passkey") ||
      normalized.includes("verify it's you") ||
      normalized.includes("login")
    ) {
      return {
        next_status: "WAITING_MANUAL_AUTH",
        detail: "Directory requires unsupported authentication for unattended mode and was classified as a terminal audit state.",
        wait: inferTerminalAuditWait(
          "DIRECTORY_LOGIN_REQUIRED",
          args.evidenceRef,
          "Password, 2FA, suspicious-login, or unsupported auth flows are not resumed automatically.",
        ),
        terminal_class: "login_required",
      };
    }
  }

  if (
    normalized.includes("check your email") ||
    normalized.includes("verify your email") ||
    normalized.includes("confirmation email")
  ) {
    return {
      next_status: "WAITING_EXTERNAL_EVENT",
      detail: "Directory is waiting for email verification.",
      wait: inferAutoResumeWait(
        "EMAIL_VERIFICATION_PENDING",
        "gog",
        "Wait for gog to fetch the verification email or magic link automatically.",
        args.evidenceRef,
      ),
    };
  }

  if (
    normalized.includes("thank you") ||
    normalized.includes("pending review") ||
    normalized.includes("we will review") ||
    normalized.includes("submission received")
  ) {
    return {
      next_status: "WAITING_SITE_RESPONSE",
      detail: "Submission appears to be accepted and waiting for directory review.",
      wait: inferAutoResumeWait(
        "SITE_RESPONSE_PENDING",
        "system",
        "Keep polling or reporting until the directory publishes a final review outcome.",
        args.evidenceRef,
      ),
    };
  }

  return {
    next_status: "RETRYABLE",
    detail: "Takeover could not confirm a successful submission state.",
    wait: inferAutoResumeWait(
      "OUTCOME_NOT_CONFIRMED",
      "system",
      "Retry automatically later or inspect the latest artifact to improve the agent loop.",
      args.evidenceRef,
    ),
    terminal_class: "outcome_not_confirmed",
  };
}

function buildPlaybook(args: {
  task: TaskRecord;
  currentUrl: string;
  recordedSteps: ReplayStep[];
  detail: string;
  agentTraceRef: string;
  agentBackend: string;
}): TrajectoryPlaybook {
  return {
    id: `playbook-${args.task.hostname}`,
    hostname: args.task.hostname,
    capture_source: "agent_live_takeover",
    surface_signature: `${args.task.hostname}:${args.currentUrl}`,
    preconditions: [`Reach ${args.task.target_url}`],
    steps: args.recordedSteps,
    anchors: [args.task.hostname, args.task.submission.promoted_profile.name],
    postconditions: [args.detail],
    success_signals: ["thank you", "pending review", "submission received", "check your email"],
    fallback_notes: ["If replay fails, rerun scout and the agent-driven browser-use loop."],
    replay_confidence: 0.6,
    distilled_from_trace_ref: args.agentTraceRef,
    agent_backend: args.agentBackend,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function deriveAllowedActions(element: { descriptor: string }): AgentObservationElement["allowed_actions"] {
  const descriptor = element.descriptor.toLowerCase();
  const allowedActions = new Set<AgentObservationElement["allowed_actions"][number]>(["click_index"]);

  if (
    descriptor.includes("<input") ||
    descriptor.includes("<textarea") ||
    descriptor.includes("role=textbox") ||
    descriptor.includes("textbox")
  ) {
    allowedActions.add("input_index");
  }

  if (
    descriptor.includes("<select") ||
    descriptor.includes("role=combobox") ||
    descriptor.includes("combobox")
  ) {
    allowedActions.add("select_index");
  }

  return [...allowedActions];
}

function buildObservation(args: {
  snapshot: Awaited<ReturnType<typeof getBrowserUseSnapshot>>;
}): AgentObservation {
  return {
    url: args.snapshot.url,
    title: args.snapshot.title,
    raw_text_excerpt: args.snapshot.raw_text.slice(0, 4_000),
    elements: args.snapshot.elements.slice(0, MAX_STATE_ELEMENTS).map((element) => ({
      index: element.index,
      descriptor: element.descriptor,
      text: element.text,
      allowed_actions: deriveAllowedActions(element),
    })),
  };
}

function findObservedElement(
  observation: AgentObservation,
  index: number | undefined,
): AgentObservationElement | undefined {
  if (typeof index !== "number") {
    return undefined;
  }

  return observation.elements.find((element) => element.index === index);
}

function extractDescriptorAttribute(
  descriptor: string,
  attributeName: string,
): string | undefined {
  const patterns = [
    new RegExp(`${attributeName}="([^"]+)"`, "i"),
    new RegExp(`${attributeName}='([^']+)'`, "i"),
    new RegExp(`${attributeName}=([^\\s>]+)`, "i"),
  ];

  for (const pattern of patterns) {
    const match = descriptor.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return undefined;
}

function inferReplaySelector(
  element: AgentObservationElement,
): string | undefined {
  const id = extractDescriptorAttribute(element.descriptor, "id");
  if (id) {
    return `#${id}`;
  }

  const name = extractDescriptorAttribute(element.descriptor, "name");
  if (name) {
    const tagName = element.descriptor.match(/<([a-z0-9-]+)/i)?.[1]?.toLowerCase();
    if (tagName) {
      return `${tagName}[name="${name}"]`;
    }

    return `[name="${name}"]`;
  }

  const ariaLabel = extractDescriptorAttribute(element.descriptor, "aria-label");
  if (ariaLabel) {
    return `[aria-label="${ariaLabel}"]`;
  }

  return undefined;
}

function inferReplayClickStep(
  element: AgentObservationElement | undefined,
): ReplayStep | undefined {
  if (!element) {
    return undefined;
  }

  const stableText = element.text.trim();
  if (stableText && stableText.length <= 100) {
    return { action: "click_text", text: stableText };
  }

  const selector = inferReplaySelector(element);
  if (selector) {
    return { action: "click_selector", selector };
  }

  return undefined;
}

function inferReplayInputStep(args: {
  element: AgentObservationElement | undefined;
  value: string;
}): ReplayStep | undefined {
  if (!args.element) {
    return undefined;
  }

  const placeholder = extractDescriptorAttribute(args.element.descriptor, "placeholder");
  if (placeholder) {
    return { action: "fill_placeholder", placeholder, value: args.value };
  }

  const selector = inferReplaySelector(args.element);
  if (selector) {
    return { action: "fill_selector", selector, value: args.value };
  }

  return undefined;
}

function inferReplaySelectStep(args: {
  element: AgentObservationElement | undefined;
  value: string;
}): ReplayStep | undefined {
  if (!args.element) {
    return undefined;
  }

  const selector = inferReplaySelector(args.element);
  if (selector) {
    return { action: "select_selector", selector, value: args.value };
  }

  return undefined;
}

function buildReplayStepFromDecision(args: {
  decision: AgentDecision;
  observation: AgentObservation;
}): ReplayStep | undefined {
  const { decision, observation } = args;
  const element = findObservedElement(observation, decision.index);

  switch (decision.action) {
    case "open_url":
      return decision.url ? { action: "goto", url: decision.url } : undefined;
    case "click_index":
      return inferReplayClickStep(element);
    case "input_index":
      return typeof decision.text === "string"
        ? inferReplayInputStep({ element, value: decision.text })
        : undefined;
    case "select_index":
      return typeof decision.value === "string"
        ? inferReplaySelectStep({ element, value: decision.value })
        : undefined;
    case "keys":
      return decision.keys ? { action: "press_key", key: decision.keys } : undefined;
    case "wait":
      if (!decision.wait_kind || !decision.wait_target) {
        return undefined;
      }

      if (decision.wait_kind === "text") {
        return {
          action: "wait_for_text",
          text: decision.wait_target,
          timeout_ms: decision.wait_timeout_ms,
        };
      }

      return {
        action: "wait_for_selector",
        selector: decision.wait_target,
        timeout_ms: decision.wait_timeout_ms,
        state: decision.wait_state,
      };
    case "finish_submission_attempt":
    case "classify_terminal":
    case "abort_retryable":
      return undefined;
  }
}

function buildWaitFromDecision(
  decision: AgentDecision,
  evidenceRef: string,
): WaitMetadata | undefined {
  if (!decision.next_status || !decision.wait_reason_code) {
    return undefined;
  }

  if (decision.next_status === "WAITING_POLICY_DECISION") {
    return inferTerminalAuditWait(
      decision.wait_reason_code,
      evidenceRef,
      decision.resume_trigger ?? decision.detail ?? "Agent classified this page as a policy boundary.",
    );
  }

  if (decision.next_status === "WAITING_MANUAL_AUTH") {
    return inferTerminalAuditWait(
      decision.wait_reason_code,
      evidenceRef,
      decision.resume_trigger ?? decision.detail ?? "Agent classified this page as unsupported authentication.",
    );
  }

  if (decision.next_status === "WAITING_MISSING_INPUT") {
    return inferTerminalAuditWait(
      decision.wait_reason_code,
      evidenceRef,
      decision.resume_trigger ?? decision.detail ?? "Agent classified this page as missing required inputs.",
    );
  }

  return inferWait(
    decision.wait_reason_code,
    decision.resolution_owner ?? "system",
    decision.resolution_mode ?? "auto_resume",
    decision.resume_trigger ?? decision.detail ?? "Agent requested an explicit wait state.",
    evidenceRef,
  );
}

function normalizeAgentProposal(
  decision: AgentDecision,
  evidenceRef: string,
): ProposedOutcome {
  return {
    next_status: decision.next_status ?? "RETRYABLE",
    detail: decision.detail ?? decision.reason,
    wait: buildWaitFromDecision(decision, evidenceRef),
    terminal_class: decision.terminal_class,
    skip_reason_code: decision.skip_reason_code,
  };
}

function buildRetryableOutcome(args: {
  detail: string;
  evidenceRef: string;
}): ProposedOutcome {
  return {
    next_status: "RETRYABLE",
    detail: args.detail,
    wait: inferAutoResumeWait(
      "OUTCOME_NOT_CONFIRMED",
      "system",
      "Retry automatically later or inspect the latest agent trace before adjusting the loop.",
      args.evidenceRef,
    ),
    terminal_class: "outcome_not_confirmed",
  };
}

function chooseFinalOutcome(args: {
  inferred: ProposedOutcome;
  proposed?: ProposedOutcome;
}): ProposedOutcome {
  if (!args.proposed) {
    return args.inferred;
  }

  if (args.proposed.next_status === "RETRYABLE" && args.inferred.next_status !== "RETRYABLE") {
    return args.inferred;
  }

  return args.proposed;
}

function actionSignature(decision: AgentDecision): string {
  return [
    decision.action,
    decision.url ?? "",
    decision.index ?? "",
    decision.text ?? "",
    decision.value ?? "",
    decision.keys ?? "",
    decision.wait_kind ?? "",
    decision.wait_target ?? "",
  ].join("|");
}

function buildRecentActions(traceSteps: AgentLoopTraceStep[]): AgentDecisionInput["recent_actions"] {
  return traceSteps.slice(-8).map((step) => ({
    step_number: step.step_number,
    action: step.decision.action,
    detail: step.execution.detail,
    result: step.execution.ok ? "ok" : "failed",
  }));
}

async function executeAgentDecision(args: {
  runtime: BrowserRuntime;
  session: string;
  decision: AgentDecision;
  observation: AgentObservation;
  recordedSteps: ReplayStep[];
}): Promise<{ ok: boolean; detail: string }> {
  const { decision } = args;
  const replayStep = buildReplayStepFromDecision({
    decision,
    observation: args.observation,
  });

  switch (decision.action) {
    case "open_url":
      if (!decision.url) {
        throw new Error("Agent returned open_url without a url.");
      }

      await openBrowserUseUrl({
        cdpUrl: args.runtime.cdp_url,
        session: args.session,
        url: decision.url,
      });
      if (replayStep) {
        args.recordedSteps.push(replayStep);
      }
      return { ok: true, detail: `Opened ${decision.url}.` };

    case "click_index":
      if (typeof decision.index !== "number") {
        throw new Error("Agent returned click_index without an index.");
      }

      await clickBrowserUseElement({
        cdpUrl: args.runtime.cdp_url,
        session: args.session,
        index: decision.index,
      });
      if (replayStep) {
        args.recordedSteps.push(replayStep);
      }
      return { ok: true, detail: `Clicked browser-use element ${decision.index}.` };

    case "input_index":
      if (typeof decision.index !== "number" || typeof decision.text !== "string") {
        throw new Error("Agent returned input_index without an index or text.");
      }

      await inputBrowserUseElement({
        cdpUrl: args.runtime.cdp_url,
        session: args.session,
        index: decision.index,
        text: decision.text,
      });
      if (replayStep) {
        args.recordedSteps.push(replayStep);
      }
      return { ok: true, detail: `Filled browser-use element ${decision.index}.` };

    case "select_index":
      if (typeof decision.index !== "number" || typeof decision.value !== "string") {
        throw new Error("Agent returned select_index without an index or value.");
      }

      await selectBrowserUseElement({
        cdpUrl: args.runtime.cdp_url,
        session: args.session,
        index: decision.index,
        value: decision.value,
      });
      if (replayStep) {
        args.recordedSteps.push(replayStep);
      }
      return { ok: true, detail: `Selected "${decision.value}" on browser-use element ${decision.index}.` };

    case "keys":
      if (!decision.keys) {
        throw new Error("Agent returned keys without a key chord.");
      }

      await sendBrowserUseKeys({
        cdpUrl: args.runtime.cdp_url,
        session: args.session,
        keys: decision.keys,
      });
      if (replayStep) {
        args.recordedSteps.push(replayStep);
      }
      return { ok: true, detail: `Sent browser-use keys "${decision.keys}".` };

    case "wait":
      if (!decision.wait_kind || !decision.wait_target) {
        throw new Error("Agent returned wait without wait_kind or wait_target.");
      }

      if (decision.wait_kind === "text") {
        await waitForBrowserUseText({
          cdpUrl: args.runtime.cdp_url,
          session: args.session,
          text: decision.wait_target,
          timeoutMs: decision.wait_timeout_ms,
        });
      } else {
        await waitForBrowserUseSelector({
          cdpUrl: args.runtime.cdp_url,
          session: args.session,
          selector: decision.wait_target,
          state: decision.wait_state,
          timeoutMs: decision.wait_timeout_ms,
        });
      }

      if (replayStep) {
        args.recordedSteps.push(replayStep);
      }
      return { ok: true, detail: `Waited for ${decision.wait_kind} "${decision.wait_target}".` };

    case "finish_submission_attempt":
    case "classify_terminal":
    case "abort_retryable":
      return { ok: true, detail: decision.detail ?? decision.reason };
  }
}

function buildTraceStep(args: {
  stepNumber: number;
  observation: AgentObservation;
  decision: AgentDecision;
  ok: boolean;
  detail: string;
  beforeUrl: string;
  afterUrl: string;
  durationMs: number;
}): AgentLoopTraceStep {
  return {
    step_number: args.stepNumber,
    observation: args.observation,
    decision: args.decision,
    execution: {
      ok: args.ok,
      detail: args.detail,
      before_url: args.beforeUrl,
      after_url: args.afterUrl,
      duration_ms: args.durationMs,
    },
  };
}

function buildTraceArtifact(args: {
  task: TaskRecord;
  agentBackend: string;
  startedAt: string;
  stopReason: string;
  finalObservation: AgentObservation;
  steps: AgentLoopTraceStep[];
}): AgentLoopTrace {
  return {
    task_id: args.task.id,
    agent_backend: args.agentBackend,
    started_at: args.startedAt,
    finished_at: new Date().toISOString(),
    stop_reason: args.stopReason,
    final_url: args.finalObservation.url,
    final_title: args.finalObservation.title,
    final_excerpt: args.finalObservation.raw_text_excerpt,
    steps: args.steps,
  };
}

export async function runAgentDrivenBrowserUseLoop(args: {
  runtime: BrowserRuntime;
  task: TaskRecord;
  scout: ScoutResult;
}): Promise<AgentLoopResult> {
  const decider = createAgentDecider();
  const session = `task-${args.task.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40);
  const tracePath = getArtifactFilePath(args.task.id, "agent-loop");
  const screenshotPath = path.join(DATA_DIRECTORIES.artifacts, `${args.task.id}-agent-loop.png`);
  const recordedSteps: ReplayStep[] = [];
  const traceSteps: AgentLoopTraceStep[] = [];
  const surfaceCounts = new Map<string, number>();
  const actionCounts = new Map<string, number>();
  const startedAtIso = new Date().toISOString();
  const startedAtMs = Date.now();

  try {
    const openedUrl = await openBrowserUseUrl({
      cdpUrl: args.runtime.cdp_url,
      session,
      url: args.task.target_url,
    });
    recordedSteps.push({ action: "goto", url: openedUrl });

    let snapshot = await getBrowserUseSnapshot({
      cdpUrl: args.runtime.cdp_url,
      session,
    });
    let observation = buildObservation({ snapshot });
    let noProgressStreak = 0;
    let stopReason = "agent_requested_finalization";
    let proposedOutcome: ProposedOutcome | undefined;

    for (let stepNumber = 1; stepNumber <= AGENT_LOOP_MAX_ACTIONS; stepNumber += 1) {
      const surfaceSignature = `${observation.url}\n${observation.raw_text_excerpt}`;
      const repeatedSurfaceCount = (surfaceCounts.get(surfaceSignature) ?? 0) + 1;
      surfaceCounts.set(surfaceSignature, repeatedSurfaceCount);

      if (Date.now() - startedAtMs >= AGENT_LOOP_MAX_DURATION_MS) {
        stopReason = "agent_loop_timeout";
        proposedOutcome = buildRetryableOutcome({
          detail: "Agent loop hit the maximum runtime budget before it could confidently stop.",
          evidenceRef: tracePath,
        });
        break;
      }

      if (repeatedSurfaceCount >= MAX_REPEATED_SURFACE_COUNT) {
        stopReason = "repeated_surface_detected";
        proposedOutcome = buildRetryableOutcome({
          detail: "Agent loop revisited the same surface too many times without converging.",
          evidenceRef: tracePath,
        });
        break;
      }

      if (noProgressStreak >= MAX_NO_PROGRESS_STREAK) {
        stopReason = "no_progress_limit_reached";
        proposedOutcome = buildRetryableOutcome({
          detail: "Agent loop stopped after too many actions without new evidence.",
          evidenceRef: tracePath,
        });
        break;
      }

      const decisionInput: AgentDecisionInput = {
        task_id: args.task.id,
        hostname: args.task.hostname,
        submission: args.task.submission,
        scout_hints: {
          field_hints: args.scout.field_hints,
          auth_hints: args.scout.auth_hints,
          anti_bot_hints: args.scout.anti_bot_hints,
          submit_candidates: args.scout.submit_candidates,
        },
        observation,
        recent_actions: buildRecentActions(traceSteps),
        budget: {
          elapsed_ms: Date.now() - startedAtMs,
          remaining_actions: AGENT_LOOP_MAX_ACTIONS - stepNumber + 1,
          repeated_surface_count: repeatedSurfaceCount,
          repeated_action_count: 0,
          no_progress_streak: noProgressStreak,
        },
        policy: UNATTENDED_POLICY,
      };

      const decision = await decider.decide(decisionInput);
      const decisionSignature = actionSignature(decision);
      const repeatedActionCount = (actionCounts.get(decisionSignature) ?? 0) + 1;
      actionCounts.set(decisionSignature, repeatedActionCount);

      if (repeatedActionCount >= MAX_REPEATED_ACTION_COUNT) {
        stopReason = "repeated_action_detected";
        proposedOutcome = buildRetryableOutcome({
          detail: "Agent loop repeated the same action too many times without converging.",
          evidenceRef: tracePath,
        });
        break;
      }

      if (decision.action === "classify_terminal") {
        traceSteps.push(
          buildTraceStep({
            stepNumber,
            observation,
            decision,
            ok: true,
            detail: decision.detail ?? decision.reason,
            beforeUrl: observation.url,
            afterUrl: observation.url,
            durationMs: 0,
          }),
        );
        stopReason = "agent_classified_terminal";
        proposedOutcome = normalizeAgentProposal(decision, tracePath);
        break;
      }

      if (decision.action === "abort_retryable") {
        traceSteps.push(
          buildTraceStep({
            stepNumber,
            observation,
            decision,
            ok: true,
            detail: decision.detail ?? decision.reason,
            beforeUrl: observation.url,
            afterUrl: observation.url,
            durationMs: 0,
          }),
        );
        stopReason = "agent_requested_retryable_abort";
        proposedOutcome = {
          next_status: "RETRYABLE",
          detail: decision.detail ?? decision.reason,
          wait: inferAutoResumeWait(
            decision.wait_reason_code ?? "OUTCOME_NOT_CONFIRMED",
            "system",
            decision.resume_trigger ?? "Retry automatically later or inspect the agent trace.",
            tracePath,
          ),
          terminal_class: decision.terminal_class ?? "outcome_not_confirmed",
        };
        break;
      }

      if (decision.action === "finish_submission_attempt") {
        traceSteps.push(
          buildTraceStep({
            stepNumber,
            observation,
            decision,
            ok: true,
            detail: decision.detail ?? decision.reason,
            beforeUrl: observation.url,
            afterUrl: observation.url,
            durationMs: 0,
          }),
        );
        stopReason = "agent_requested_finalization";
        proposedOutcome = undefined;
        break;
      }

      const beforeUrl = observation.url;
      const actionStartedAt = Date.now();
      const execution = await executeAgentDecision({
        runtime: args.runtime,
        session,
        decision,
        observation,
        recordedSteps,
      });
      await settleBrowserUsePage();

      snapshot = await getBrowserUseSnapshot({
        cdpUrl: args.runtime.cdp_url,
        session,
      });
      const nextObservation = buildObservation({ snapshot });

      const progressed =
        nextObservation.url !== observation.url ||
        nextObservation.raw_text_excerpt !== observation.raw_text_excerpt;
      noProgressStreak = progressed ? 0 : noProgressStreak + 1;

      traceSteps.push(
        buildTraceStep({
          stepNumber,
          observation,
          decision,
          ok: execution.ok,
          detail: execution.detail,
          beforeUrl,
          afterUrl: nextObservation.url,
          durationMs: Date.now() - actionStartedAt,
        }),
      );

      observation = nextObservation;
    }

    await saveBrowserUseScreenshot({
      cdpUrl: args.runtime.cdp_url,
      session,
      filePath: screenshotPath,
    }).catch(() => undefined);

    const traceArtifact = buildTraceArtifact({
      task: args.task,
      agentBackend: decider.backend,
      startedAt: startedAtIso,
      stopReason,
      finalObservation: observation,
      steps: traceSteps,
    });
    await writeJsonFile(tracePath, traceArtifact);

    return {
      handoff: {
        detail: `Agent-driven browser-use loop stopped with reason "${stopReason}". Handing off to Playwright evidence finalization.`,
        artifact_refs: [tracePath, screenshotPath],
        current_url: observation.url,
        recorded_steps: recordedSteps,
        agent_trace_ref: tracePath,
        agent_backend: decider.backend,
        agent_steps_count: traceSteps.length,
        proposed_outcome: proposedOutcome,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "Agent-driven browser-use loop crashed unexpectedly.";
    await writeJsonFile(tracePath, {
      task_id: args.task.id,
      agent_backend: "openai",
      started_at: startedAtIso,
      finished_at: new Date().toISOString(),
      stop_reason: "agent_loop_runtime_error",
      final_url: args.task.target_url,
      final_title: "",
      final_excerpt: "",
      steps: traceSteps,
      crash_detail: detail,
    });

    return {
      takeover_result: {
        ok: false,
        next_status: "RETRYABLE",
        detail: `Agent-driven browser-use loop crashed before finalization: ${detail}`,
        artifact_refs: [tracePath],
        wait: inferAutoResumeWait(
          "TAKEOVER_RUNTIME_ERROR",
          "system",
          "Retry automatically later or inspect the latest agent loop artifact before adjusting the backend or prompt.",
          tracePath,
        ),
        terminal_class: "takeover_runtime_error",
        agent_trace_ref: tracePath,
        agent_backend: "openai",
        agent_steps_count: traceSteps.length,
      },
    };
  }
}

export async function runTakeoverFinalization(args: {
  runtime: BrowserRuntime;
  task: TaskRecord;
  handoff: TakeoverHandoff;
}): Promise<TakeoverResult> {
  return withConnectedPage(
    args.runtime.cdp_url,
    async (page) => {
      const artifactPath = getArtifactFilePath(args.task.id, "finalization");
      const screenshotPath = path.join(DATA_DIRECTORIES.artifacts, `${args.task.id}-finalization.png`);

      const currentUrl = page.url() || args.handoff.current_url;
      const title = await page.title().catch(() => "");
      const bodyText = await page.locator("body").innerText().catch(() => "");
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);

      const inferredOutcome = inferCurrentOutcome({
        currentUrl,
        bodyText,
        evidenceRef: artifactPath,
      });
      const finalOutcome = chooseFinalOutcome({
        inferred: inferredOutcome,
        proposed: args.handoff.proposed_outcome,
      });

      await writeJsonFile(artifactPath, {
        stage: "finalization",
        target_url: args.task.target_url,
        current_url: currentUrl,
        title,
        body_excerpt: bodyText.slice(0, 2_000),
        recorded_steps: args.handoff.recorded_steps,
        proposed_outcome: args.handoff.proposed_outcome,
        final_outcome: finalOutcome,
        agent_trace_ref: args.handoff.agent_trace_ref,
        agent_backend: args.handoff.agent_backend,
        agent_steps_count: args.handoff.agent_steps_count,
      });

      const playbook =
        finalOutcome.next_status === "WAITING_SITE_RESPONSE" || finalOutcome.next_status === "WAITING_EXTERNAL_EVENT"
          ? buildPlaybook({
              task: args.task,
              currentUrl,
              recordedSteps: args.handoff.recorded_steps,
              detail: finalOutcome.detail,
              agentTraceRef: args.handoff.agent_trace_ref,
              agentBackend: args.handoff.agent_backend,
            })
          : undefined;

      return {
        ok:
          finalOutcome.next_status === "WAITING_SITE_RESPONSE" ||
          finalOutcome.next_status === "WAITING_EXTERNAL_EVENT",
        next_status: finalOutcome.next_status,
        detail: finalOutcome.detail,
        artifact_refs: [artifactPath, screenshotPath],
        wait: finalOutcome.wait,
        terminal_class: finalOutcome.terminal_class,
        skip_reason_code: finalOutcome.skip_reason_code,
        playbook,
        agent_trace_ref: args.handoff.agent_trace_ref,
        agent_backend: args.handoff.agent_backend,
        agent_steps_count: args.handoff.agent_steps_count,
      };
    },
    { preferredUrl: args.handoff.current_url },
  );
}
