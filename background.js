const EXPORT_STATE_KEY = "exportState";
const EXPORT_LOG_KEY = "exportLog";
const SIM_ORIGIN = "https://sim.3ue.com";
const SIM_HOME_URL = `${SIM_ORIGIN}/`;
const PAGE_POLL_INTERVAL_MS = 1000;
const PAGE_POLL_TIMEOUT_MS = 30000;
const MAX_LOG_ENTRIES = 120;
const TRAFFIC_REQUEST_TIMEOUT_MS = 15000;
const TRAFFIC_PAGE_TIMEOUT_MS = 45000;
const TRAFFIC_REQUEST_GAP_MIN_MS = 1800;
const TRAFFIC_REQUEST_GAP_MAX_MS = 3200;
const TRAFFIC_PROVIDER_MAX_ATTEMPTS = 2;
const TRAFFIC_RETRY_DELAY_MS = 10000;
const TRAFFIC_PROVIDER_COOLDOWN_STEPS_MS = [60000, 180000, 420000];
const TRAFFIC_FAILURES_BEFORE_COOLDOWN = 2;
const TRAFFIC_SUCCESSES_TO_RELAX_COOLDOWN = 4;

function buildSimilarwebDirectUrl(hostname) {
  return `https://data.similarweb.com/api/v1/data?domain=${encodeURIComponent(hostname)}`;
}

const TRAFFIC_PROVIDERS = [
  {
    id: "similarweb_direct",
    label: "SW API",
    mode: "browser",
    strategy: "json",
    buildUrl: buildSimilarwebDirectUrl
  },
  {
    id: "webspy",
    label: "WebSpy",
    mode: "api",
    apiUrl: "https://webspy.site/api/similarweb/?domain="
  }
];

function createEmptyResumeState() {
  return {
    available: false,
    sourceTabId: null,
    sourceUrl: null,
    phase: null,
    trafficDone: 0,
    trafficTotal: 0,
    skippedCount: 0,
    exportedRecords: [],
    completedHostnames: [],
    interruptedAt: null
  };
}

function normalizeExportedRecords(records) {
  if (!Array.isArray(records)) {
    return [];
  }

  return records
    .map((record) => ({
      hostname: String(record?.hostname || "").trim().toLowerCase(),
      sourceUrl: String(record?.sourceUrl || "").trim(),
      monthlyVisits: Math.round(Number(record?.monthlyVisits))
    }))
    .filter((record) => record.hostname && record.sourceUrl && Number.isFinite(record.monthlyVisits));
}

function normalizeCompletedHostnames(hostnames) {
  if (!Array.isArray(hostnames)) {
    return [];
  }

  const unique = new Set();
  for (const hostname of hostnames) {
    const normalized = String(hostname || "").trim().toLowerCase();
    if (normalized) {
      unique.add(normalized);
    }
  }

  return Array.from(unique);
}

function normalizeResumeState(resumeState) {
  const normalized = {
    ...createEmptyResumeState(),
    ...(resumeState || {})
  };

  normalized.sourceTabId = Number.isInteger(normalized.sourceTabId) ? normalized.sourceTabId : null;
  normalized.sourceUrl = normalized.sourceUrl ? String(normalized.sourceUrl) : null;
  normalized.phase = normalized.phase ? String(normalized.phase) : null;
  normalized.trafficDone = Math.max(0, Math.floor(Number(normalized.trafficDone) || 0));
  normalized.trafficTotal = Math.max(0, Math.floor(Number(normalized.trafficTotal) || 0));
  normalized.skippedCount = Math.max(0, Math.floor(Number(normalized.skippedCount) || 0));
  normalized.exportedRecords = normalizeExportedRecords(normalized.exportedRecords);
  normalized.completedHostnames = normalizeCompletedHostnames(normalized.completedHostnames);
  normalized.interruptedAt = normalized.interruptedAt ? String(normalized.interruptedAt) : null;
  normalized.available = Boolean(
    normalized.available
    || normalized.sourceTabId
    || normalized.sourceUrl
    || normalized.completedHostnames.length
    || normalized.exportedRecords.length
  );

  return normalized;
}

function createResumeState(sourceTabId, sourceUrl) {
  return normalizeResumeState({
    available: true,
    sourceTabId,
    sourceUrl,
    phase: "collecting_links"
  });
}

function updateResumeState(resumeState, patch = {}) {
  return normalizeResumeState({
    ...(resumeState || {}),
    ...patch
  });
}

function createEmptyProviderStatusSnapshot() {
  return TRAFFIC_PROVIDERS.reduce((snapshot, provider) => {
    snapshot[provider.id] = {
      label: provider.label,
      cooldownUntil: null,
      nextReadyAt: null,
      rateLimitHits: 0,
      lastErrorKind: null
    };
    return snapshot;
  }, {});
}

let exportState = {
  isRunning: false,
  phase: null,
  currentPage: null,
  totalPages: null,
  rawUrlCount: 0,
  uniqueHostCount: 0,
  trafficDone: 0,
  trafficTotal: 0,
  skippedCount: 0,
  activeTrafficProvider: null,
  globalCooldownUntil: null,
  providerStatus: createEmptyProviderStatusSnapshot(),
  resumeState: createEmptyResumeState(),
  message: "空闲"
};

let activeRun = null;

initializeState().catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !["START_EXPORT", "RESUME_EXPORT"].includes(message.type)) {
    return undefined;
  }

  if (activeRun) {
    sendResponse({ ok: false, error: "已有导出任务在运行" });
    return true;
  }

  const tabId = Number(message.tabId);
  if (!Number.isInteger(tabId)) {
    sendResponse({ ok: false, error: "无效的标签页" });
    return true;
  }

  const resumeState = message.type === "RESUME_EXPORT"
    ? normalizeResumeState(exportState.resumeState)
    : null;

  if (message.type === "RESUME_EXPORT" && !resumeState.available) {
    sendResponse({ ok: false, error: "当前没有可继续的任务" });
    return true;
  }

  activeRun = runExport(tabId, { resumeState })
    .catch((error) => {
      console.error(error);
    })
    .finally(() => {
      activeRun = null;
    });

  sendResponse({ ok: true });
  return true;
});

