import path from "node:path";

import {
  clickBrowserUseElement,
  getBrowserUseSnapshot,
  openBrowserUseUrl,
  saveBrowserUseScreenshot,
  settleBrowserUsePage,
} from "./browser-use-cli.js";
import {
  DATA_DIRECTORIES,
  getArtifactFilePath,
  writeJsonFile,
} from "../memory/data-store.js";
import { withConnectedPage } from "../shared/playwright-session.js";
import type {
  BrowserRuntime,
  ReplayStep,
  TakeoverResult,
  TaskRecord,
  TerminalClass,
  TrajectoryPlaybook,
  WaitMetadata,
} from "../shared/types.js";

type FieldSemantic =
  | "promoted_url"
  | "promoted_name"
  | "promoted_description"
  | "submitter_email"
  | "category"
  | "pricing"
  | "unknown";

interface DiscoveredField {
  selector: string;
  tag_name: string;
  type: string;
  label: string;
  placeholder: string;
  name: string;
  required: boolean;
  options: string[];
}

interface SubmitTarget {
  text: string;
  href: string;
}

interface BrowserUseActionCandidate {
  index: number;
  label: string;
  step: ReplayStep;
}

export interface TakeoverHandoff {
  detail: string;
  artifact_refs: string[];
  current_url: string;
  recorded_steps: ReplayStep[];
}

export interface PlaywrightProbeResult {
  handoff?: TakeoverHandoff;
  takeover_result?: TakeoverResult;
}

export interface BrowserUseFallbackResult {
  handoff?: TakeoverHandoff;
  takeover_result?: TakeoverResult;
}

const SUBMIT_ENTRY_PATTERNS = [
  /submit a tool/i,
  /submit tool/i,
  /submit your tool/i,
  /add tool/i,
  /add listing/i,
  /suggest tool/i,
  /get listed/i,
  /submit/i,
];

const FINAL_SUBMIT_PATTERNS = [
  /submit tool/i,
  /submit/i,
  /send/i,
  /publish/i,
  /continue/i,
  /save/i,
];

const GENERAL_CONTINUE_PATTERNS = [
  /continue/i,
  /next/i,
  /proceed/i,
  /allow/i,
  /accept/i,
  /authorize/i,
  /agree/i,
];

const GOOGLE_AUTH_PATTERNS = [
  /continue with google/i,
  /login with google/i,
  /sign in with google/i,
  /google/i,
];

const UNATTENDED_POLICY = {
  allow_paid_listing: false,
  allow_reciprocal: false,
  allow_captcha_bypass: false,
  allow_google_oauth_chooser: true,
  allow_password_login: false,
  allow_2fa: false,
} as const;

const PLAYWRIGHT_PROBE_TIMEOUT_MS = 30_000;
const BROWSER_USE_MAX_DURATION_MS = 10 * 60 * 1_000;
const BROWSER_USE_MAX_ACTIONS = 60;

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

