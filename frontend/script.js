/* =======================================================================
   DOSSIER — front end for the /api/search, /api/extract, /api/chat proxy
   =======================================================================

   Your Tavily and Groq API keys live only in app.py's .env — this file
   never sees them. It just calls your own server, which forwards to
   Tavily/Groq and hands the result back.
   ======================================================================= */

const CONFIG = {
  SEARCH_URL: "/api/search",
  EXTRACT_URL: "/api/extract",
  CHAT_URL: "/api/chat",
};

console.log(`[DEBUG] CONFIG:`, CONFIG);
console.log(`[DEBUG] window.location:`, window.location.href);

const STEP_ORDER = ["search", "reader", "writer", "critic"];
const STEP_LABEL = {
  search: "Search analyst",
  reader: "Field reader",
  writer: "Case writer",
  critic: "Review board",
};

// DOM refs
const topicInput   = document.getElementById("topicInput");
const runBtn       = document.getElementById("runBtn");
const statusLine   = document.getElementById("statusLine");
const timeline     = document.getElementById("timeline");
const resultsEl    = document.getElementById("results");
const errorPanel   = document.getElementById("errorPanel");
const errorMessage = document.getElementById("errorMessage");
const retryBtn     = document.getElementById("retryBtn");
const downloadBtn  = document.getElementById("downloadBtn");

const nodes = {};
STEP_ORDER.forEach((key) => {
  nodes[key] = timeline.querySelector(`.node[data-step="${key}"]`);
});

let currentTopic = "";
let lastReport = "";
let running = false;


// Title typewriter — a single page-load moment, not a recurring effect
function typeTitle() {
  const target = document.getElementById("typeTarget");
  const word = "DOSSIER";
  const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) {
    target.textContent = word;
    return;
  }
  let i = 0;
  const tick = () => {
    target.textContent = word.slice(0, i);
    i++;
    if (i <= word.length) setTimeout(tick, 90);
  };
  tick();
}

// Minimal, dependency-free markdown → HTML
function escapeHtml(str) {
  return str
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");
}

function inlineMd(line) {
  return line
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
}