async function initializeState() {
  const stored = await chrome.storage.local.get([EXPORT_STATE_KEY, EXPORT_LOG_KEY]);
  if (stored[EXPORT_STATE_KEY]) {
    exportState = {
      ...exportState,
      ...stored[EXPORT_STATE_KEY],
      resumeState: normalizeResumeState(stored[EXPORT_STATE_KEY]?.resumeState),
      providerStatus: {
        ...createEmptyProviderStatusSnapshot(),
        ...(stored[EXPORT_STATE_KEY]?.providerStatus || {})
      }
    };

    if (exportState.isRunning) {
      const resumeState = updateResumeState(exportState.resumeState, {
        available: true,
        phase: exportState.phase,
        trafficDone: exportState.trafficDone,
        trafficTotal: exportState.trafficTotal,
        skippedCount: exportState.skippedCount,
        interruptedAt: new Date().toISOString()
      });

      exportState = {
        ...exportState,
        isRunning: false,
        activeTrafficProvider: null,
        resumeState,
        message: resumeState.available
          ? "上次任务已中断，可点击继续任务。"
          : "上次任务已中断，请重新开始。"
      };
      await chrome.storage.local.set({ [EXPORT_STATE_KEY]: exportState });
    }
  } else {
    await chrome.storage.local.set({ [EXPORT_STATE_KEY]: exportState });
  }

  if (!Array.isArray(stored[EXPORT_LOG_KEY])) {
    await chrome.storage.local.set({ [EXPORT_LOG_KEY]: [] });
  }
}

async function setExportState(patch, messageType = "EXPORT_PROGRESS") {
  exportState = {
    ...exportState,
    ...patch
  };
  await chrome.storage.local.set({ [EXPORT_STATE_KEY]: exportState });

  try {
    await chrome.runtime.sendMessage({
      type: messageType,
      payload: exportState
    });
  } catch (error) {
    // Popup may be closed; ignore.
  }
}

async function resetLogs() {
  await chrome.storage.local.set({ [EXPORT_LOG_KEY]: [] });
}

async function appendLog(level, message, details = null) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    details
  };

  console[level === "error" ? "error" : level === "warn" ? "warn" : "log"]("[sim-exporter]", message, details || "");

  const stored = await chrome.storage.local.get(EXPORT_LOG_KEY);
  const logs = Array.isArray(stored[EXPORT_LOG_KEY]) ? stored[EXPORT_LOG_KEY] : [];
  logs.push(entry);
  const trimmed = logs.slice(-MAX_LOG_ENTRIES);
  await chrome.storage.local.set({ [EXPORT_LOG_KEY]: trimmed });
}

function isBacklinksPage(urlString) {
  try {
    const url = new URL(urlString);
    return url.origin === SIM_ORIGIN && url.hash.includes("/digitalsuite/acquisition/backlinks/table/");
  } catch (error) {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function formatTimestamp(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function escapeCsv(value) {
  const text = String(value ?? "");
  if (!/[",\n]/.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, "\"\"")}"`;
}

function createCsv(records) {
  const rows = [
    ["hostname", "source_url", "monthly_visits"],
    ...records.map((record) => [record.hostname, record.sourceUrl, String(record.monthlyVisits)])
  ];
  return rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
}

function createTrafficProviderStates() {
  return TRAFFIC_PROVIDERS.map((provider) => ({
    ...provider,
    nextAllowedAt: 0,
    cooldownUntil: null,
    cooldownLevel: 0,
    consecutiveRetryableFailures: 0,
    successStreak: 0,
    rateLimitHits: 0,
    lastErrorKind: null,
    tabId: null
  }));
}

function buildProviderStatusSnapshot(providerStates) {
  const snapshot = createEmptyProviderStatusSnapshot();
  const now = Date.now();

  for (const providerState of providerStates) {
    snapshot[providerState.id] = {
      label: providerState.label,
      cooldownUntil: providerState.cooldownUntil && providerState.cooldownUntil > now
        ? new Date(providerState.cooldownUntil).toISOString()
        : null,
      nextReadyAt: providerState.nextAllowedAt > now
        ? new Date(providerState.nextAllowedAt).toISOString()
        : null,
      rateLimitHits: providerState.rateLimitHits,
      lastErrorKind: providerState.lastErrorKind
    };
  }

  return snapshot;
}

function getGlobalCooldownUntil(providerStates) {
  const now = Date.now();
  const blockedUntil = providerStates
    .map((providerState) => providerState.nextAllowedAt)
    .filter((timestamp) => timestamp > now);

  if (!blockedUntil.length || blockedUntil.length !== providerStates.length) {
    return null;
  }

  return new Date(Math.min(...blockedUntil)).toISOString();
}

function buildTrafficStatePatch(providerStates, patch = {}) {
  return {
    ...patch,
    providerStatus: buildProviderStatusSnapshot(providerStates),
    globalCooldownUntil: getGlobalCooldownUntil(providerStates)
  };
}

function getProviderLabel(providerId) {
  return TRAFFIC_PROVIDERS.find((provider) => provider.id === providerId)?.label || providerId || "-";
}

function isProviderReady(providerState, now = Date.now()) {
  return providerState.nextAllowedAt <= now;
}

function getReadyProviders(providerStates, attemptsByProvider, now = Date.now()) {
  return providerStates
    .filter((providerState) => attemptsByProvider[providerState.id] < TRAFFIC_PROVIDER_MAX_ATTEMPTS)
    .filter((providerState) => isProviderReady(providerState, now));
}

function chooseProvider(readyProviders, attemptsByProvider) {
  if (!readyProviders.length) {
    return null;
  }

  const sorted = [...readyProviders].sort((left, right) => {
    const leftAttempts = attemptsByProvider[left.id];
    const rightAttempts = attemptsByProvider[right.id];

    if (leftAttempts !== rightAttempts) {
      return leftAttempts - rightAttempts;
    }

    if (left.cooldownLevel !== right.cooldownLevel) {
      return left.cooldownLevel - right.cooldownLevel;
    }

    if (left.consecutiveRetryableFailures !== right.consecutiveRetryableFailures) {
      return left.consecutiveRetryableFailures - right.consecutiveRetryableFailures;
    }

    return TRAFFIC_PROVIDERS.findIndex((provider) => provider.id === left.id)
      - TRAFFIC_PROVIDERS.findIndex((provider) => provider.id === right.id);
  });

  return sorted[0];
}

function getEarliestProviderReadyAt(providerStates, attemptsByProvider) {
  const blockedProviders = providerStates
    .filter((providerState) => attemptsByProvider[providerState.id] < TRAFFIC_PROVIDER_MAX_ATTEMPTS)
    .map((providerState) => providerState.nextAllowedAt)
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > Date.now());

  if (!blockedProviders.length) {
    return null;
  }

  return Math.min(...blockedProviders);
}

function getAlternativeProvider(providerStates, currentProviderId, attemptsByProvider) {
  const now = Date.now();

  return providerStates.find((providerState) => {
    if (providerState.id === currentProviderId) {
      return false;
    }

    if (attemptsByProvider[providerState.id] > 0) {
      return false;
    }

    return isProviderReady(providerState, now);
  }) || null;
}

function applyProviderCooldown(providerState, reasonKind) {
  const now = Date.now();
  const cooldownIndex = Math.min(
    providerState.cooldownLevel,
    TRAFFIC_PROVIDER_COOLDOWN_STEPS_MS.length - 1
  );
  const cooldownMs = TRAFFIC_PROVIDER_COOLDOWN_STEPS_MS[cooldownIndex];
  const cooldownUntil = now + cooldownMs;

  providerState.nextAllowedAt = Math.max(providerState.nextAllowedAt, cooldownUntil);
  providerState.cooldownUntil = providerState.nextAllowedAt;
  providerState.cooldownLevel = Math.min(
    providerState.cooldownLevel + 1,
    TRAFFIC_PROVIDER_COOLDOWN_STEPS_MS.length - 1
  );
  providerState.consecutiveRetryableFailures = 0;
  providerState.successStreak = 0;
  providerState.lastErrorKind = reasonKind;

  if (reasonKind === "rate_limited") {
    providerState.rateLimitHits += 1;
  }

  return cooldownMs;
}

function applyProviderRetryBackoff(providerState, reasonKind) {
  providerState.nextAllowedAt = Math.max(
    providerState.nextAllowedAt,
    Date.now() + TRAFFIC_RETRY_DELAY_MS
  );
  providerState.cooldownUntil = null;
  providerState.successStreak = 0;
  providerState.lastErrorKind = reasonKind;
}

function markProviderSuccess(providerState) {
  providerState.nextAllowedAt = 0;
  providerState.cooldownUntil = null;
  providerState.consecutiveRetryableFailures = 0;
  providerState.successStreak += 1;
  providerState.lastErrorKind = null;

  if (
    providerState.successStreak >= TRAFFIC_SUCCESSES_TO_RELAX_COOLDOWN
    && providerState.cooldownLevel > 0
  ) {
    providerState.cooldownLevel -= 1;
    providerState.successStreak = 0;
  }
}

function classifyTrafficError(error) {
  if (!error) {
    return {
      kind: "unknown",
      retryable: true,
      message: "未知错误"
    };
  }

  if (error.name === "AbortError") {
    return {
      kind: "timeout",
      retryable: true,
      message: "请求超时"
    };
  }

  const message = error?.message || String(error);

  if (message.includes("页面加载超时") || message.includes("等待页面状态超时")) {
    return {
      kind: "timeout",
      retryable: true,
      message: "页面加载超时"
    };
  }

  if (
    message.includes("页面中没有找到流量指标")
    || message.includes("页面中没有读取到 Similarweb JSON 数据")
  ) {
    return {
      kind: "bad_response",
      retryable: false,
      message
    };
  }

  if (message.includes("Failed to fetch") || message.includes("NetworkError")) {
    return {
      kind: "network",
      retryable: true,
      message: "Failed to fetch"
    };
  }

  return {
    kind: "unknown",
    retryable: true,
    message
  };
}

function createFinalTrafficFailure(hostname, attemptsByProvider, lastFailure) {
  const attemptSummary = TRAFFIC_PROVIDERS
    .map((provider) => `${provider.label} ${attemptsByProvider[provider.id]} 次`)
    .join(" / ");
  const reason = lastFailure?.message || "所有流量源都失败";

  return new Error(`${reason} | ${hostname} | ${attemptSummary}`);
}

function parseCompactMetricValue(value) {
  const text = String(value ?? "").replace(/,/g, "").trim();
  const match = text.match(/([0-9]+(?:\.[0-9]+)?)\s*([KMBT]?)/i);
  if (!match) {
    return null;
  }

  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) {
    return null;
  }

  const unit = (match[2] || "").toUpperCase();
  const factors = {
    "": 1,
    K: 1000,
    M: 1000 * 1000,
    B: 1000 * 1000 * 1000,
    T: 1000 * 1000 * 1000 * 1000
  };

  return Math.round(amount * (factors[unit] || 1));
}

async function getTabOrThrow(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.id || !tab.url) {
    throw new Error("找不到目标标签页");
  }
  return tab;
}

