const EXPORT_STATE_KEY = "exportState";
const EXPORT_LOG_KEY = "exportLog";

const elements = {
  pageMatch: document.getElementById("page-match"),
  startButton: document.getElementById("start-button"),
  phaseText: document.getElementById("phase-text"),
  pageProgress: document.getElementById("page-progress"),
  hostProgress: document.getElementById("host-progress"),
  trafficProgress: document.getElementById("traffic-progress"),
  activeProvider: document.getElementById("active-provider"),
  providerCooldowns: document.getElementById("provider-cooldowns"),
  skippedCount: document.getElementById("skipped-count"),
  messageText: document.getElementById("message-text"),
  logOutput: document.getElementById("log-output")
};

let activeTabId = null;
let pageMatched = false;
let currentState = null;
let currentLogs = [];

function isBacklinksPage(urlString) {
  if (!urlString) {
    return false;
  }

  try {
    const url = new URL(urlString);
    return url.origin === "https://sim.3ue.com" && url.hash.includes("/digitalsuite/acquisition/backlinks/table/");
  } catch (error) {
    return false;
  }
}

function formatPhase(phase, isRunning) {
  if (!phase) {
    return isRunning ? "执行中" : "空闲";
  }

  const labels = {
    collecting_links: "采集反链",
    reading_traffic: "读取流量",
    exporting: "导出 CSV",
    done: "已完成",
    error: "失败"
  };
  return labels[phase] || phase;
}

function setMessage(text, className = "") {
  elements.messageText.textContent = text;
  elements.messageText.className = `hint ${className}`.trim();
}

function formatProviderLabel(providerId) {
  const labels = {
    similarweb_direct: "SW API",
    webspy: "WebSpy"
  };
  return labels[providerId] || providerId || "-";
}

function formatRemainingSeconds(timestamp) {
  if (!timestamp) {
    return "-";
  }

  const remainingMs = new Date(timestamp).getTime() - Date.now();
  if (Number.isNaN(remainingMs) || remainingMs <= 0) {
    return "-";
  }

  return `${Math.ceil(remainingMs / 1000)}s`;
}

function formatProviderCooldowns(providerStatus) {
  const similarweb = providerStatus?.similarweb_direct;
  const webspy = providerStatus?.webspy;

  if (!similarweb && !webspy) {
    return "-";
  }

  const parts = [
    `SW API ${formatRemainingSeconds(similarweb?.nextReadyAt)}`,
    `WebSpy ${formatRemainingSeconds(webspy?.nextReadyAt)}`
  ];
  return parts.join(" | ");
}

function render() {
  const isRunning = Boolean(currentState?.isRunning);
  const canStart = pageMatched && !isRunning;

  elements.pageMatch.textContent = pageMatched ? "已匹配" : "未匹配";
  elements.startButton.disabled = !canStart;
  elements.phaseText.textContent = formatPhase(currentState?.phase, isRunning);

  const currentPage = currentState?.currentPage ?? "-";
  const totalPages = currentState?.totalPages ?? "-";
  elements.pageProgress.textContent = `${currentPage} / ${totalPages}`;

  const rawUrlCount = currentState?.rawUrlCount ?? 0;
  const uniqueHostCount = currentState?.uniqueHostCount ?? 0;
  elements.hostProgress.textContent = `${rawUrlCount} 去重后 ${uniqueHostCount}`;

  const trafficDone = currentState?.trafficDone ?? 0;
  const trafficTotal = currentState?.trafficTotal ?? 0;
  elements.trafficProgress.textContent = `${trafficDone} / ${trafficTotal}`;
  elements.activeProvider.textContent = formatProviderLabel(currentState?.activeTrafficProvider);
  elements.providerCooldowns.textContent = formatProviderCooldowns(currentState?.providerStatus);
  elements.skippedCount.textContent = `${currentState?.skippedCount ?? 0}`;

  if (!pageMatched) {
    setMessage("只支持 sim.3ue.com 反向链接列表页。");
    return;
  }

  if (currentState?.phase === "error") {
    setMessage(currentState.message || "导出失败。", "error");
    return;
  }

  if (currentState?.phase === "done") {
    setMessage(currentState.message || "导出完成。", "success");
    return;
  }

  if (isRunning) {
    setMessage(currentState?.message || "导出进行中，请保持浏览器开启。");
    return;
  }

  setMessage("准备就绪。点击开始导出。");
}

function formatLogLine(entry) {
  const time = entry?.timestamp
    ? new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false })
    : "--:--:--";
  const level = (entry?.level || "info").toUpperCase();
  const message = entry?.message || "";
  const details = entry?.details ? ` ${JSON.stringify(entry.details, null, 0)}` : "";
  return `[${time}] ${level} ${message}${details}`;
}

function renderLogs() {
  const lines = currentLogs.slice(-12).map(formatLogLine);
  elements.logOutput.textContent = lines.length ? lines.join("\n") : "暂无日志";
}

async function loadActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  pageMatched = isBacklinksPage(tab?.url);
  render();
}

async function loadState() {
  const data = await chrome.storage.local.get(EXPORT_STATE_KEY);
  currentState = data[EXPORT_STATE_KEY] || null;
  render();
}

async function loadLogs() {
  const data = await chrome.storage.local.get(EXPORT_LOG_KEY);
  currentLogs = Array.isArray(data[EXPORT_LOG_KEY]) ? data[EXPORT_LOG_KEY] : [];
  renderLogs();
}

async function handleStart() {
  if (!pageMatched || !activeTabId) {
    return;
  }

  elements.startButton.disabled = true;
  setMessage("正在启动导出...");

  try {
    const response = await chrome.runtime.sendMessage({
      type: "START_EXPORT",
      tabId: activeTabId
    });

    if (!response?.ok) {
      throw new Error(response?.error || "启动失败");
    }
  } catch (error) {
    setMessage(error.message || "启动失败。", "error");
    elements.startButton.disabled = false;
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes[EXPORT_STATE_KEY]) {
    currentState = changes[EXPORT_STATE_KEY].newValue || null;
    render();
  }

  if (changes[EXPORT_LOG_KEY]) {
    currentLogs = Array.isArray(changes[EXPORT_LOG_KEY].newValue) ? changes[EXPORT_LOG_KEY].newValue : [];
    renderLogs();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!message || !["EXPORT_PROGRESS", "EXPORT_DONE", "EXPORT_ERROR"].includes(message.type)) {
    return;
  }

  currentState = message.payload || currentState;
  render();
});

elements.startButton.addEventListener("click", handleStart);

Promise.all([loadActiveTab(), loadState()]).catch((error) => {
  setMessage(error.message || "初始化失败。", "error");
});

loadLogs().catch(() => {
  currentLogs = [];
  renderLogs();
});

setInterval(() => {
  render();
}, 1000);
