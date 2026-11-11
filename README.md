# Dossier

**Dossier** is a web-based, multi-agent research desk. Enter a topic and it gathers web sources, extracts a source for more detail, drafts a report, and asks a reviewer model to critique the result. The interface displays each stage and lets you download the report.

## Live demo

[Open Dossier](https://dossier-k4fa.onrender.com/)

The deployed service also exposes its health check at [`/health`](https://dossier-k4fa.onrender.com/health) and interactive API documentation at [`/docs`](https://dossier-k4fa.onrender.com/docs).

## How it works

The frontend calls the backend in four stages:

1. **Search:** Tavily returns up to five web results for the topic.
2. **Read:** Tavily extracts the text from the leading result.
3. **Write:** Groq generates a report from the search results and extracted text.
4. **Review:** Groq critiques the report and suggests improvements.

The backend also provides `POST /api/research`, which runs a separate LangChain agent workflow using the search and scraping tools in `tools.py`, followed by the report writer and critic in `agents.py`.

## Technology and external APIs

- **Backend:** Python, FastAPI, Uvicorn, LangChain
- **Frontend:** HTML, CSS, and vanilla JavaScript
- **Web search and extraction:** [Tavily](https://tavily.com/) Search and Extract APIs
- **Text generation and review:** [Groq](https://console.groq.com/) API via `langchain-groq`; the current code selects `openai/gpt-oss-120b`
- **Browser assets:** Google Fonts and jsPDF are loaded from external CDNs

The backend needs `TAVILY_API_KEY` and `GROQ_API_KEY`. Keep these keys on the server; do not put them in frontend code or commit your `.env` file.

## Run locally

Use Python 3.10 or later. From the project root, create a virtual environment and install the backend dependencies:

```powershell
py -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -r backend\requirements.txt
Copy-Item .env.example .env
```

Edit `.env` and set your keys:

```dotenv
TAVILY_API_KEY=your_tavily_api_key
GROQ_API_KEY=your_groq_api_key
```

Start the server **from the `backend` directory** so its relative frontend paths resolve correctly:

```powershell
Set-Location backend
python main.py
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). API documentation is available at [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

On macOS or Linux, the equivalent setup is:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r backend/requirements.txt
cp .env.example .env
# Add TAVILY_API_KEY and GROQ_API_KEY to .env
cd backend
python main.py
```

## API endpoints

All endpoints are served by the same backend origin. JSON endpoints accept and return JSON.

| Method and path | Purpose | Request body |
|---|---|---|
| `GET /health` | Check whether the backend is responding. | None |
| `POST /api/search` | Search the web with Tavily (up to five results). | `{"query":"research topic"}` |
| `POST /api/extract` | Extract a web page with Tavily. | `{"url":"https://example.com/article"}` |
| `POST /api/chat` | Generate text with Groq. | `{"messages":[{"role":"user","content":"Write a summary"}]}` |
| `POST /api/research` | Run the complete agent-based research pipeline. | `{"topic":"research topic"}` |

`/api/search` returns a `results` array containing Tavily result data. `/api/extract` returns Tavily's extraction response, including extracted `raw_content` when available. `/api/chat` returns `{"response":"..."}`. `/api/research` returns `search_results`, `scraped_content`, `report`, and `feedback`.

The UI uses `/api/search`, `/api/extract`, and `/api/chat` for its staged progress display. The complete `/api/research` endpoint is available for direct API clients.

## Project structure

```text
.
├── agents.py                  # Search/reader agents, report writer, and critic
├── pipeline.py                # Command-line research pipeline
├── tools.py                   # Tavily search and web-page scraping tools
├── requirements.txt           # Broader project/Python dependencies
├── .env.example               # Environment variable template
├── backend/
│   ├── main.py                # FastAPI app, API routes, and frontend serving
│   ├── requirements.txt       # Backend runtime dependencies
│   ├── README.md              # Backend-specific notes
│   └── test_resp.json         # Example/test response data
└── frontend/
    ├── index.html             # Research desk interface
    ├── style.css              # Interface styles
    ├── script.js              # UI behavior and backend requests
    └── README.md              # Frontend-specific notes
```

## Notes

- Search, extraction, and model generation require valid API keys and may be subject to provider quotas or rate limits.
- The frontend requires an internet connection to load its Google Fonts and jsPDF CDN assets.
- Research reports are AI-generated summaries of retrieved material. Check the cited sources before relying on claims.