async function createBackgroundTab(url, openerTabId) {
  const tab = await chrome.tabs.create({
    url,
    active: false,
    openerTabId
  });

  if (!tab.id) {
    throw new Error("后台标签页创建失败");
  }

  return tab;
}

async function navigateTab(tabId, url) {
  await chrome.tabs.update(tabId, { url });
}

async function closeTrafficProviderTabs(providerStates) {
  for (const providerState of providerStates) {
    await closeTab(providerState.tabId);
    providerState.tabId = null;
  }
}

async function closeTab(tabId) {
  if (!tabId) {
    return;
  }

  try {
    await chrome.tabs.remove(tabId);
  } catch (error) {
    // Ignore already-closed tabs.
  }
}

async function executeInTab(tabId, func, args = []) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId },
    func,
    args
  });
  return result?.result;
}

async function waitForTabStatusComplete(tabId, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === "complete") {
      return;
    }
    await sleep(500);
  }
  throw new Error("页面加载超时");
}

async function waitForCondition(tabId, func, args, options = {}) {
  const timeoutMs = options.timeoutMs || PAGE_POLL_TIMEOUT_MS;
  const intervalMs = options.intervalMs || PAGE_POLL_INTERVAL_MS;
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    let result = null;

    try {
      result = await executeInTab(tabId, func, args);
    } catch (error) {
      const message = error?.message || "";
      if (!message.includes("The frame was removed") && !message.includes("Cannot access contents")) {
        throw error;
      }
    }

    if (result) {
      return result;
    }

    await sleep(intervalMs);
  }

  throw new Error("等待页面状态超时");
}

