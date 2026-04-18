const EXPORT_STATE_KEY = "exportState";
const EXPORT_LOG_KEY = "exportLog";
const SIM_ORIGIN = "https://sim.3ue.com";
const SIM_HOME_URL = `${SIM_ORIGIN}/`;
const PAGE_POLL_INTERVAL_MS = 1000;
const PAGE_POLL_TIMEOUT_MS = 30000;
const TRAFFIC_POLL_TIMEOUT_MS = 45000;
const MAX_LOG_ENTRIES = 120;

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
  const stored = await chrome.storage.local.get([EXPORT_STATE_KEY, EXPORT_LOG_KEY]);
  if (stored[EXPORT_STATE_KEY]) {
    exportState = stored[EXPORT_STATE_KEY];
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
    await resetLogs();
    const sourceTab = await getTabOrThrow(sourceTabId);
    if (!isBacklinksPage(sourceTab.url)) {
      throw new Error("当前标签页不是 sim.3ue.com 反向链接列表页");
    }

    await appendLog("info", "开始导出任务", {
      sourceTabId,
      url: sourceTab.url
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
      message: "正在创建后台工作页"
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

    await setExportState({
      phase: "reading_traffic",
      trafficDone: 0,
      trafficTotal: backlinkMap.size,
      message: "正在读取每个域名的月访问量"
    });

    const trafficTab = await createBackgroundTab(SIM_HOME_URL, sourceTabId);
    trafficTabId = trafficTab.id;
    await appendLog("info", "已创建流量后台页", { trafficTabId });

    await waitForTabStatusComplete(trafficTabId, PAGE_POLL_TIMEOUT_MS);
    await waitForTrafficShell(trafficTabId);
    await appendLog("info", "流量后台页已就绪");

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

    await appendLog("info", "CSV 下载已触发", {
      exportedCount: exportedRecords.length,
      filename
    });

    await setExportState({
      isRunning: false,
      phase: "done",
      message: `导出完成，共 ${exportedRecords.length} 条记录`
    }, "EXPORT_DONE");
  } catch (error) {
    await appendLog("error", "导出失败", {
      error: error?.message || "未知错误"
    });
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

  await appendLog("info", "开始读取流量", {
    trafficTotal: records.length
  });

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

      if ((index + 1) % 50 === 0) {
        await appendLog("info", "流量读取进度", {
          trafficDone: index + 1,
          trafficTotal: records.length,
          exportedCount: exported.length,
          skippedCount
        });
      }
    } catch (error) {
      skippedCount += 1;
      await appendLog("warn", "跳过域名", {
        hostname: record.hostname,
        reason: error?.message || "流量读取失败"
      });
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
