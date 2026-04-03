export type BrowserRuntimeSource =
  | "cli"
  | "BACKLINK_BROWSER_CDP_URL"
  | "BROWSER_USE_CDP_URL"
  | "CHROME_CDP_URL"
  | "autodiscovered_external"
  | "default_local";

export interface PreflightCheckResult {
  ok: boolean;
  detail: string;
}

export interface BrowserRuntime {
  cdp_url: string;
  ok: boolean;
  source: BrowserRuntimeSource;
  browser_name: string;
  protocol_version: string;
  preflight_checks: {
    cdp_runtime: PreflightCheckResult;
    playwright: PreflightCheckResult;
    browser_use_cli: PreflightCheckResult;
    agent_backend: PreflightCheckResult;
    gog: PreflightCheckResult;
  };
}

export interface AgentBackendConfig {
  backend: "openai";
  model: string;
  base_url: string;
  api_key_env: string;
}

export interface PromotedProfile {
  url: string;
  hostname: string;
  name: string;
  description: string;
  category_hints: string[];
  source: "cli" | "site_metadata" | "fallback";
}

export interface SubmissionContext {
  promoted_profile: PromotedProfile;
  submitter_email?: string;
  confirm_submit: boolean;
}

export type TaskStatus =
  | "READY"
  | "RUNNING"
  | "WAITING_EXTERNAL_EVENT"
  | "WAITING_POLICY_DECISION"
  | "WAITING_MISSING_INPUT"
  | "WAITING_MANUAL_AUTH"
  | "WAITING_SITE_RESPONSE"
  | "RETRYABLE"
  | "DONE"
  | "SKIPPED";

export type ResolutionOwner = "system" | "gog" | "none";

export type ResolutionMode = "auto_resume" | "terminal_audit";

export type TerminalClass =
  | "login_required"
  | "captcha_blocked"
  | "paid_listing"
  | "upstream_5xx"
  | "outcome_not_confirmed"
  | "takeover_runtime_error";

export type AgentDecisionAction =
  | "open_url"
  | "click_index"
  | "input_index"
  | "select_index"
  | "keys"
  | "wait"
  | "finish_submission_attempt"
  | "classify_terminal"
  | "abort_retryable";

export interface WaitMetadata {
  wait_reason_code: string;
  resume_trigger: string;
  resolution_owner: ResolutionOwner;
  resolution_mode: ResolutionMode;
  evidence_ref: string;
}

export interface TaskRecord {
  id: string;
  target_url: string;
  hostname: string;
  submission: SubmissionContext;
  status: TaskStatus;
  created_at: string;
  updated_at: string;
  run_count: number;
  escalation_level: "none" | "replay" | "scout" | "takeover";
  takeover_attempts: number;
  last_takeover_at?: string;
  last_takeover_outcome?: string;
  trajectory_playbook_ref?: string;
  terminal_class?: TerminalClass;
  skip_reason_code?: string;
  wait?: WaitMetadata;
  phase_history: string[];
  latest_artifacts: string[];
  notes: string[];
}

export interface PageSnapshot {
  url: string;
  title: string;
  response_status?: number;
  body_text_excerpt: string;
}

export interface ScoutResult {
  ok: boolean;
  surface_summary: string;
  field_hints: string[];
  auth_hints: string[];
  anti_bot_hints: string[];
  submit_candidates: string[];
  evidence_sufficiency: boolean;
  page_snapshot: PageSnapshot;
}

export interface AgentObservationElement {
  index: number;
  descriptor: string;
  text: string;
  allowed_actions: Array<"click_index" | "input_index" | "select_index">;
}

export interface AgentObservation {
  url: string;
  title: string;
  raw_text_excerpt: string;
  elements: AgentObservationElement[];
}