async function runExport(sourceTabId, options = {}) {
  let backlinksTabId = null;
  const providerStates = createTrafficProviderStates();
  const initialResumeState = normalizeResumeState(options.resumeState);
  const isResumeRun = initialResumeState.available;
  let resumeState = createEmptyResumeState();

  try {
    const sourceTab = await getTabOrThrow(sourceTabId);
    if (!isBacklinksPage(sourceTab.url)) {
      throw new Error("当前标签页不是 sim.3ue.com 反向链接列表页");
    }

    resumeState = isResumeRun
      ? updateResumeState(initialResumeState, {
        available: true,
        sourceTabId,
        sourceUrl: initialResumeState.sourceUrl || sourceTab.url,
        interruptedAt: null
      })
      : createResumeState(sourceTabId, sourceTab.url);

    if (isResumeRun && initialResumeState.sourceUrl && initialResumeState.sourceUrl !== sourceTab.url) {
      throw new Error("请回到上次启动任务的反链列表页后再继续");
    }

    if (!isResumeRun) {
      await resetLogs();
    }

    await appendLog("info", isResumeRun ? "继续导出任务" : "开始导出任务", {
      sourceTabId,
      url: sourceTab.url,
      resumed: isResumeRun
    });

    await setExportState({
      isRunning: true,
      phase: "collecting_links",
      currentPage: null,
      totalPages: null,
      rawUrlCount: 0,
      uniqueHostCount: 0,
      trafficDone: 0,
      trafficTotal: 0,
      skippedCount: 0,
      activeTrafficProvider: null,
      providerStatus: buildProviderStatusSnapshot(providerStates),
      globalCooldownUntil: null,
      resumeState: updateResumeState(resumeState, {
        phase: "collecting_links",
        interruptedAt: null
      }),
      message: isResumeRun ? "正在恢复任务并重新采集反链列表" : "正在创建后台工作页"
    });

    const backlinksTab = await createBackgroundTab(sourceTab.url, sourceTabId);
    backlinksTabId = backlinksTab.id;
    await appendLog("info", "已创建反链后台页", { backlinksTabId });

    await waitForTabStatusComplete(backlinksTabId, PAGE_POLL_TIMEOUT_MS);
    const backlinkMap = await collectBacklinks(backlinksTabId);
    await appendLog("info", "反链采集完成", {
      uniqueHostCount: backlinkMap.size,
      rawUrlCount: exportState.rawUrlCount
    });

    resumeState = updateResumeState(resumeState, {
      phase: "reading_traffic",
      trafficTotal: backlinkMap.size
    });

    await setExportState({
      phase: "reading_traffic",
      trafficDone: Math.min(resumeState.completedHostnames.length, backlinkMap.size),
      trafficTotal: backlinkMap.size,
      skippedCount: resumeState.skippedCount,
      activeTrafficProvider: null,
      providerStatus: buildProviderStatusSnapshot(providerStates),
      globalCooldownUntil: null,
      resumeState,
      message: "正在通过 Similarweb API 和 WebSpy 读取每个域名的流量"
    });

    await appendLog("info", "开始读取流量", {
      trafficTotal: backlinkMap.size,
      providers: TRAFFIC_PROVIDERS.map((provider) => provider.label)
    });

    const exportedRecords = await collectTrafficRecords(
      backlinkMap,
      providerStates,
      sourceTabId,
      resumeState,
      isResumeRun
    );

    resumeState = updateResumeState(resumeState, {
      phase: "exporting",
      trafficDone: backlinkMap.size,
      trafficTotal: backlinkMap.size,
      exportedRecords
    });

    await setExportState({
      phase: "exporting",
      activeTrafficProvider: null,
      resumeState,
      message: "正在生成 CSV"
    });

    const csv = createCsv(exportedRecords);
    const dataUrl = `data:text/csv;charset=utf-8,${encodeURIComponent(csv)}`;
    const filename = `sim-backlinks-${formatTimestamp()}.csv`;

    await chrome.downloads.download({
      url: dataUrl,
      filename,
      saveAs: false
    });

    await appendLog("info", "CSV 下载已触发", {
      exportedCount: exportedRecords.length,
      filename
    });

    await setExportState({
      isRunning: false,
      phase: "done",
      activeTrafficProvider: null,
      resumeState: createEmptyResumeState(),
      message: `导出完成，共 ${exportedRecords.length} 条记录`
    }, "EXPORT_DONE");
  } catch (error) {
    const nextResumeState = updateResumeState(resumeState, {
      phase: exportState.phase,
      trafficDone: exportState.trafficDone,
      trafficTotal: exportState.trafficTotal,
      skippedCount: exportState.skippedCount,
      interruptedAt: new Date().toISOString()
    });
    await appendLog("error", "导出失败", {
      error: error?.message || "未知错误"
    });
    await setExportState({
      isRunning: false,
      phase: "error",
      activeTrafficProvider: null,
      resumeState: nextResumeState,
      message: nextResumeState.available
        ? `导出失败：${error?.message || "未知错误"}，可点击继续任务。`
        : (error?.message || "导出失败")
    }, "EXPORT_ERROR");
  } finally {
    await closeTab(backlinksTabId);
    await closeTrafficProviderTabs(providerStates);
  }
}

async function collectBacklinks(tabId) {
  const backlinkMap = new Map();
  let previousFirstHref = null;
  let pageGuard = 0;
  let rawUrlCount = 0;
  let expectedTotalPages = null;

  while (true) {
    pageGuard += 1;
    if (pageGuard > 500) {
      throw new Error("分页次数异常，已停止导出");
    }

    const snapshot = await waitForCondition(
      tabId,
      getBacklinksPageSnapshot,
      [],
      { timeoutMs: PAGE_POLL_TIMEOUT_MS }
    );

    if (expectedTotalPages === null) {
      expectedTotalPages = snapshot.totalPages;
      await appendLog("info", "锁定总页数", {
        totalPages: expectedTotalPages
      });
    } else if (snapshot.totalPages !== expectedTotalPages || snapshot.currentPage > expectedTotalPages) {
      await appendLog("warn", "检测到异常分页，提前结束反链采集", {
        expectedTotalPages,
        currentPage: snapshot.currentPage,
        totalPages: snapshot.totalPages,
        pageUrlCount: snapshot.urls.length
      });
      break;
    }

    for (const href of snapshot.urls) {
      let hostname;
      try {
        hostname = new URL(href).hostname.toLowerCase();
      } catch (error) {
        continue;
      }

      if (!backlinkMap.has(hostname)) {
        backlinkMap.set(hostname, {
          hostname,
          sourceUrl: href
        });
      }
    }

    rawUrlCount += snapshot.urls.length;

    await setExportState({
      phase: "collecting_links",
      currentPage: snapshot.currentPage,
      totalPages: snapshot.totalPages,
      rawUrlCount,
      uniqueHostCount: backlinkMap.size,
      message: `正在采集第 ${snapshot.currentPage} / ${snapshot.totalPages} 页`
    });

    await appendLog("info", "已采集页面", {
      page: snapshot.currentPage,
      totalPages: expectedTotalPages,
      pageUrlCount: snapshot.urls.length,
      rawUrlCount,
      uniqueHostCount: backlinkMap.size
    });

    if (!snapshot.hasNext || snapshot.currentPage >= expectedTotalPages) {
      await appendLog("info", "检测到最后一页", {
        page: snapshot.currentPage,
        totalPages: expectedTotalPages
      });
      break;
    }

    const waitMs = randomDelayMs(3000, 6000);
    await setExportState({
      message: `等待 ${Math.round(waitMs / 1000)} 秒后翻到下一页`
    });
    await appendLog("info", "准备翻页", {
      page: snapshot.currentPage,
      waitMs
    });
    await sleep(waitMs);

    let clickResult = await executeInTab(tabId, clickNextPageButton, []);
    if (!clickResult?.clicked) {
      await appendLog("warn", "第一次翻页未成功", clickResult);
      await sleep(1500);
      clickResult = await executeInTab(tabId, clickNextPageButton, []);
    }

    if (!clickResult?.clicked) {
      await appendLog("error", "翻页失败", clickResult);
      throw new Error(formatClickFailure(clickResult));
    }

    const currentPage = snapshot.currentPage;
    previousFirstHref = snapshot.firstHref;

    await waitForCondition(
      tabId,
      didBacklinksPageAdvance,
      [currentPage, previousFirstHref],
      { timeoutMs: PAGE_POLL_TIMEOUT_MS }
    );
  }

  return backlinkMap;
}

