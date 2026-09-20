# Frontend - Dossier Research Interface

This folder contains the frontend interface for the multi-agent research system.

## Files

- `index.html` - Main HTML structure
- `style.css` - Styling for the interface
- `script.js` - Frontend logic and API interactions

## Features

- Topic input field with suggested examples
- Visual pipeline showing progress through search, reader, writer, and critic stages
- Results展区 showing search brief, scraped source, final report, and critic feedback
- Error handling and retry functionality
- Markdown rendering for reports and feedback
- Download report as markdown file

## API Configuration

The frontend is configured to communicate with a backend API at:
- `/api/search` - For web search
- `/api/extract` - For URL extraction
- `/api/chat` - For AI chat/completion
- `/api/research` - For running the full research pipeline

If your backend is running on a different port or host, update the `CONFIG` object in `script.js`:

```javascript
const CONFIG = {
  SEARCH_URL: "http://your-backend-host:port/api/search",
  EXTRACT_URL: "http://your-backend-host:port/api/extract",
  CHAT_URL: "http://your-backend-host:port/api/chat",
};
```

## Usage

1. Ensure your backend is running (see backend/README.md)
2. Open `index.html` in a web browser
3. Enter a research topic and click "Open case"
4. Watch the pipeline progress and view results