function isLoginGateHref(href: string): boolean {
  return /login|redirect_to=submit/i.test(href);
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

function inferFieldSemantic(field: DiscoveredField): FieldSemantic {
  const combined = `${field.label} ${field.placeholder} ${field.name}`.toLowerCase();

  if (/(tool url|website|url|homepage|site|link)/i.test(combined)) {
    return "promoted_url";
  }

  if (/(tool name|product name|business name|company name|tool title|name|title)/i.test(combined)) {
    return "promoted_name";
  }

  if (/(short description|description|about|summary|details|overview|bio)/i.test(combined)) {
    return "promoted_description";
  }

  if (/(email|e-mail|contact email)/i.test(combined)) {
    return "submitter_email";
  }

  if (/(category|industry|tag|topic|niche)/i.test(combined)) {
    return "category";
  }

  if (/(pricing|price|billing|plan)/i.test(combined)) {
    return "pricing";
  }

  if (field.type === "radio" && /(free|freemium|paid|open source)/i.test(combined)) {
    return "pricing";
  }

  return "unknown";
}

function chooseOption(options: string[], hints: string[]): string | undefined {
  const cleanOptions = options
    .map((option) => option.trim())
    .filter((option) => option && !/^select/i.test(option));

  const synonyms: Record<string, string[]> = {
    finance: ["finance", "fintech", "accounting", "bookkeeping"],
    accounting: ["accounting", "finance", "bookkeeping"],
    productivity: ["productivity", "business", "workflow"],
    automation: ["automation", "agents", "productivity"],
    business: ["business", "productivity", "finance"],
  };

  for (const hint of hints) {
    const related = [hint, ...(synonyms[hint] ?? [])];
    const matched = cleanOptions.find((option) =>
      related.some((candidate) => option.toLowerCase().includes(candidate.toLowerCase())),
    );

    if (matched) {
      return matched;
    }
  }

  return cleanOptions[0];
}

function choosePricingOption(options: string[]): string | undefined {
  const normalized = options.map((option) => option.trim()).filter(Boolean);
  return normalized.find((option) => /freemium/i.test(option)) ?? normalized.find((option) => /free/i.test(option)) ?? normalized[0];
}

function buildPlaybook(args: {
  task: TaskRecord;
  currentUrl: string;
  recordedSteps: ReplayStep[];
  detail: string;
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
    fallback_notes: ["If replay fails, rerun scout and takeover."],
    replay_confidence: 0.6,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function clickByPatterns(
  page: import("playwright").Page,
  patterns: RegExp[],
): Promise<ReplayStep | undefined> {
  const selectorCandidates = [
    "a[href*='submit-a-tool']",
    "a[href*='redirect_to=submit']",
    "a[href*='submit']",
    "a[href*='add-tool']",
    "a[href*='add']",
    "a[href*='list']",
  ];

  for (const selector of selectorCandidates) {
    const locator = page.locator(selector);
    const count = await locator.count();

    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      try {
        if (await candidate.isVisible({ timeout: 500 })) {
          await candidate.click();
          await page.waitForLoadState("domcontentloaded");
          return { action: "click_selector", selector: `${selector} >> nth=${index}` };
        }
      } catch {
        // Keep trying other candidates.
      }
    }
  }

  for (const pattern of patterns) {
    try {
      const links = page.getByRole("link", { name: pattern });
      const count = await links.count();

      for (let index = 0; index < count; index += 1) {
        const link = links.nth(index);
        if (await link.isVisible({ timeout: 500 })) {
          const text = (await link.innerText()).trim();
          await link.click();
          await page.waitForLoadState("domcontentloaded");
          return { action: "click_role", role: "link", name: text };
        }
      }
    } catch {
      // Try buttons next.
    }

    try {
      const buttons = page.getByRole("button", { name: pattern });
      const count = await buttons.count();

      for (let index = 0; index < count; index += 1) {
        const button = buttons.nth(index);
        if (await button.isVisible({ timeout: 500 })) {
          const text = (await button.innerText()).trim();
          await button.click();
          await page.waitForLoadState("domcontentloaded");
          return { action: "click_role", role: "button", name: text };
        }
      }
    } catch {
      // Continue with the next pattern.
    }
  }

  return undefined;
}

async function discoverSubmitTargets(
  page: import("playwright").Page,
): Promise<SubmitTarget[]> {
  return page.locator("a").evaluateAll((elements) => {
    const matches = (value: string): boolean => {
      const normalized = value.toLowerCase();
      return (
        normalized.includes("submit") ||
        normalized.includes("add tool") ||
        normalized.includes("submit a tool") ||
        normalized.includes("submit tool") ||
        normalized.includes("get listed")
      );
    };

    return elements
      .map((element) => ({
        text: (element.textContent || "").replace(/\s+/g, " ").trim(),
        href: element.getAttribute("href") || "",
      }))
      .filter((item) => matches(`${item.text} ${item.href}`))
      .slice(0, 10);
  });
}

async function clickFinalSubmitButton(
  page: import("playwright").Page,
): Promise<ReplayStep | undefined> {
  for (const pattern of FINAL_SUBMIT_PATTERNS) {
    try {
      const button = page.getByRole("button", { name: pattern }).first();
      if (await button.isVisible({ timeout: 500 })) {
        const text = (await button.innerText()).trim();
        await button.click();
        await page.waitForLoadState("domcontentloaded");
        return { action: "click_role", role: "button", name: text };
      }
    } catch {
      // Try other strategies.
    }
  }

  const selectorCandidates = ["button[type='submit']", "input[type='submit']"];
  for (const selector of selectorCandidates) {
    const locator = page.locator(selector);
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      try {
        if (await candidate.isVisible({ timeout: 500 })) {
          await candidate.click();
          await page.waitForLoadState("domcontentloaded");
          return { action: "click_selector", selector: `${selector} >> nth=${index}` };
        }
      } catch {
        // Continue trying.
      }
    }
  }

  return undefined;
}

async function discoverFields(page: import("playwright").Page): Promise<DiscoveredField[]> {
  return page.locator("input, textarea, select").evaluateAll((elements) => {
    function selectorFor(element: Element): string {
      if (!(element instanceof HTMLElement)) {
        return "";
      }

      if (element.id) {
        return `#${CSS.escape(element.id)}`;
      }

      const name = element.getAttribute("name");
      const value = element.getAttribute("value");
      const type = element.getAttribute("type");
      if (name && value && (type === "radio" || type === "checkbox")) {
        return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"][value="${CSS.escape(value)}"]`;
      }

      if (name) {
        return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      }

      const placeholder = element.getAttribute("placeholder");
      if (placeholder) {
        return `${element.tagName.toLowerCase()}[placeholder="${CSS.escape(placeholder)}"]`;
      }

      return element.tagName.toLowerCase();
    }

    function labelFor(element: Element): string {
      if (!(element instanceof HTMLElement)) {
        return "";
      }

      const aria = element.getAttribute("aria-label");
      if (aria) {
        return aria.trim();
      }

      if (element.id) {
        const label = document.querySelector(`label[for="${CSS.escape(element.id)}"]`);
        if (label?.textContent) {
          return label.textContent.replace(/\s+/g, " ").trim();
        }
      }

      const parentLabel = element.closest("label");
      return parentLabel?.textContent?.replace(/\s+/g, " ").trim() ?? "";
    }

    function isVisible(element: Element): boolean {
      if (!(element instanceof HTMLElement)) {
        return false;
      }

      if (element.hidden) {
        return false;
      }

      const style = window.getComputedStyle(element);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse" ||
        style.opacity === "0"
      ) {
        return false;
      }

      return element.getClientRects().length > 0;
    }

    return elements
      .map((element) => {
        const tag = element.tagName.toLowerCase();
        const htmlElement = element as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const options =
          tag === "select"
            ? Array.from((element as HTMLSelectElement).options).map((option) => option.textContent?.trim() || "")
            : [];

        return {
          selector: selectorFor(element),
          tag_name: tag,
          type: "type" in htmlElement ? htmlElement.type || tag : tag,
          label: labelFor(element),
          placeholder: element.getAttribute("placeholder")?.trim() || "",
          name: element.getAttribute("name")?.trim() || "",
          required: element.hasAttribute("required") || element.getAttribute("aria-required") === "true",
          options,
        };
      })
      .filter((field, index) => {
        const element = elements[index];
        return isVisible(element) && !["hidden", "submit", "button"].includes(field.type);
      });
  });
}

