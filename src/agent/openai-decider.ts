import type { AgentBackendConfig, AgentDecision, AgentDecisionInput } from "../shared/types.js";
import type { AgentDecider } from "./decider.js";

interface ResponsesApiPayload {
  output_text?: string;
  output?: Array<{
    content?: Array<
      | { type?: string; text?: string }
      | { type?: string; value?: string }
    >;
  }>;
  error?: {
    message?: string;
  };
}

const OPENAI_RESPONSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [
        "open_url",
        "click_index",
        "input_index",
        "select_index",
        "keys",
        "wait",
        "finish_submission_attempt",
        "classify_terminal",
        "abort_retryable",
      ],
    },
    url: { type: ["string", "null"] },
    index: { type: ["number", "null"] },
    text: { type: ["string", "null"] },
    value: { type: ["string", "null"] },
    keys: { type: ["string", "null"] },
    wait_kind: { type: ["string", "null"], enum: ["text", "selector", null] },
    wait_target: { type: ["string", "null"] },
    wait_timeout_ms: { type: ["number", "null"] },
    wait_state: {
      type: ["string", "null"],
      enum: ["attached", "detached", "visible", "hidden", null],
    },
    next_status: {
      type: ["string", "null"],
      enum: [
        "READY",
        "RUNNING",
        "WAITING_EXTERNAL_EVENT",
        "WAITING_POLICY_DECISION",
        "WAITING_MISSING_INPUT",
        "WAITING_MANUAL_AUTH",
        "WAITING_SITE_RESPONSE",
        "RETRYABLE",
        "DONE",
        "SKIPPED",
        null,
      ],
    },
    wait_reason_code: { type: ["string", "null"] },
    resume_trigger: { type: ["string", "null"] },
    resolution_owner: { type: ["string", "null"], enum: ["system", "gog", "none", null] },
    resolution_mode: { type: ["string", "null"], enum: ["auto_resume", "terminal_audit", null] },
    terminal_class: {
      type: ["string", "null"],
      enum: [
        "login_required",
        "captcha_blocked",
        "paid_listing",
        "upstream_5xx",
        "outcome_not_confirmed",
        "takeover_runtime_error",
        null,
      ],
    },
    skip_reason_code: { type: ["string", "null"] },
    detail: { type: ["string", "null"] },
    reason: { type: "string" },
    confidence: { type: "number" },
    expected_signal: { type: "string" },
    stop_if_observed: {
      type: "array",
      items: { type: "string" },
    },
  },
  required: ["action", "reason", "confidence", "expected_signal", "stop_if_observed"],
} as const;

const SYSTEM_PROMPT = [
  "You are the unattended browser control brain for a backlink submission system.",
  "Your job is to choose exactly one next browser-use CLI action.",
  "Success rate is the top priority, but you must obey hard unattended boundaries.",
  "Never ask a human for help. If you hit a forbidden boundary, classify it and stop.",
  "Allowed unattended auth:",
  "- Google account chooser on an already logged-in Chrome profile",
  "- consent / continue screens",
  "- reusing existing login state",
  "Forbidden unattended actions:",
  "- entering passwords",
  "- handling 2FA, passkeys, SMS, device approval",
  "- bypassing CAPTCHA or managed anti-bot challenges",
  "- making paid listing decisions",
  "When you are confident the submit attempt has already been made, use finish_submission_attempt.",
  "When the page has clearly reached a policy, auth, or missing-input boundary, use classify_terminal with a concrete status and reason code.",
  "When you are stuck without a confident next move, use abort_retryable instead of wandering.",
  "Return only the structured JSON matching the schema.",
].join("\n");

function extractOutputText(payload: ResponsesApiPayload): string | undefined {
  if (payload.output_text?.trim()) {
    return payload.output_text.trim();
  }

  for (const outputItem of payload.output ?? []) {
    for (const contentItem of outputItem.content ?? []) {
      if ("text" in contentItem && typeof contentItem.text === "string" && contentItem.text.trim()) {
        return contentItem.text.trim();
      }

      if ("value" in contentItem && typeof contentItem.value === "string" && contentItem.value.trim()) {
        return contentItem.value.trim();
      }
    }
  }

  return undefined;
}

function sanitizeDecision(raw: AgentDecision): AgentDecision {
  return {
    ...raw,
    confidence: Math.min(1, Math.max(0, Number.isFinite(raw.confidence) ? raw.confidence : 0)),
    stop_if_observed: Array.isArray(raw.stop_if_observed) ? raw.stop_if_observed.slice(0, 8) : [],
  };
}

export function createOpenAIDecider(config: AgentBackendConfig): AgentDecider {
  const apiKey = process.env[config.api_key_env]?.trim();
  if (!apiKey) {
    throw new Error(`Missing required environment variable ${config.api_key_env} for the OpenAI agent backend.`);
  }

  return {
    backend: "openai",
    config,
    async decide(input: AgentDecisionInput): Promise<AgentDecision> {
      const response = await fetch(`${config.base_url}/responses`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: config.model,
          instructions: SYSTEM_PROMPT,
          input: JSON.stringify(input),
          max_output_tokens: 1_200,
          text: {
            format: {
              type: "json_schema",
              name: "agent_decision",
              strict: true,
              schema: OPENAI_RESPONSE_SCHEMA,
            },
          },
        }),
        signal: AbortSignal.timeout(60_000),
      });

      const payload = (await response.json().catch(async () => ({
        error: { message: await response.text().catch(() => "OpenAI API returned a non-JSON response.") },
      }))) as ResponsesApiPayload;

      if (!response.ok) {
        throw new Error(payload.error?.message ?? `OpenAI API returned ${response.status}.`);
      }

      const outputText = extractOutputText(payload);
      if (!outputText) {
        throw new Error("OpenAI agent backend returned no structured output text.");
      }

      const parsed = JSON.parse(outputText) as AgentDecision;
      return sanitizeDecision(parsed);
    },
  };
}
