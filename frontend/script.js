/* =======================================================================
   DOSSIER — front end for the /api/search, /api/extract, /api/chat proxy
   =======================================================================

   Your Tavily and Groq API keys live only in app.py's .env — this file
   never sees them. It just calls your own server, which forwards to
   Tavily/Groq and hands the result back.
   ======================================================================= */

// The API lives on the backend server (Flask app.py on :5000, or FastAPI
// backend/main.py on :8000), not necessarily on the same origin as the page.
// When the page is served by a static server (VS Code Live Server, etc.) the
// relative URLs below 405, so we probe the page origin first and fall back.
const API_CANDIDATES = [
  window.location.origin,                 // same origin as the page
  "http://127.0.0.1:5000",                // Flask app.py
  "http://127.0.0.1:8000",                // FastAPI backend/main.py
];

let CONFIG = {
  SEARCH_URL: null,
  EXTRACT_URL: null,
  CHAT_URL: null,
};

// Probe each candidate once; the first one that answers POST /api/search wins.
async function resolveConfig() {
  for (const base of API_CANDIDATES) {
    try {
      const res = await fetch(`${base}/api/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "probe" }),
      });
      if (res.ok) {
        CONFIG = {
          SEARCH_URL: `${base}/api/search`,
          EXTRACT_URL: `${base}/api/extract`,
          CHAT_URL: `${base}/api/chat`,
        };
        console.log(`[DEBUG] API resolved to ${base}`);
        return;
      }
      console.log(`[DEBUG] ${base} -> HTTP ${res.status}, trying next`);
    } catch (e) {
      console.log(`[DEBUG] ${base} unreachable: ${e.message}`);
    }
  }
  console.error("[DEBUG] No API endpoint could be reached.");
}

console.log(`[DEBUG] window.location:`, window.location.href);

function sanitizeText(str) {
  if (!str) return '';
  // Remove annotation characters: *, #, -, |, and collapse whitespace
  return str
    .replace(/[*#\-|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const STEP_ORDER = ["search", "reader", "writer", "critic"];
const STEP_LABEL = {
  search: "Search analyst",
  reader: "Field reader",
  writer: "Case writer",
  critic: "Review board",
};

/* -------------------------------------------------------------------
   DOM refs
   ------------------------------------------------------------------- */
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


/* -------------------------------------------------------------------
   Title typewriter — a single page-load moment, not a recurring effect
   ------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------
   Minimal, dependency-free markdown → HTML
   ------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------
   Pipeline node state
   ------------------------------------------------------------------- */
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

/* -------------------------------------------------------------------
   Proxy calls — no keys here, app.py holds those
   ------------------------------------------------------------------- */

// Read the response body safely. A non-2xx or empty body (server starting up,
// Tavily rate-limit, timeout) must not reach res.json(), which throws
// "Unexpected end of JSON input" on an empty response.
async function parseResponse(res, label) {
  if (!res.ok) {
    let detail = "";
    try {
      const text = await res.text();
      if (text) {
        try { detail = (JSON.parse(text).error || text).slice(0, 200); }
        catch { detail = text.slice(0, 200); }
      }
    } catch { /* body unreadable — that's fine */ }
    // 405 = the browser is talking to a server that doesn't expose this
    // endpoint (wrong port / static file server). Retrying won't help.
    if (res.status === 405) {
      throw new Error(
        `${label} returned HTTP 405 — the server at ${res.url} doesn't ` +
        `expose this endpoint. Start app.py (:5000) or backend/main.py (:8000).`
      );
    }
    throw new Error(detail || `${label} failed (HTTP ${res.status})`);
  }
  const text = await res.text();
  if (!text) throw new Error(`${label} returned an empty response.`);
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned a non-JSON response.`); }
}

async function apiSearch(query) {
  const url = new URL(CONFIG.SEARCH_URL, window.location.href);
  console.log(`[DEBUG] apiSearch: Fetching from ${url}`);
  // The first stage is the one that stalls (server boot / Tavily rate-limit),
  // so give it one retry before reporting failure.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
      });
      console.log(`[DEBUG] apiSearch: Response status ${res.status}`);
      return await parseResponse(res, "Search");
    } catch (err) {
      lastErr = err;
      // A 405 is a config problem (wrong server/port), not a transient one.
      if (err?.message?.includes("HTTP 405")) break;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw lastErr;
}

async function apiExtract(url) {
  const res = await fetch(CONFIG.EXTRACT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url }),
  });
  return parseResponse(res, "Extract");
}

async function apiChat(messages) {
  const res = await fetch(CONFIG.CHAT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
  });
  const data = await parseResponse(res, "Chat");
  // FastAPI returns { response: "..." }, Flask proxy returns { choices: [{ message: { content: "..." } }] }
  if (data.response !== undefined) {
    return data.response;
  }
  return data?.choices?.[0]?.message?.content ?? "";
}

/* -------------------------------------------------------------------
   Rendering results
   ------------------------------------------------------------------- */
function renderResults(data) {
  console.log('[DEBUG] renderResults data:', data);
  const cleanSearch = sanitizeText(data.search_results || "");
  const cleanScraped = sanitizeText(data.scraped_content || "");
  const cleanReport = sanitizeText(data.report || "");
  const cleanFeedback = sanitizeText(data.feedback || "");
  document.getElementById("exhibitSearchBody").textContent = cleanSearch || "—";
  document.getElementById("exhibitReaderBody").textContent = cleanScraped || "—";
  document.getElementById("exhibitReportBody").innerHTML = renderMarkdown(cleanReport);
  document.getElementById("exhibitFeedbackBody").innerHTML = renderMarkdown(cleanFeedback);
  lastReport = cleanReport;
  resultsEl.hidden = false;
}

/* -------------------------------------------------------------------
   Main run flow — each step is a real, awaited call
   ------------------------------------------------------------------- */
function friendlyError(err) {
  const msg = err?.message || String(err);
  if (/Failed to fetch|NetworkError/i.test(msg)) {
    return msg + " — check that app.py is running and reachable.";
  }
  return msg;
}

async function runCase(topic) {
  if (running) return;

  await resolveConfig();
  if (!CONFIG.SEARCH_URL) {
    setStatus("No API server reachable. Start app.py (:5000) or backend/main.py (:8000).", "error");
    return;
  }

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

/* -------------------------------------------------------------------
   Wiring
   ------------------------------------------------------------------- */
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
  const sanitized = sanitizeText(lastReport);
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
    const sanitized = sanitizeText(lastReport);
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

/* -------------------------------------------------------------------
   Suggestion chips
   ------------------------------------------------------------------- */
const SUGGESTIONS = [
  { topic: "Large language model agents in 2025", label: "LLM agents, 2025" },
  { topic: "CRISPR gene editing recent advances", label: "CRISPR gene editing" },
  { topic: "Progress toward commercial fusion energy", label: "Fusion energy progress" },
  { topic: "Quantum computing breakthroughs 2024", label: "Quantum computing 2024" },
  { topic: "Renewable energy storage solutions", label: "Renewable energy storage" },
  { topic: "Artificial intelligence ethics guidelines", label: "AI ethics guidelines" },
  { topic: "Space missions to Mars 2025", label: "Mars missions 2025" },
  { topic: "Global supply chain resilience", label: "Supply chain resilience" },
  { topic: "Mental health technology innovations", label: "Mental health tech" },
  { topic: "Advanced robotics in manufacturing", label: "Advanced robotics" },
  { topic: "Climate change adaptation strategies", label: "Climate adaptation" },
  { topic: "Quantum error correction", label: "Quantum error correction" },
  { topic: "Neural interface devices", label: "Neural interfaces" },
  { topic: "Synthetic biology applications", label: "Synthetic biology" },
  { topic: "Dark matter research updates", label: "Dark matter research" }
];

function getRandomSuggestions(array, n) {
  const shuffled = array.slice(); // copy
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, n);
}

function createChip({ topic, label }) {
  const chip = document.createElement('button');
  chip.className = 'chip';
  chip.type = 'button';
  chip.dataset.topic = topic;
  chip.textContent = label;
  return chip;
}

function populateSuggestions() {
  const container = document.querySelector('.precedents');
  if (!container) return;
  // Keep the label, clear chips
  container.innerHTML = '<span class="precedents-label">prior cases</span>';
  const selected = getRandomSuggestions(SUGGESTIONS, 3);
  selected.forEach(item => {
    const chip = createChip(item);
    container.appendChild(chip);
  });
  attachChipListeners();
}

function attachChipListeners() {
  document.querySelectorAll('.chip').forEach(chip => {
    chip.addEventListener('click', () => {
      topicInput.value = chip.dataset.topic;
      topicInput.focus();
    });
  });
}

// Initialize
populateSuggestions();
typeTitle();