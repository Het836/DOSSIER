# Backend - FastAPI Multi-Agent Research System

This is a FastAPI backend that implements the multi-agent research pipeline.

## Features

- `/api/search` - Tavily web search (returns array of result objects: title, url, content, score, id)
- `/api/extract` - Tavily URL extraction (returns Tavily extract response with results array)
- `/api/chat` - Proxy for Groq chat completion
- `/api/research` - Runs the full multi-agent research pipeline
- `/health` - Health check endpoint

## Installation

1. Install dependencies:
   ```bash
   pip install -r requirements.txt
   ```

2. Set up environment variables in a `.env` file:
   ```
   TAVILY_API_KEY=your_tavily_api_key_here
   GROQ_API_KEY=your_groq_api_key_here
   ```

## Usage

Run the server:
```bash
python main.py
```

The API will be available at `http://localhost:8000`

## API Endpoints

### Search
```http
POST /api/search
Content-Type: application/json

{
  "query": "your search query"
}
```

### Extract
```http
POST /api/extract
Content-Type: application/json

{
  "url": "https://example.com/article"
}
```

### Chat
```http
POST /api/chat
Content-Type: application/json

{
  "messages": [
    {"role": "system", "content": "You are a helpful assistant"},
    {"role": "user", "content": "Hello!"}
  ]
}
```

### Research Pipeline
```http
POST /api/research
Content-Type: application/json

{
  "topic": "your research topic"
}
```

Returns:
```json
{
  "search_results": "...",
  "scraped_content": "...",
  "report": "...",
  "feedback": "..."
}
```