async function collectTrafficRecords(backlinkMap, providerStates, sourceTabId, resumeState, isResumeRun) {
  const records = Array.from(backlinkMap.values());
  const availableHostnames = new Set(records.map((record) => record.hostname));
  const exported = resumeState.exportedRecords.filter((record) => availableHostnames.has(record.hostname));
  const completedHostnames = new Set(
    records
      .map((record) => record.hostname)
      .filter((hostname) => resumeState.completedHostnames.includes(hostname))
  );
  let skippedCount = resumeState.skippedCount;
  let processedCount = completedHostnames.size;

  if (isResumeRun && processedCount > 0) {
    await appendLog("info", "已恢复上次进度", {
      processedCount,
      trafficTotal: records.length,
      exportedCount: exported.length,
      skippedCount
    });
  }

  for (const record of records) {
    if (completedHostnames.has(record.hostname)) {
      continue;
    }

    await setExportState(buildTrafficStatePatch(providerStates, {
      phase: "reading_traffic",
      trafficDone: processedCount,
      trafficTotal: records.length,
      skippedCount,
      activeTrafficProvider: null,
      resumeState: updateResumeState(resumeState, {
        phase: "reading_traffic",
        trafficDone: processedCount,
        trafficTotal: records.length,
        skippedCount,
        exportedRecords: exported,
        completedHostnames: Array.from(completedHostnames)
      }),
      message: `正在读取 ${record.hostname} 的月访问量`
    }));

    try {
      const monthlyVisits = await fetchMonthlyVisitsWithScheduler(
        record.hostname,
        providerStates,
        processedCount,
        records.length,
        sourceTabId
      );

      if (monthlyVisits > 100) {
        exported.push({
          hostname: record.hostname,
          sourceUrl: record.sourceUrl,
          monthlyVisits
        });
      }

      if ((processedCount + 1) % 50 === 0) {
        await appendLog("info", "流量读取进度", {
          trafficDone: processedCount + 1,
          trafficTotal: records.length,
          exportedCount: exported.length,
          skippedCount,
          providerStatus: buildProviderStatusSnapshot(providerStates)
        });
      }
    } catch (error) {
      skippedCount += 1;
      await appendLog("warn", "跳过域名", {
        hostname: record.hostname,
        reason: error?.message || "流量读取失败"
      });
      await setExportState(buildTrafficStatePatch(providerStates, {
        skippedCount,
        activeTrafficProvider: null,
        resumeState: updateResumeState(resumeState, {
          phase: "reading_traffic",
          trafficDone: processedCount,
          trafficTotal: records.length,
          skippedCount,
          exportedRecords: exported,
          completedHostnames: Array.from(completedHostnames)
        }),
        message: `跳过 ${record.hostname}，原因：${error?.message || "流量读取失败"}`
      }));
    }

    completedHostnames.add(record.hostname);
    processedCount += 1;
    resumeState = updateResumeState(resumeState, {
      phase: "reading_traffic",
      trafficDone: processedCount,
      trafficTotal: records.length,
      skippedCount,
      exportedRecords: exported,
      completedHostnames: Array.from(completedHostnames)
    });

    await setExportState(buildTrafficStatePatch(providerStates, {
      trafficDone: processedCount,
      trafficTotal: records.length,
      skippedCount,
      resumeState
    }));
  }

  await setExportState(buildTrafficStatePatch(providerStates, {
    trafficDone: records.length,
    trafficTotal: records.length,
    skippedCount,
    activeTrafficProvider: null,
    resumeState: updateResumeState(resumeState, {
      phase: "reading_traffic",
      trafficDone: records.length,
      trafficTotal: records.length,
      skippedCount,
      exportedRecords: exported,
      completedHostnames: Array.from(completedHostnames)
    })
  }));

  return exported;
}

