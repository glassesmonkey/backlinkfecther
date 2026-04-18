const EXPORT_STATE_KEY = "exportState";
const SIM_ORIGIN = "https://sim.3ue.com";
const SIM_HOME_URL = `${SIM_ORIGIN}/`;
const PAGE_POLL_INTERVAL_MS = 1000;
const PAGE_POLL_TIMEOUT_MS = 30000;
const TRAFFIC_POLL_TIMEOUT_MS = 45000;

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
  message: "空闲"
};

let activeRun = null;

initializeState().catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "START_EXPORT") {
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

  activeRun = runExport(tabId)
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
  const stored = await chrome.storage.local.get(EXPORT_STATE_KEY);
  if (stored[EXPORT_STATE_KEY]) {
    exportState = stored[EXPORT_STATE_KEY];
  } else {
    await chrome.storage.local.set({ [EXPORT_STATE_KEY]: exportState });
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

async function runExport(sourceTabId) {
  let backlinksTabId = null;
  let trafficTabId = null;

  try {
    const sourceTab = await getTabOrThrow(sourceTabId);
    if (!isBacklinksPage(sourceTab.url)) {
      throw new Error("当前标签页不是 sim.3ue.com 反向链接列表页");
    }

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
      message: "正在创建后台工作页"
    });

    const backlinksTab = await createBackgroundTab(sourceTab.url, sourceTabId);
    backlinksTabId = backlinksTab.id;

    await waitForTabStatusComplete(backlinksTabId, PAGE_POLL_TIMEOUT_MS);
    const backlinkMap = await collectBacklinks(backlinksTabId);

    await setExportState({
      phase: "reading_traffic",
      trafficDone: 0,
      trafficTotal: backlinkMap.size,
      message: "正在读取每个域名的月访问量"
    });

    const trafficTab = await createBackgroundTab(SIM_HOME_URL, sourceTabId);
    trafficTabId = trafficTab.id;

    await waitForTabStatusComplete(trafficTabId, PAGE_POLL_TIMEOUT_MS);
    await waitForTrafficShell(trafficTabId);

    const exportedRecords = await collectTrafficRecords(trafficTabId, backlinkMap);

    await setExportState({
      phase: "exporting",
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

    await setExportState({
      isRunning: false,
      phase: "done",
      message: `导出完成，共 ${exportedRecords.length} 条记录`
    }, "EXPORT_DONE");
  } catch (error) {
    await setExportState({
      isRunning: false,
      phase: "error",
      message: error?.message || "导出失败"
    }, "EXPORT_ERROR");
  } finally {
    await closeTab(backlinksTabId);
    await closeTab(trafficTabId);
  }
}

async function collectBacklinks(tabId) {
  const backlinkMap = new Map();
  let previousFirstHref = null;
  let pageGuard = 0;
  let rawUrlCount = 0;

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

    if (!snapshot.hasNext) {
      break;
    }

    const waitMs = randomDelayMs(3000, 6000);
    await setExportState({
      message: `等待 ${Math.round(waitMs / 1000)} 秒后翻到下一页`
    });
    await sleep(waitMs);

    const clickResult = await executeInTab(tabId, clickNextPageButton, []);
    if (!clickResult?.clicked) {
      throw new Error(clickResult?.error || "翻页失败");
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

async function waitForTrafficShell(tabId) {
  await waitForCondition(
    tabId,
    isTrafficShellReady,
    [],
    { timeoutMs: PAGE_POLL_TIMEOUT_MS }
  );
}

async function collectTrafficRecords(tabId, backlinkMap) {
  const exported = [];
  const records = Array.from(backlinkMap.values());
  let skippedCount = 0;

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];

    await setExportState({
      phase: "reading_traffic",
      trafficDone: index,
      trafficTotal: records.length,
      skippedCount,
      message: `正在读取 ${record.hostname} 的月访问量`
    });

    try {
      await executeInTab(tabId, navigateToTrafficPage, [record.hostname]);
      const traffic = await waitForCondition(
        tabId,
        readMonthlyVisitsIfReady,
        [record.hostname],
        { timeoutMs: TRAFFIC_POLL_TIMEOUT_MS }
      );

      if (traffic.monthlyVisits > 100) {
        exported.push({
          hostname: record.hostname,
          sourceUrl: record.sourceUrl,
          monthlyVisits: traffic.monthlyVisits
        });
      }
    } catch (error) {
      skippedCount += 1;
      await setExportState({
        skippedCount,
        message: `跳过 ${record.hostname}，原因：${error?.message || "流量读取失败"}`
      });
    }

    await setExportState({
      trafficDone: index + 1,
      trafficTotal: records.length,
      skippedCount
    });
  }

  await setExportState({
    trafficDone: records.length,
    trafficTotal: records.length,
    skippedCount
  });

  return exported;
}

function getBacklinksPageSnapshot() {
  const anchors = Array.from(document.querySelectorAll("a.ad-target-url"));
  const urls = anchors
    .map((anchor) => anchor.href)
    .filter(Boolean);

  const pagerInput = document.querySelector("li.ant-pagination-simple-pager input");
  const pagerText = document.querySelector("li.ant-pagination-simple-pager")?.textContent || "";
  const totalPagesMatch = pagerText.match(/\/\s*(\d+)/);
  const nextButton = document.querySelector("li.ant-pagination-next");
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

function clickNextPageButton() {
  const nextButton = document.querySelector("li.ant-pagination-next");
  if (!nextButton) {
    return { clicked: false, error: "未找到下一页按钮" };
  }

  if (nextButton.getAttribute("aria-disabled") === "true") {
    return { clicked: false, error: "已经是最后一页" };
  }

  const target = nextButton.querySelector("button") || nextButton;
  nextButton.scrollIntoView({ block: "center", behavior: "smooth" });

  const eventNames = ["mouseover", "mousedown", "mouseup", "click"];
  for (const eventName of eventNames) {
    target.dispatchEvent(new MouseEvent(eventName, {
      view: window,
      bubbles: true,
      cancelable: true
    }));
  }

  return { clicked: true };
}

function didBacklinksPageAdvance(previousPage, previousFirstHref) {
  const snapshot = getBacklinksPageSnapshot();
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