export interface AgentDecisionInput {
  task_id: string;
  hostname: string;
  submission: SubmissionContext;
  scout_hints: Pick<ScoutResult, "field_hints" | "auth_hints" | "anti_bot_hints" | "submit_candidates">;
  observation: AgentObservation;
  recent_actions: Array<{
    step_number: number;
    action: AgentDecisionAction;
    detail: string;
    result: "ok" | "failed";
  }>;
  budget: {
    elapsed_ms: number;
    remaining_actions: number;
    repeated_surface_count: number;
    repeated_action_count: number;
    no_progress_streak: number;
  };
  policy: {
    allow_paid_listing: boolean;
    allow_reciprocal: boolean;
    allow_captcha_bypass: boolean;
    allow_google_oauth_chooser: boolean;
    allow_password_login: boolean;
    allow_2fa: boolean;
  };
}

export interface AgentDecision {
  action: AgentDecisionAction;
  url?: string;
  index?: number;
  text?: string;
  value?: string;
  keys?: string;
  wait_kind?: "text" | "selector";
  wait_target?: string;
  wait_timeout_ms?: number;
  wait_state?: "attached" | "detached" | "visible" | "hidden";
  next_status?: TaskStatus;
  wait_reason_code?: string;
  resume_trigger?: string;
  resolution_owner?: ResolutionOwner;
  resolution_mode?: ResolutionMode;
  terminal_class?: TerminalClass;
  skip_reason_code?: string;
  detail?: string;
  reason: string;
  confidence: number;
  expected_signal: string;
  stop_if_observed: string[];
}

export interface AgentLoopTraceStep {
  step_number: number;
  observation: AgentObservation;
  decision: AgentDecision;
  execution: {
    ok: boolean;
    detail: string;
    before_url: string;
    after_url: string;
    duration_ms: number;
  };
}

export interface AgentLoopTrace {
  task_id: string;
  agent_backend: string;
  started_at: string;
  finished_at: string;
  stop_reason: string;
  final_url: string;
  final_title: string;
  final_excerpt: string;
  steps: AgentLoopTraceStep[];
}

export type ReplayStep =
  | { action: "goto"; url: string }
  | { action: "wait_for_text"; text: string; timeout_ms?: number }
  | { action: "wait_for_selector"; selector: string; timeout_ms?: number; state?: "attached" | "detached" | "visible" | "hidden" }
  | { action: "wait_for_url_includes"; value: string; timeout_ms?: number }
  | { action: "click_text"; text: string; exact?: boolean }
  | { action: "click_role"; role: "button" | "link" | "textbox"; name: string }
  | { action: "click_selector"; selector: string }
  | { action: "fill_label"; label: string; value: string; exact?: boolean }
  | { action: "fill_placeholder"; placeholder: string; value: string }
  | { action: "fill_selector"; selector: string; value: string }
  | { action: "select_selector"; selector: string; value: string }
  | { action: "press_key"; key: string }
  | { action: "assert_text"; text: string }
  | { action: "screenshot"; name: string };

export interface TrajectoryPlaybook {
  id: string;
  hostname: string;
  capture_source: "manual" | "agent_live_takeover";
  surface_signature: string;
  preconditions: string[];
  steps: ReplayStep[];
  anchors: string[];
  postconditions: string[];
  success_signals: string[];
  fallback_notes: string[];
  replay_confidence: number;
  distilled_from_trace_ref?: string;
  agent_backend?: string;
  created_at: string;
  updated_at: string;
}

export interface ReplayResult {
  ok: boolean;
  next_status: TaskStatus;
  detail: string;
  artifact_refs: string[];
  wait?: WaitMetadata;
  terminal_class?: TerminalClass;
  skip_reason_code?: string;
}

export interface TakeoverResult {
  ok: boolean;
  next_status: TaskStatus;
  detail: string;
  artifact_refs: string[];
  wait?: WaitMetadata;
  terminal_class?: TerminalClass;
  skip_reason_code?: string;
  playbook?: TrajectoryPlaybook;
  agent_trace_ref?: string;
  agent_backend?: string;
  agent_steps_count?: number;
}