async function tryFillVisibleLocator(
  locator: import("playwright").Locator,
  value: string,
): Promise<boolean> {
  const count = await locator.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    try {
      if (await candidate.isVisible({ timeout: 500 })) {
        await candidate.fill(value, { timeout: 5_000 });
        return true;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return false;
}

async function fillSelector(
  page: import("playwright").Page,
  field: DiscoveredField,
  value: string,
  recordedSteps: ReplayStep[],
): Promise<void> {
  if (field.label) {
    if (await tryFillVisibleLocator(page.getByLabel(field.label, { exact: false }), value)) {
      recordedSteps.push({ action: "fill_label", label: field.label, value });
      return;
    }
  }

  if (field.placeholder) {
    if (await tryFillVisibleLocator(page.getByPlaceholder(field.placeholder), value)) {
      recordedSteps.push({ action: "fill_placeholder", placeholder: field.placeholder, value });
      return;
    }
  }

  if (!field.selector) {
    throw new Error(`No reliable selector found for field "${field.label || field.name || field.placeholder}".`);
  }

  const filled = await tryFillVisibleLocator(page.locator(field.selector), value);
  if (!filled) {
    throw new Error(
      `No visible editable field found for "${field.label || field.name || field.placeholder || field.selector}".`,
    );
  }
  recordedSteps.push({ action: "fill_selector", selector: field.selector, value });
}

async function selectBySelector(
  page: import("playwright").Page,
  field: DiscoveredField,
  value: string,
  recordedSteps: ReplayStep[],
): Promise<void> {
  if (!field.selector) {
    throw new Error(`No reliable selector found for select field "${field.label || field.name}".`);
  }

  await page.locator(field.selector).first().selectOption({ label: value });
  recordedSteps.push({ action: "select_selector", selector: field.selector, value });
}

async function clickRadioField(
  page: import("playwright").Page,
  field: DiscoveredField,
  recordedSteps: ReplayStep[],
): Promise<void> {
  if (!field.selector) {
    throw new Error(`No reliable selector found for radio field "${field.label || field.name}".`);
  }

  const locator = page.locator(field.selector).first();
  try {
    await locator.check({ timeout: 2_000 });
  } catch {
    await locator.check({ force: true });
  }
  recordedSteps.push({ action: "click_selector", selector: field.selector });
}

function inferCurrentOutcome(args: {
  currentUrl: string;
  responseStatus?: number;
  bodyText: string;
  submitClicked: boolean;
  evidenceRef: string;
}): {
  next_status: TakeoverResult["next_status"];
  detail: string;
  wait?: WaitMetadata;
  terminal_class?: TerminalClass;
} {
  const normalized = args.bodyText.toLowerCase();

  if ((args.responseStatus ?? 0) >= 500 || normalized.includes("502 bad gateway")) {
    return {
      next_status: "RETRYABLE",
      detail: "Directory returned an upstream 5xx error during takeover.",
      wait: inferAutoResumeWait(
        "DIRECTORY_UPSTREAM_5XX",
        "system",
        "Retry later after the directory becomes healthy again.",
        args.evidenceRef,
      ),
      terminal_class: "upstream_5xx",
    };
  }

  if (!UNATTENDED_POLICY.allow_paid_listing && looksLikePaidGate(args.bodyText)) {
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
    !UNATTENDED_POLICY.allow_captcha_bypass &&
    (normalized.includes("captcha") ||
      normalized.includes("loading captcha") ||
      normalized.includes("i'm not a robot") ||
      normalized.includes("verify you are human"))
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
      (!UNATTENDED_POLICY.allow_password_login &&
        (normalized.includes("password") ||
          normalized.includes("sign in") ||
          normalized.includes("log in"))) ||
      (!UNATTENDED_POLICY.allow_2fa &&
        (normalized.includes("2fa") ||
          normalized.includes("two-factor") ||
          normalized.includes("passkey") ||
          normalized.includes("verify it's you"))) ||
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
      detail: args.submitClicked
        ? "Submission appears to be accepted and waiting for directory review."
        : "Directory looks ready but submission status is not fully confirmed.",
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
      "Retry automatically later or inspect the latest artifact to improve the takeover heuristics.",
      args.evidenceRef,
    ),
    terminal_class: "outcome_not_confirmed",
  };
}

function looksLikeSubmitSurface(args: {
  rawText: string;
  currentUrl: string;
}): boolean {
  const normalized = args.rawText.toLowerCase();
  const fieldSignalCount = [
    /textbox/i,
    /combobox/i,
    /textarea/i,
    /<input/i,
    /<select/i,
  ].filter((pattern) => pattern.test(args.rawText)).length;

  const labelSignalCount = [
    "tool name",
    "website",
    "url",
    "description",
    "email",
    "category",
  ].filter((token) => normalized.includes(token)).length;

  return (
    args.currentUrl.toLowerCase().includes("submit") ||
    (fieldSignalCount >= 2 && labelSignalCount >= 2)
  );
}

function createBrowserUseActionCandidate(
  index: number,
  label: string,
): BrowserUseActionCandidate {
  const normalizedLabel = label.replace(/\s+/g, " ").trim();
  return {
    index,
    label: normalizedLabel,
    step: { action: "click_text", text: normalizedLabel || `browser-use:${index}` },
  };
}

function chooseBrowserUseAction(args: {
  currentUrl: string;
  elements: Array<{ index: number; descriptor: string; text: string }>;
  actionCounts: Map<string, number>;
}): BrowserUseActionCandidate | undefined {
  const normalizedUrl = args.currentUrl.toLowerCase();
  const availableElements = args.elements.filter((element) => {
    const key = `${element.index}:${element.text || element.descriptor}`;
    return (args.actionCounts.get(key) ?? 0) < 2;
  });

  if (normalizedUrl.includes("accounts.google.com")) {
    const accountChoice = availableElements.find((element) =>
      /@/.test(element.text) && /(role=link|button|div role=link)/i.test(element.descriptor),
    );
    if (accountChoice) {
      return createBrowserUseActionCandidate(accountChoice.index, accountChoice.text);
    }

    const continueChoice = availableElements.find((element) =>
      GENERAL_CONTINUE_PATTERNS.some((pattern) => pattern.test(element.text)),
    );
    if (continueChoice) {
      return createBrowserUseActionCandidate(continueChoice.index, continueChoice.text);
    }
  }

  const patternGroups = [
    SUBMIT_ENTRY_PATTERNS,
    GOOGLE_AUTH_PATTERNS,
    GENERAL_CONTINUE_PATTERNS,
  ];

  for (const patterns of patternGroups) {
    const match = availableElements.find((element) =>
      patterns.some((pattern) => pattern.test(`${element.text} ${element.descriptor}`)),
    );
    if (match) {
      return createBrowserUseActionCandidate(match.index, match.text || match.descriptor);
    }
  }

  return undefined;
}

function shouldEscalateFromProbe(args: {
  currentUrl: string;
  bodyText: string;
  fields: DiscoveredField[];
}): boolean {
  if (args.fields.length > 0) {
    return false;
  }

  if (isAllowedGoogleOauthTransition(args.bodyText, args.currentUrl)) {
    return true;
  }

  return true;
}

async function writeProbeArtifact(args: {
  artifactPath: string;
  screenshotPath: string;
  targetUrl: string;
  currentUrl: string;
  title: string;
  responseStatus?: number;
  fields: DiscoveredField[];
  submitTargets: SubmitTarget[];
  recordedSteps: ReplayStep[];
  bodyText: string;
  decision: string;
}): Promise<void> {
  await writeJsonFile(args.artifactPath, {
    stage: "probe",
    target_url: args.targetUrl,
    current_url: args.currentUrl,
    title: args.title,
    response_status: args.responseStatus,
    fields: args.fields,
    submit_targets: args.submitTargets,
    recorded_steps: args.recordedSteps,
    body_excerpt: args.bodyText.slice(0, 2_000),
    decision: args.decision,
  });
}

async function writeBrowserUseArtifact(args: {
  artifactPath: string;
  screenshotPath: string;
  task: TaskRecord;
  currentUrl: string;
  title: string;
  rawText: string;
  actionLabels: string[];
  recordedSteps: ReplayStep[];
  stopReason: string;
  actionCount: number;
}): Promise<void> {
  await writeJsonFile(args.artifactPath, {
    stage: "browser_use_fallback",
    target_url: args.task.target_url,
    current_url: args.currentUrl,
    title: args.title,
    action_labels: args.actionLabels,
    action_count: args.actionCount,
    recorded_steps: args.recordedSteps,
    body_excerpt: args.rawText.slice(0, 2_000),
    stop_reason: args.stopReason,
  });
}

async function runPlaywrightDeterministicFinalization(args: {
  runtime: BrowserRuntime;
  task: TaskRecord;
  currentUrl: string;
  recordedSteps: ReplayStep[];
  responseStatus?: number;
}): Promise<TakeoverResult> {
  return withConnectedPage(
    args.runtime.cdp_url,
    async (page) => {
      const recordedSteps = [...args.recordedSteps];
      const artifactPath = getArtifactFilePath(args.task.id, "takeover");
      const screenshotPath = path.join(DATA_DIRECTORIES.artifacts, `${args.task.id}-takeover.png`);

      try {
        if (args.currentUrl && page.url() !== args.currentUrl) {
          await page.goto(args.currentUrl, {
            waitUntil: "domcontentloaded",
            timeout: 20_000,
          });
          recordedSteps.push({ action: "goto", url: args.currentUrl });
        }

        const fields = await discoverFields(page);
        const missingInputs: string[] = [];
        const handledRadioGroups = new Set<string>();

        for (const field of fields) {
          const semantic = inferFieldSemantic(field);
          if (semantic === "promoted_url") {
            await fillSelector(page, field, args.task.submission.promoted_profile.url, recordedSteps);
            continue;
          }

          if (semantic === "promoted_name") {
            await fillSelector(page, field, args.task.submission.promoted_profile.name, recordedSteps);
            continue;
          }

          if (semantic === "promoted_description") {
            await fillSelector(page, field, args.task.submission.promoted_profile.description, recordedSteps);
            continue;
          }

          if (semantic === "submitter_email") {
            if (!args.task.submission.submitter_email) {
              missingInputs.push(field.label || field.placeholder || field.name || "email");
              continue;
            }

            await fillSelector(page, field, args.task.submission.submitter_email, recordedSteps);
            continue;
          }

          if (semantic === "category" && field.options.length > 0) {
            const selected = chooseOption(
              field.options,
              args.task.submission.promoted_profile.category_hints,
            );

            if (!selected) {
              missingInputs.push(field.label || field.name || "category");
              continue;
            }

            await selectBySelector(page, field, selected, recordedSteps);
            continue;
          }

          if (semantic === "pricing" && field.options.length > 0) {
            const selected = choosePricingOption(field.options);
            if (selected) {
              await selectBySelector(page, field, selected, recordedSteps);
            }
            continue;
          }

          if (semantic === "pricing" && field.type === "radio") {
            const groupKey = field.name || field.selector || field.label;
            if (groupKey && handledRadioGroups.has(groupKey)) {
              continue;
            }

            const radioCandidates = fields.filter(
              (candidate) =>
                candidate.type === "radio" &&
                (candidate.name === field.name || candidate.label === field.label),
            );
            const preferred = radioCandidates.find((candidate) =>
              /freemium|free/i.test(`${candidate.label} ${candidate.name} ${candidate.selector}`),
            ) ?? radioCandidates[0] ?? field;

            await clickRadioField(page, preferred, recordedSteps);
            if (groupKey) {
              handledRadioGroups.add(groupKey);
            }
            continue;
          }

          if (field.required && semantic === "unknown") {
            missingInputs.push(field.label || field.placeholder || field.name || field.selector);
          }
        }

        if (missingInputs.length > 0) {
          await page.screenshot({ path: screenshotPath, fullPage: true });
          await writeJsonFile(artifactPath, {
            stage: "takeover",
            target_url: args.task.target_url,
            current_url: page.url(),
            title: await page.title(),
            missing_inputs: missingInputs,
            fields,
            recorded_steps: recordedSteps,
          });

          return {
            ok: false,
            next_status: "WAITING_MISSING_INPUT",
            detail: `Directory requires additional inputs and was classified as a terminal audit state: ${missingInputs.join(", ")}.`,
            artifact_refs: [artifactPath, screenshotPath],
            wait: inferTerminalAuditWait(
              "REQUIRED_INPUT_MISSING",
              artifactPath,
              `Missing inputs: ${missingInputs.join(", ")}.`,
            ),
          };
        }

        let submitClicked = false;
        if (args.task.submission.confirm_submit) {
          const submitStep = await clickFinalSubmitButton(page);
          if (submitStep) {
            recordedSteps.push(submitStep);
            submitClicked = true;
          }
        }

        const bodyText = await page.locator("body").innerText().catch(() => "");
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await writeJsonFile(artifactPath, {
          stage: "takeover",
          target_url: args.task.target_url,
          current_url: page.url(),
          title: await page.title(),
          response_status: args.responseStatus,
          submit_clicked: submitClicked,
          fields,
          recorded_steps: recordedSteps,
          body_excerpt: bodyText.slice(0, 2_000),
        });

        const outcome = inferCurrentOutcome({
          currentUrl: page.url(),
          responseStatus: args.responseStatus,
          bodyText,
          submitClicked,
          evidenceRef: artifactPath,
        });

        const playbook =
          outcome.next_status === "WAITING_SITE_RESPONSE" || outcome.next_status === "WAITING_EXTERNAL_EVENT"
            ? buildPlaybook({
                task: args.task,
                currentUrl: page.url(),
                recordedSteps,
                detail: outcome.detail,
              })
            : undefined;

        return {
          ok: outcome.next_status === "WAITING_SITE_RESPONSE" || outcome.next_status === "WAITING_EXTERNAL_EVENT",
          next_status: outcome.next_status,
          detail: outcome.detail,
          artifact_refs: [artifactPath, screenshotPath],
          wait: outcome.wait,
          terminal_class: outcome.terminal_class,
          playbook,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Takeover crashed unexpectedly.";
        const bodyText = await page.locator("body").innerText().catch(() => "");
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
        await writeJsonFile(artifactPath, {
          stage: "takeover",
          target_url: args.task.target_url,
          current_url: page.url(),
          title: await page.title().catch(() => ""),
          recorded_steps: recordedSteps,
          body_excerpt: bodyText.slice(0, 2_000),
          crash_detail: detail,
        });

        return {
          ok: false,
          next_status: "RETRYABLE",
          detail: `Takeover crashed before it could classify the result: ${detail}`,
          artifact_refs: [artifactPath, screenshotPath],
          wait: inferAutoResumeWait(
            "TAKEOVER_RUNTIME_ERROR",
            "system",
            "Retry automatically later or inspect the crash artifact before adjusting the takeover heuristics.",
            artifactPath,
          ),
          terminal_class: "takeover_runtime_error",
        };
      }
    },
    { preferredUrl: args.currentUrl },
  );
}

export async function runPlaywrightUltraLightProbe(args: {
  runtime: BrowserRuntime;
  task: TaskRecord;
}): Promise<PlaywrightProbeResult> {
  return withConnectedPage(
    args.runtime.cdp_url,
    async (page) => {
      const recordedSteps: ReplayStep[] = [{ action: "goto", url: args.task.target_url }];
      const artifactPath = getArtifactFilePath(args.task.id, "probe");
      const screenshotPath = path.join(DATA_DIRECTORIES.artifacts, `${args.task.id}-probe.png`);

      const probeDeadline = Date.now() + PLAYWRIGHT_PROBE_TIMEOUT_MS;

      try {
        const initialResponse = await page.goto(args.task.target_url, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });

        const initialSubmitTargets = await discoverSubmitTargets(page);
        const directSubmitTarget = initialSubmitTargets.find(
          (target) => /submit/i.test(target.href) && !isLoginGateHref(target.href),
        );
        if (directSubmitTarget && Date.now() < probeDeadline) {
          const submitUrl = new URL(directSubmitTarget.href, page.url()).toString();
          if (submitUrl !== page.url()) {
            await page.goto(submitUrl, {
              waitUntil: "domcontentloaded",
              timeout: 20_000,
            });
            recordedSteps.push({ action: "goto", url: submitUrl });
          }
        }

        let fields = await discoverFields(page);
        if (!directSubmitTarget && fields.length === 0 && Date.now() < probeDeadline) {
          const entryStep = await clickByPatterns(page, SUBMIT_ENTRY_PATTERNS);
          if (entryStep) {
            recordedSteps.push(entryStep);
            fields = await discoverFields(page);
          }
        }

        const bodyText = await page.locator("body").innerText().catch(() => "");
        const submitTargets = directSubmitTarget ? initialSubmitTargets : await discoverSubmitTargets(page);
        const currentUrl = page.url();
        const title = await page.title();

        await page.screenshot({ path: screenshotPath, fullPage: true });

        if (fields.length === 0) {
          await writeProbeArtifact({
            artifactPath,
            screenshotPath,
            targetUrl: args.task.target_url,
            currentUrl,
            title,
            responseStatus: initialResponse?.status(),
            fields,
            submitTargets,
            recordedSteps,
            bodyText,
            decision: shouldEscalateFromProbe({ currentUrl, bodyText, fields })
              ? "escalate_to_browser_use"
              : "classify_without_form",
          });

          const immediateOutcome = inferCurrentOutcome({
            currentUrl,
            responseStatus: initialResponse?.status(),
            bodyText,
            submitClicked: false,
            evidenceRef: artifactPath,
          });

          if (
            immediateOutcome.next_status !== "RETRYABLE" ||
            immediateOutcome.terminal_class === "upstream_5xx"
          ) {
            return {
              takeover_result: {
                ok:
                  immediateOutcome.next_status === "WAITING_SITE_RESPONSE" ||
                  immediateOutcome.next_status === "WAITING_EXTERNAL_EVENT",
                next_status: immediateOutcome.next_status,
                detail: immediateOutcome.detail,
                artifact_refs: [artifactPath, screenshotPath],
                wait: immediateOutcome.wait,
                terminal_class: immediateOutcome.terminal_class,
              },
            };
          }

          return {
            handoff: {
              detail: "Playwright probe did not find a stable submit surface quickly. Escalating to browser-use CLI fallback.",
              artifact_refs: [artifactPath, screenshotPath],
              current_url: currentUrl,
              recorded_steps: recordedSteps,
            },
          };
        }

        const finalizationResult = await runPlaywrightDeterministicFinalization({
          runtime: args.runtime,
          task: args.task,
          currentUrl,
          recordedSteps,
          responseStatus: initialResponse?.status(),
        });

        if (
          finalizationResult.next_status === "RETRYABLE" &&
          finalizationResult.terminal_class !== "upstream_5xx"
        ) {
          return {
            handoff: {
              detail: "Playwright probe reached a form but could not deterministically finish it. Escalating to browser-use CLI fallback.",
              artifact_refs: [artifactPath, screenshotPath, ...finalizationResult.artifact_refs],
              current_url: currentUrl,
              recorded_steps: recordedSteps,
            },
          };
        }

        return { takeover_result: finalizationResult };
      } catch (error) {
        const detail = error instanceof Error ? error.message : "Playwright probe crashed unexpectedly.";
        const bodyText = await page.locator("body").innerText().catch(() => "");
        await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => undefined);
        await writeProbeArtifact({
          artifactPath,
          screenshotPath,
          targetUrl: args.task.target_url,
          currentUrl: page.url(),
          title: await page.title().catch(() => ""),
          responseStatus: undefined,
          fields: [],
          submitTargets: [],
          recordedSteps,
          bodyText,
          decision: `probe_crash:${detail}`,
        });

        return {
          handoff: {
            detail: `Playwright probe crashed and will escalate to browser-use CLI fallback: ${detail}`,
            artifact_refs: [artifactPath, screenshotPath],
            current_url: page.url(),
            recorded_steps: recordedSteps,
          },
        };
      }
    },
    { preferredUrl: args.task.target_url },
  );
}