async function fetchMonthlyVisitsWithScheduler(hostname, providerStates, index, totalRecords, sourceTabId) {
  const attemptsByProvider = TRAFFIC_PROVIDERS.reduce((attempts, provider) => {
    attempts[provider.id] = 0;
    return attempts;
  }, {});
  let lastFailure = null;

  while (true) {
    const readyProviders = getReadyProviders(providerStates, attemptsByProvider);
    const chosenProvider = chooseProvider(readyProviders, attemptsByProvider);

    if (!chosenProvider) {
      const nextReadyAt = getEarliestProviderReadyAt(providerStates, attemptsByProvider);
      if (!nextReadyAt) {
        throw createFinalTrafficFailure(hostname, attemptsByProvider, lastFailure);
      }

      const waitMs = Math.max(nextReadyAt - Date.now(), 0);
      const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));

      await appendLog("warn", "所有流量源都在冷却", {
        hostname,
        waitSeconds,
        providerStatus: buildProviderStatusSnapshot(providerStates)
      });
      await setExportState(buildTrafficStatePatch(providerStates, {
        phase: "reading_traffic",
        trafficDone: index,
        trafficTotal: totalRecords,
        activeTrafficProvider: null,
        message: `所有流量源都在冷却，等待 ${waitSeconds} 秒后继续`
      }));
      await sleep(waitMs);
      continue;
    }

    const attemptNumber = attemptsByProvider[chosenProvider.id] + 1;
    attemptsByProvider[chosenProvider.id] = attemptNumber;

    const requestGapMs = randomDelayMs(TRAFFIC_REQUEST_GAP_MIN_MS, TRAFFIC_REQUEST_GAP_MAX_MS);
    await setExportState(buildTrafficStatePatch(providerStates, {
      phase: "reading_traffic",
      trafficDone: index,
      trafficTotal: totalRecords,
      activeTrafficProvider: chosenProvider.id,
      message: `使用 ${chosenProvider.label} 读取 ${hostname}，第 ${attemptNumber} 次尝试`
    }));
    await sleep(requestGapMs);

    const result = await fetchTrafficFromProvider(chosenProvider, hostname, sourceTabId);

    if (result.ok) {
      markProviderSuccess(chosenProvider);
      await appendLog("info", "流量读取成功", {
        hostname,
        provider: chosenProvider.label,
        monthlyVisits: result.visits,
        attempt: attemptNumber
      });
      return result.visits;
    }

    lastFailure = result;
    if (result.retryable) {
      chosenProvider.consecutiveRetryableFailures += 1;

      const shouldCooldown = result.kind === "rate_limited"
        || chosenProvider.consecutiveRetryableFailures >= TRAFFIC_FAILURES_BEFORE_COOLDOWN;

      if (shouldCooldown) {
        const cooldownMs = applyProviderCooldown(chosenProvider, result.kind);
        await appendLog("warn", "流量源进入冷却", {
          hostname,
          provider: chosenProvider.label,
          errorKind: result.kind,
          attempt: attemptNumber,
          cooldownSeconds: Math.ceil(cooldownMs / 1000)
        });
      } else {
        applyProviderRetryBackoff(chosenProvider, result.kind);
        await appendLog("warn", "流量源准备重试", {
          hostname,
          provider: chosenProvider.label,
          errorKind: result.kind,
          attempt: attemptNumber,
          retryDelaySeconds: Math.ceil(TRAFFIC_RETRY_DELAY_MS / 1000)
        });
      }
    } else {
      chosenProvider.consecutiveRetryableFailures = 0;
      chosenProvider.successStreak = 0;
      chosenProvider.lastErrorKind = result.kind;
      attemptsByProvider[chosenProvider.id] = TRAFFIC_PROVIDER_MAX_ATTEMPTS;
    }

    const alternativeProvider = getAlternativeProvider(
      providerStates,
      chosenProvider.id,
      attemptsByProvider
    );

    if (alternativeProvider) {
      await appendLog("warn", "当前流量源失败，切换到另一个来源", {
        hostname,
        failedProvider: chosenProvider.label,
        nextProvider: alternativeProvider.label,
        errorKind: result.kind
      });
      await setExportState(buildTrafficStatePatch(providerStates, {
        phase: "reading_traffic",
        trafficDone: index,
        trafficTotal: totalRecords,
        activeTrafficProvider: alternativeProvider.id,
        message: `${chosenProvider.label} 失败，准备切换到 ${alternativeProvider.label}`
      }));
      continue;
    }

    const providerTriedCount = Object.values(attemptsByProvider)
      .filter((count) => count > 0)
      .length;
    if (providerTriedCount >= TRAFFIC_PROVIDERS.length) {
      throw createFinalTrafficFailure(hostname, attemptsByProvider, lastFailure);
    }

    if (attemptsByProvider[chosenProvider.id] >= TRAFFIC_PROVIDER_MAX_ATTEMPTS) {
      await appendLog("warn", "当前来源已耗尽重试次数", {
        hostname,
        provider: chosenProvider.label,
        errorKind: result.kind
      });
    }
  }
}

async function fetchTrafficFromProvider(provider, hostname, sourceTabId) {
  if (provider.mode === "browser") {
    return fetchTrafficFromBrowserProvider(provider, hostname, sourceTabId);
  }

  return fetchTrafficFromApiProvider(provider, hostname);
}

