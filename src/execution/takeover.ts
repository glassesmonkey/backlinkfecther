import path from "node:path";

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

const UNATTENDED_POLICY = {
  allow_paid_listing: false,
  allow_reciprocal: false,
  allow_captcha_bypass: false,
  allow_google_oauth_chooser: true,
  allow_password_login: false,
  allow_2fa: false,
} as const;

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
        // Continue trying candidates.
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
      // Try other strategies.
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
      // Try other strategies.
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
        return `${element.tagName.toLowerCase()}[name=\"${CSS.escape(name)}\"][value=\"${CSS.escape(value)}\"]`;
      }

      if (name) {
        return `${element.tagName.toLowerCase()}[name=\"${CSS.escape(name)}\"]`;
      }

      const placeholder = element.getAttribute("placeholder");
      if (placeholder) {
        return `${element.tagName.toLowerCase()}[placeholder=\"${CSS.escape(placeholder)}\"]`;
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

  if (
    !UNATTENDED_POLICY.allow_paid_listing &&
    looksLikePaidGate(args.bodyText)
  ) {
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
    normalized.includes("login") ||
    (normalized.includes("continue with google") && !UNATTENDED_POLICY.allow_google_oauth_chooser) ||
    normalized.includes("login with google")
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

export async function runLiveTakeover(args: {
  runtime: BrowserRuntime;
  task: TaskRecord;
}): Promise<TakeoverResult> {
  return withConnectedPage(args.runtime.cdp_url, async (page) => {
    const recordedSteps: ReplayStep[] = [{ action: "goto", url: args.task.target_url }];
    const artifactPath = getArtifactFilePath(args.task.id, "takeover");
    const screenshotPath = path.join(DATA_DIRECTORIES.artifacts, `${args.task.id}-takeover.png`);

    try {
      const initialResponse = await page.goto(args.task.target_url, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });

      const initialSubmitTargets = await discoverSubmitTargets(page);
      const directSubmitTarget = initialSubmitTargets.find(
        (target) => /submit/i.test(target.href) && !isLoginGateHref(target.href),
      );
      if (directSubmitTarget) {
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
      if (!directSubmitTarget && fields.length === 0) {
        const entryStep = await clickByPatterns(page, SUBMIT_ENTRY_PATTERNS);
        if (entryStep) {
          recordedSteps.push(entryStep);
          fields = await discoverFields(page);
        }
      }

      const submitTargets = directSubmitTarget ? initialSubmitTargets : await discoverSubmitTargets(page);
      const loginGatedTarget = submitTargets.find((target) => isLoginGateHref(target.href));
      if (fields.length === 0 && loginGatedTarget) {
        await page.screenshot({ path: screenshotPath, fullPage: true });
        await writeJsonFile(artifactPath, {
          stage: "takeover",
          target_url: args.task.target_url,
          current_url: page.url(),
          title: await page.title(),
          submit_targets: submitTargets,
          decision: "login_gate_detected",
        });

        return {
          ok: false,
          next_status: "WAITING_MANUAL_AUTH",
          detail: "Directory exposes a submit flow, but unattended mode cannot cross the authentication gate automatically.",
          artifact_refs: [artifactPath, screenshotPath],
          wait: inferTerminalAuditWait(
            "DIRECTORY_LOGIN_REQUIRED",
            artifactPath,
            "Authentication gating was detected before a stable submit surface became available.",
          ),
          terminal_class: "login_required",
        };
      }

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
        response_status: initialResponse?.status(),
        submit_clicked: submitClicked,
        fields,
        recorded_steps: recordedSteps,
        body_excerpt: bodyText.slice(0, 2_000),
      });

      const outcome = inferCurrentOutcome({
        responseStatus: initialResponse?.status(),
        bodyText,
        submitClicked,
        evidenceRef: artifactPath,
      });

      const playbook: TrajectoryPlaybook | undefined =
        outcome.next_status === "WAITING_SITE_RESPONSE" || outcome.next_status === "WAITING_EXTERNAL_EVENT"
          ? {
              id: `playbook-${args.task.hostname}`,
              hostname: args.task.hostname,
              capture_source: "agent_live_takeover",
              surface_signature: `${args.task.hostname}:${page.url()}`,
              preconditions: [`Reach ${args.task.target_url}`],
              steps: recordedSteps,
              anchors: [args.task.hostname, args.task.submission.promoted_profile.name],
              postconditions: [outcome.detail],
              success_signals: ["thank you", "pending review", "submission received", "check your email"],
              fallback_notes: ["If replay fails, rerun scout and takeover."],
              replay_confidence: 0.6,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            }
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
  });
}