export async function runBrowserUseFallback(args: {
  runtime: BrowserRuntime;
  task: TaskRecord;
  handoff: TakeoverHandoff;
}): Promise<BrowserUseFallbackResult> {
  const artifactPath = getArtifactFilePath(args.task.id, "browser-use");
  const screenshotPath = path.join(DATA_DIRECTORIES.artifacts, `${args.task.id}-browser-use.png`);
  const session = `task-${args.task.id}`.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40);
  const recordedSteps = [...args.handoff.recorded_steps];
  const actionCounts = new Map<string, number>();
  const signatureCounts = new Map<string, number>();
  const actionLabels: string[] = [];
  const startedAt = Date.now();

  try {
    let snapshot = await getBrowserUseSnapshot({
      cdpUrl: args.runtime.cdp_url,
      session,
    }).catch(async () => {
      const openedUrl = await openBrowserUseUrl({
        cdpUrl: args.runtime.cdp_url,
        session,
        url: args.handoff.current_url || args.task.target_url,
      });
      recordedSteps.push({ action: "goto", url: openedUrl });
      return getBrowserUseSnapshot({
        cdpUrl: args.runtime.cdp_url,
        session,
      });
    });

    if (!snapshot.url || snapshot.url === "about:blank") {
      const openedUrl = await openBrowserUseUrl({
        cdpUrl: args.runtime.cdp_url,
        session,
        url: args.handoff.current_url || args.task.target_url,
      });
      recordedSteps.push({ action: "goto", url: openedUrl });
      snapshot = await getBrowserUseSnapshot({
        cdpUrl: args.runtime.cdp_url,
        session,
      });
    }

    let stopReason = "handoff_to_finalization";
    let actionCount = 0;

    while (Date.now() - startedAt < BROWSER_USE_MAX_DURATION_MS && actionCount < BROWSER_USE_MAX_ACTIONS) {
      const signature = `${snapshot.url}\n${snapshot.raw_text.slice(0, 500)}`;
      const nextSignatureCount = (signatureCounts.get(signature) ?? 0) + 1;
      signatureCounts.set(signature, nextSignatureCount);

      if (
        looksLikeSubmitSurface({ rawText: snapshot.raw_text, currentUrl: snapshot.url }) ||
        inferCurrentOutcome({
          currentUrl: snapshot.url,
          bodyText: snapshot.raw_text,
          submitClicked: false,
          evidenceRef: artifactPath,
        }).next_status !== "RETRYABLE"
      ) {
        stopReason = "current_surface_ready_for_finalization";
        break;
      }

      if (nextSignatureCount >= 3) {
        stopReason = "repeated_surface_detected";
        break;
      }

      const candidate = chooseBrowserUseAction({
        currentUrl: snapshot.url,
        elements: snapshot.elements,
        actionCounts,
      });

      if (!candidate) {
        stopReason = "no_promising_browser_use_action";
        break;
      }

      await clickBrowserUseElement({
        cdpUrl: args.runtime.cdp_url,
        session,
        index: candidate.index,
      });
      await settleBrowserUsePage();

      recordedSteps.push(candidate.step);
      actionLabels.push(candidate.label);
      const actionKey = `${candidate.index}:${candidate.label}`;
      actionCounts.set(actionKey, (actionCounts.get(actionKey) ?? 0) + 1);
      actionCount += 1;

      snapshot = await getBrowserUseSnapshot({
        cdpUrl: args.runtime.cdp_url,
        session,
      });
    }

    await saveBrowserUseScreenshot({
      cdpUrl: args.runtime.cdp_url,
      session,
      filePath: screenshotPath,
    }).catch(() => undefined);

    await writeBrowserUseArtifact({
      artifactPath,
      screenshotPath,
      task: args.task,
      currentUrl: snapshot.url,
      title: snapshot.title,
      rawText: snapshot.raw_text,
      actionLabels,
      recordedSteps,
      stopReason,
      actionCount,
    });

    return {
      handoff: {
        detail: `browser-use CLI fallback finished pathfinding with stop reason "${stopReason}". Handing back to Playwright finalization.`,
        artifact_refs: [artifactPath, screenshotPath],
        current_url: snapshot.url,
        recorded_steps: recordedSteps,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : "browser-use CLI fallback crashed unexpectedly.";
    await writeJsonFile(artifactPath, {
      stage: "browser_use_fallback",
      target_url: args.task.target_url,
      current_url: args.handoff.current_url,
      recorded_steps: recordedSteps,
      crash_detail: detail,
    });

    return {
      takeover_result: {
        ok: false,
        next_status: "RETRYABLE",
        detail: `browser-use CLI fallback crashed before finalization: ${detail}`,
        artifact_refs: [artifactPath],
        wait: inferAutoResumeWait(
          "TAKEOVER_RUNTIME_ERROR",
          "system",
          "Retry automatically later or inspect the browser-use fallback artifact before adjusting the pathfinding heuristics.",
          artifactPath,
        ),
        terminal_class: "takeover_runtime_error",
      },
    };
  }
}

export async function runTakeoverFinalization(args: {
  runtime: BrowserRuntime;
  task: TaskRecord;
  handoff: TakeoverHandoff;
}): Promise<TakeoverResult> {
  return runPlaywrightDeterministicFinalization({
    runtime: args.runtime,
    task: args.task,
    currentUrl: args.handoff.current_url,
    recordedSteps: args.handoff.recorded_steps,
  });
}