async function fetchTrafficFromApiProvider(provider, hostname) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TRAFFIC_REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${provider.apiUrl}${encodeURIComponent(hostname)}`, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "Accept": "application/json"
      }
    });

    if (!response.ok) {
      const body = await response.text();
      if (response.status === 429) {
        return {
          ok: false,
          kind: "rate_limited",
          retryable: true,
          message: `${provider.label} 429: ${body.slice(0, 160)}`
        };
      }

      if (response.status >= 500) {
        return {
          ok: false,
          kind: "upstream_5xx",
          retryable: true,
          message: `${provider.label} ${response.status}: ${body.slice(0, 160)}`
        };
      }

      return {
        ok: false,
        kind: "client_4xx",
        retryable: false,
        message: `${provider.label} ${response.status}: ${body.slice(0, 160)}`
      };
    }

    const data = await response.json();
    const visits = parseTrafficVisits(data);
    if (visits === null) {
      return {
        ok: false,
        kind: "no_visits",
        retryable: false,
        message: `${provider.label} 响应中没有可用的 Visits`
      };
    }

    return {
      ok: true,
      visits
    };
  } catch (error) {
    const classifiedError = classifyTrafficError(error);
    return {
      ok: false,
      kind: classifiedError.kind,
      retryable: classifiedError.retryable,
      message: `${provider.label} ${classifiedError.message}`
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function ensureTrafficProviderTab(providerState, targetUrl, openerTabId) {
  if (providerState.tabId) {
    try {
      const tab = await getTabOrThrow(providerState.tabId);
      if (tab.url !== targetUrl) {
        await navigateTab(providerState.tabId, targetUrl);
      }
      return providerState.tabId;
    } catch (error) {
      providerState.tabId = null;
    }
  }

  const tab = await createBackgroundTab(targetUrl, openerTabId);
  providerState.tabId = tab.id;
  return providerState.tabId;
}

async function fetchTrafficFromBrowserProvider(providerState, hostname, openerTabId) {
  const targetUrl = providerState.buildUrl(hostname);
  const tabId = await ensureTrafficProviderTab(providerState, targetUrl, openerTabId);

  try {
    await waitForTabStatusComplete(tabId, TRAFFIC_PAGE_TIMEOUT_MS);
    const snapshot = await waitForCondition(
      tabId,
      readTrafficJsonDocumentSnapshot,
      [hostname],
      {
        timeoutMs: TRAFFIC_PAGE_TIMEOUT_MS,
        intervalMs: PAGE_POLL_INTERVAL_MS
      }
    );

    return {
      ok: true,
      visits: snapshot.visits
    };
  } catch (error) {
    let message = error?.message || "页面中没有读取到 Similarweb JSON 数据";

    if (message.includes("等待页面状态超时")) {
      const diagnostics = await executeInTab(tabId, readTrafficJsonPageDiagnostics, [hostname]).catch(() => null);
      message = `页面中没有读取到 Similarweb JSON 数据: ${providerState.label}${diagnostics ? ` | ${JSON.stringify(diagnostics)}` : ""}`;
    }

    const classifiedError = classifyTrafficError(new Error(message));
    return {
      ok: false,
      kind: classifiedError.kind,
      retryable: classifiedError.retryable,
      message: `${providerState.label} ${classifiedError.message}`
    };
  }
}

function parseTrafficVisits(data) {
  const directVisits = Number(data?.Engagments?.Visits);
  if (Number.isFinite(directVisits)) {
    return Math.round(directVisits);
  }

  const monthly = data?.EstimatedMonthlyVisits;
  if (monthly && typeof monthly === "object") {
    const values = Object.values(monthly)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));
    if (values.length) {
      return Math.round(values[values.length - 1]);
    }
  }

  return null;
}

function readTrafficJsonDocumentSnapshot(hostname) {
  function extractJsonText() {
    const preText = document.querySelector("pre")?.textContent?.trim();
    if (preText) {
      return preText;
    }

    const bodyText = document.body?.innerText?.trim();
    if (bodyText) {
      return bodyText;
    }

    return document.documentElement?.innerText?.trim() || "";
  }

  const rawText = extractJsonText();
  if (!rawText) {
    return null;
  }

  let data;
  try {
    data = JSON.parse(rawText);
  } catch (error) {
    return null;
  }

  const requestedHostname = String(hostname || "").toLowerCase();
  const responseHostname = String(data?.Domain || data?.domain || "").toLowerCase();

  if (requestedHostname && responseHostname && requestedHostname !== responseHostname) {
    return null;
  }

  const directVisits = Number(data?.Engagments?.Visits);
  if (Number.isFinite(directVisits)) {
    return {
      url: location.href,
      title: document.title,
      hostname: responseHostname || requestedHostname,
      visits: Math.round(directVisits)
    };
  }

  const monthly = data?.EstimatedMonthlyVisits;
  if (monthly && typeof monthly === "object") {
    const values = Object.values(monthly)
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value));

    if (values.length) {
      return {
        url: location.href,
        title: document.title,
        hostname: responseHostname || requestedHostname,
        visits: Math.round(values[values.length - 1])
      };
    }
  }

  return null;
}

function readTrafficJsonPageDiagnostics(hostname) {
  const preText = document.querySelector("pre")?.textContent?.trim() || "";
  const bodyText = document.body?.innerText?.trim() || document.documentElement?.innerText?.trim() || "";

  return {
    url: location.href,
    title: document.title,
    hostname,
    bodySample: (preText || bodyText).slice(0, 300)
  };
}

function formatClickFailure(clickResult) {
  const diagnostics = clickResult?.diagnostics || {};
  const parts = [clickResult?.error || "翻页失败"];

  if (diagnostics.href) {
    parts.push(`href=${diagnostics.href}`);
  }
  if (diagnostics.title) {
    parts.push(`title=${diagnostics.title}`);
  }
  if (diagnostics.pagerValue || diagnostics.pagerText) {
    parts.push(`pager=${diagnostics.pagerValue || "-"}${diagnostics.pagerText || ""}`);
  }
  if (typeof diagnostics.linkCount === "number") {
    parts.push(`links=${diagnostics.linkCount}`);
  }
  if (diagnostics.routeOk === false) {
    parts.push("页面已离开反向链接页");
  }

  return parts.join(" | ");
}

function getBacklinksPageSnapshot() {
  function findBacklinksTableWrapper() {
    const wrappers = Array.from(document.querySelectorAll(".ant-table-wrapper"));
    return wrappers.find((wrapper) => {
      const text = (wrapper.textContent || "").replace(/\s+/g, " ").trim();
      return text.includes("引用页面标题和网址") && wrapper.querySelector("tbody tr a.ad-target-url");
    }) || null;
  }

  const wrapper = findBacklinksTableWrapper();
  if (!wrapper) {
    return null;
  }

  const anchors = Array.from(wrapper.querySelectorAll("tbody tr a.ad-target-url"));
  const urls = anchors
    .map((anchor) => anchor.href)
    .filter(Boolean);

  const pagerInput = wrapper.querySelector("li.ant-pagination-simple-pager input");
  const pagerText = wrapper.querySelector("li.ant-pagination-simple-pager")?.textContent || "";
  const totalPagesMatch = pagerText.match(/\/\s*(\d+)/);
  const nextButton = wrapper.querySelector("li.ant-pagination-next");
  const currentPage = pagerInput ? Number(pagerInput.value) : null;
  const totalPages = totalPagesMatch ? Number(totalPagesMatch[1]) : null;

  if (!urls.length || !currentPage || !totalPages) {
    return null;
  }

  return {
    urls,
    rawUrlCount: urls.length,
    firstHref: urls[0] || null,
    currentPage,
    totalPages,
    hasNext: nextButton ? nextButton.getAttribute("aria-disabled") !== "true" : false
  };
}

async function clickNextPageButton() {
  function collectDiagnostics() {
    const wrappers = Array.from(document.querySelectorAll(".ant-table-wrapper"));
    const wrapper = wrappers.find((candidate) => {
      const text = (candidate.textContent || "").replace(/\s+/g, " ").trim();
      return text.includes("引用页面标题和网址");
    }) || null;
    const pagerInput = wrapper?.querySelector("li.ant-pagination-simple-pager input");
    const pagerText = wrapper?.querySelector("li.ant-pagination-simple-pager")?.textContent?.trim() || null;
    const nextLi = wrapper?.querySelector("li.ant-pagination-next, li[title='Next Page']") || null;
    const pagination = wrapper?.querySelector("ul.ant-pagination") || null;
    return {
      href: location.href,
      title: document.title,
      routeOk: location.hash.includes("/digitalsuite/acquisition/backlinks/table/"),
      pagerValue: pagerInput?.value || null,
      pagerText,
      linkCount: wrapper ? wrapper.querySelectorAll("tbody tr a.ad-target-url").length : 0,
      tableFound: Boolean(wrapper),
      nextExists: Boolean(nextLi),
      paginationExists: Boolean(pagination),
      paginationHtml: pagination?.outerHTML?.slice(0, 800) || null,
      bodySample: (document.body?.innerText || "").slice(0, 300)
    };
  }

  function findNextButton() {
    const wrappers = Array.from(document.querySelectorAll(".ant-table-wrapper"));
    const wrapper = wrappers.find((candidate) => {
      const text = (candidate.textContent || "").replace(/\s+/g, " ").trim();
      return text.includes("引用页面标题和网址") && candidate.querySelector("tbody tr a.ad-target-url");
    }) || null;
    if (!wrapper) {
      return null;
    }

    const selectors = [
      "li.ant-pagination-next",
      "li[title='Next Page']",
      "ul.ant-pagination li.ant-pagination-next"
    ];

    for (const selector of selectors) {
      const match = wrapper.querySelector(selector);
      if (match) {
        return match;
      }
    }

    const pagination = wrapper.querySelector("ul.ant-pagination");
    if (!pagination) {
      return null;
    }

    return Array.from(pagination.querySelectorAll("li")).find((item) => {
      const title = item.getAttribute("title") || "";
      const className = item.className || "";
      return title === "Next Page" || className.includes("ant-pagination-next");
    }) || null;
  }

  let nextButton = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    nextButton = findNextButton();
    if (nextButton) {
      break;
    }

    window.scrollTo({ top: document.body.scrollHeight, behavior: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  if (!nextButton) {
    return {
      clicked: false,
      error: "未找到下一页按钮",
      diagnostics: collectDiagnostics()
    };
  }

  if (nextButton.getAttribute("aria-disabled") === "true") {
    return {
      clicked: false,
      error: "已经是最后一页",
      diagnostics: collectDiagnostics()
    };
  }

  const target = nextButton.querySelector("button") || nextButton;
  nextButton.scrollIntoView({ block: "center", behavior: "smooth" });
  await new Promise((resolve) => setTimeout(resolve, 250));

  const eventNames = ["pointerover", "mouseover", "pointerdown", "mousedown", "pointerup", "mouseup", "click"];
  for (const eventName of eventNames) {
    target.dispatchEvent(new MouseEvent(eventName, {
      view: window,
      bubbles: true,
      cancelable: true
    }));
  }

  if (typeof target.click === "function") {
    target.click();
  }

  return { clicked: true, diagnostics: collectDiagnostics() };
}

function didBacklinksPageAdvance(previousPage, previousFirstHref) {
  const wrappers = Array.from(document.querySelectorAll(".ant-table-wrapper"));
  const wrapper = wrappers.find((candidate) => {
    const text = (candidate.textContent || "").replace(/\s+/g, " ").trim();
    return text.includes("引用页面标题和网址") && candidate.querySelector("tbody tr a.ad-target-url");
  }) || null;
  if (!wrapper) {
    return false;
  }

  const anchors = Array.from(wrapper.querySelectorAll("tbody tr a.ad-target-url"));
  const urls = anchors
    .map((anchor) => anchor.href)
    .filter(Boolean);

  const pagerInput = wrapper.querySelector("li.ant-pagination-simple-pager input");
  const pagerText = wrapper.querySelector("li.ant-pagination-simple-pager")?.textContent || "";
  const totalPagesMatch = pagerText.match(/\/\s*(\d+)/);
  const nextButton = wrapper.querySelector("li.ant-pagination-next");
  const currentPage = pagerInput ? Number(pagerInput.value) : null;
  const totalPages = totalPagesMatch ? Number(totalPagesMatch[1]) : null;

  if (!urls.length || !currentPage || !totalPages) {
    return false;
  }

  const snapshot = {
    urls,
    rawUrlCount: urls.length,
    firstHref: urls[0] || null,
    currentPage,
    totalPages,
    hasNext: nextButton ? nextButton.getAttribute("aria-disabled") !== "true" : false
  };

  if (!snapshot) {
    return false;
  }

  if (snapshot.currentPage > previousPage) {
    return snapshot;
  }

  if (snapshot.currentPage === previousPage + 1) {
    return snapshot;
  }

  if (snapshot.firstHref && previousFirstHref && snapshot.firstHref !== previousFirstHref) {
    return snapshot;
  }

  return false;
}

function isTrafficShellReady() {
  const bodyText = document.body?.innerText || "";
  if (!bodyText.includes("网站分析")) {
    return false;
  }
  return true;
}

function navigateToTrafficPage(hostname) {
  const hash = `#/digitalsuite/websiteanalysis/overview/website-performance/*/999/15m?webSource=Total&key=${encodeURIComponent(hostname)}`;
  location.hash = hash;
  return location.href;
}