function renderMarkdown(raw) {
  if (!raw) return "";
  const src = escapeHtml(String(raw)).replace(/\r\n/g, "\n");
  const lines = src.split("\n");
  let html = "";
  let listType = null;
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      html += `<p>${inlineMd(paragraph.join(" "))}</p>`;
      paragraph = [];
    }
  };
  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };

  for (const raw_line of lines) {
    const line = raw_line.trim();
    if (line === "") { flushParagraph(); closeList(); continue; }

    const h = line.match(/^(#{1,3})\s+(.*)$/);
    if (h) {
      flushParagraph(); closeList();
      const level = h[1].length;
      html += `<h${level}>${inlineMd(h[2])}</h${level}>`;
      continue;
    }
    const bq = line.match(/^>\s?(.*)$/);
    if (bq) {
      flushParagraph(); closeList();
      html += `<blockquote>${inlineMd(bq[1])}</blockquote>`;
      continue;
    }
    const ul = line.match(/^[-*]\s+(.*)$/);
    if (ul) {
      flushParagraph();
      if (listType !== "ul") { closeList(); html += "<ul>"; listType = "ul"; }
      html += `<li>${inlineMd(ul[1])}</li>`;
      continue;
    }
    const ol = line.match(/^\d+\.\s+(.*)$/);
    if (ol) {
      flushParagraph();
      if (listType !== "ol") { closeList(); html += "<ol>"; listType = "ol"; }
      html += `<li>${inlineMd(ol[1])}</li>`;
      continue;
    }
    closeList();
    paragraph.push(line);
  }
  flushParagraph();
  closeList();
  return html || `<p>${inlineMd(src)}</p>`;
}

// -------------------------------------------------------------------
//   Pipeline node state
// -------------------------------------------------------------------
function setNodeState(key, state, label) {
  const node = nodes[key];
  if (!node) return;
  node.dataset.state = state;
  const stateText = node.querySelector("[data-state-text]");
  const map = { waiting: "Standing by", running: "Working…", done: "Filed", error: "Stalled" };
  stateText.textContent = label || map[state] || "";
}

function resetTimeline() {
  STEP_ORDER.forEach((key) => setNodeState(key, "waiting"));
}

function markErrorAtStep(step) {
  setNodeState(step, "error");
}

function setStatus(text, tone) {
  statusLine.textContent = text;
  if (tone) statusLine.setAttribute("data-tone", tone);
  else statusLine.removeAttribute("data-tone");
}

// -------------------------------------------------------------------
//   Proxy calls — no keys here, app.py holds those
// -------------------------------------------------------------------
async function apiSearch(query) {
  const url = new URL(CONFIG.SEARCH_URL, window.location.href);
  console.log(`[DEBUG] apiSearch: Fetching from ${url}`);
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  console.log(`[DEBUG] apiSearch: Response status ${res.status}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Search failed (HTTP ${res.status})`);
  return data;
}

async function apiExtract(url) {
  const res = await fetch(CONFIG.EXTRACT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Extract failed (HTTP ${res.status})`);
  return data;
}

async function apiChat(messages) {
  const res = await fetch(CONFIG.CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `Chat failed (HTTP ${res.status})`);
  // FastAPI returns { response: "..." }, Flask proxy returns { choices: [{ message: { content: "..." } }] }
  if (data.response !== undefined) {
    return data.response;
  }
  return data?.choices?.[0]?.message?.content ?? "";
}

// -------------------------------------------------------------------
//   Rendering results
// -------------------------------------------------------------------
function renderResults(data) {
  console.log('[DEBUG] renderResults data:', data);
  document.getElementById("exhibitSearchBody").textContent = data.search_results || "—";
  document.getElementById("exhibitReaderBody").textContent = data.scraped_content || "—";
  document.getElementById("exhibitReportBody").innerHTML = renderMarkdown(data.report);
  document.getElementById("exhibitFeedbackBody").innerHTML = renderMarkdown(data.feedback);
  lastReport = data.report || "";
  resultsEl.hidden = false;
}

// -------------------------------------------------------------------
//   Main run flow — each step is a real, awaited call
// -------------------------------------------------------------------
function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/Failed to fetch|NetworkError/i.test(msg)) {
    return msg + " — check that app.py is running and reachable.";
  }
  return msg;
}

async function runCase(topic) {
  if (running) return;

  running = true;
  currentTopic = topic;
  errorPanel.hidden = true;
  resultsEl.hidden = true;
  resetTimeline();
  runBtn.disabled = true;
  topicInput.disabled = true;
  setStatus(`Case opened: “${topic}”`, "active");

  let step = "search";
  try {
    // ---- 1. Search ----
    setNodeState("search", "running");
    setStatus(`${STEP_LABEL.search} is working…`, "active");
    const searchData = await apiSearch(topic);
    const results = searchData.results || [];
    const searchSummary = results.length
      ? results.map((r) => `• ${r.title}\n  ${r.url}\n  ${r.content}`).join("\n\n")
      : "No search results were returned for this subject.";
    setNodeState("search", "done");

    // ---- 2. Read (Tavily extract, done server-side by app.py) ----
    step = "reader";
    setNodeState("reader", "running");
    setStatus(`${STEP_LABEL.reader} is working…`, "active");
    const topUrl = results[0]?.url;
    let scraped = "No result URL was available to read in depth.";
    if (topUrl) {
      const extractData = await apiExtract(topUrl);
      const extracted = extractData.results?.[0]?.raw_content;
      if (extracted) {
        scraped = extracted;
      } else {
        const failure = extractData.failed_results?.[0];
        scraped = `Could not extract ${topUrl}${failure?.error ? `: ${failure.error}` : "."}`;
      }
    }
    setNodeState("reader", "done");

    // ---- 3. Write ----
    step = "writer";
    setNodeState("writer", "running");
    setStatus(`${STEP_LABEL.writer} is working…`, "active");
    const report = await apiChat([
      {
        role: "system",
        content:
          "You are a research analyst. Write a clear, well-organized markdown report " +
          "(headings, short paragraphs, a bullet list of key points) based only on the " +
          "material you're given. Don't invent facts beyond what's provided.",
      },
      {
        role: "user",
        content:
          `Write a research report on: "${topic}"\n\n` +
          `SEARCH RESULTS:\n${searchSummary}\n\n` +
          `DETAILED SOURCE CONTENT:\n${scraped.slice(0, 8000)}`,
      },
    ]);
    setNodeState("writer", "done");

    // ---- 4. Critique ----
    step = "critic";
    setNodeState("critic", "running");
    setStatus(`${STEP_LABEL.critic} is working…`, "active");
    const feedback = await apiChat([
      {
        role: "system",
        content:
          "You are an exacting editor reviewing a research report. Note what's strong, " +
          "what's missing or under-supported, and one or two concrete improvements. Be brief.",
      },
      { role: "user", content: `Critique this report:\n\n${report}` },
    ]);
    setNodeState("critic", "done");

    renderResults({ search_results: searchSummary, scraped_content: scraped, report, feedback });
    setStatus(`Case filed: “${topic}”.`, "done");
    resultsEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (err) {
    markErrorAtStep(step);
    setStatus("The case stalled.", "error");
    errorMessage.textContent = friendlyError(err);
    errorPanel.hidden = false;
  } finally {
    running = false;
    runBtn.disabled = false;
    topicInput.disabled = false;
  }
}

// -------------------------------------------------------------------
//   Wiring
// -------------------------------------------------------------------
runBtn.addEventListener("click", () => {
  const topic = topicInput.value.trim();
  if (!topic) {
    setStatus("Enter a case subject first.", "error");
    topicInput.focus();
    return;
  }
  runCase(topic);
});

topicInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") runBtn.click();
});

document.querySelectorAll(".chip").forEach((chip) => {
  chip.addEventListener("click", () => {
    topicInput.value = chip.dataset.topic;
    topicInput.focus();
  });
});

retryBtn.addEventListener("click", () => {
  if (currentTopic) runCase(currentTopic);
});

downloadBtn.addEventListener("click", () => {
  console.log('[DEBUG] download clicked, lastReport length:', lastReport?.length);
  if (!lastReport) {
    console.log('[DEBUG] no lastReport');
    return;
  }
  // Offer a plain text download as a reliable alternative to PDF
  const sanitized = lastReport.replace(/[*#]/g, '');
  const blob = new Blob([sanitized], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const filename = `case-report-${Date.now()}.txt`;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
});

const downloadDocBtn = document.getElementById('downloadDocBtn');
if (downloadDocBtn) {
  downloadDocBtn.addEventListener('click', () => {
    if (!lastReport) return;
    const sanitized = lastReport.replace(/[*#]/g, '');
    // Simple .doc file (plain text with .doc extension)
    const blob = new Blob([sanitized], { type: 'application/msword' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const filename = `case-report-${Date.now()}.doc`;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  });
}

typeTitle();