function readMonthlyVisitsIfReady(expectedHostname) {
  const bodyText = document.body?.innerText || "";
  if (!bodyText.includes("每月访问量")) {
    return false;
  }

  if (expectedHostname && !bodyText.includes(expectedHostname)) {
    return false;
  }

  const selectors = [
    "div[class*='MetricContainer']",
    "div[class*='MetricsColumn']",
    "div[class*='WidgetContent']"
  ];

  const visited = new Set();
  for (const selector of selectors) {
    const candidates = Array.from(document.querySelectorAll(selector));
    for (const candidate of candidates) {
      if (visited.has(candidate)) {
        continue;
      }
      visited.add(candidate);

      const text = normalizeInlineText(candidate.textContent || "");
      if (!text.includes("每月访问量")) {
        continue;
      }

      const valueNode = candidate.querySelector("[class*='MetricValue']");
      const valueText = valueNode ? normalizeInlineText(valueNode.textContent || "") : "";
      const monthlyVisits = parseCompactNumber(valueText) || parseVisitsFromText(text);
      if (monthlyVisits !== null) {
        return { monthlyVisits };
      }
    }
  }

  const bodyVisits = parseVisitsFromText(bodyText);
  if (bodyVisits !== null) {
    return { monthlyVisits: bodyVisits };
  }

  return false;

  function normalizeInlineText(value) {
    return value.replace(/\s+/g, " ").trim();
  }

  function parseVisitsFromText(value) {
    const normalized = normalizeInlineText(value);
    const match = normalized.match(/每月访问量\s*([\d,.]+(?:\s*[KMB])?)/i);
    if (!match) {
      return null;
    }
    return parseCompactNumber(match[1]);
  }

  function parseCompactNumber(value) {
    const normalized = normalizeInlineText(value).replace(/,/g, "");
    const match = normalized.match(/^(\d+(?:\.\d+)?)([KMB])?$/i);
    if (!match) {
      return null;
    }
    const number = Number(match[1]);
    const suffix = (match[2] || "").toUpperCase();
    if (suffix === "K") {
      return Math.round(number * 1e3);
    }
    if (suffix === "M") {
      return Math.round(number * 1e6);
    }
    if (suffix === "B") {
      return Math.round(number * 1e9);
    }
    return Math.round(number);
  }
}
