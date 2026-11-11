from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import os
import sys
import requests
import asyncio
from dotenv import load_dotenv
from pydantic import BaseModel
from typing import Optional, Dict, Any

# Add parent directory to path to import agents and tools
parent_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(parent_dir)

# Load environment variables from parent directory
load_dotenv(os.path.join(parent_dir, '.env'))

# Tavily API configuration
TAVILY_API_KEY = os.environ.get("TAVILY_API_KEY", "")
TAVILY_SEARCH_URL = "https://api.tavily.com/search"
TAVILY_EXTRACT_URL = "https://api.tavily.com/extract"

# Initialize Tavily client
from tavily import TavilyClient
tavily = TavilyClient(api_key=TAVILY_API_KEY)

# Import existing modules
from agents import build_search_agent, build_reader_agent, writer_chain, critic_chain
from tools import web_search, scrape_url

app = FastAPI(title="Multi-Agent Research System", version="1.0.0")

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # In production, replace with specific origins
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic models for request/response
class TopicRequest(BaseModel):
    topic: str

class SearchRequest(BaseModel):
    query: str

class ExtractRequest(BaseModel):
    url: str

class ChatRequest(BaseModel):
    messages: list

class ResearchResponse(BaseModel):
    search_results: str
    scraped_content: str
    report: str
    feedback: str

@app.post("/api/search")
async def search_endpoint(request: SearchRequest):
    """Proxy endpoint for Tavily search"""
    try:
        # Call Tavily directly to get raw results
        results = tavily.search(query=request.query, max_results=5)
        return {"results": results.get('results', [])}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/extract")
async def extract_endpoint(request: ExtractRequest):
    """Proxy endpoint for Tavily extract"""
    try:
        # Call Tavily extract API directly
        response = requests.post(
            TAVILY_EXTRACT_URL,
            json={"urls": request.url, "extract_depth": "basic"},
            headers={"Authorization": f"Bearer {TAVILY_API_KEY}"},
        )
        return response.json()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/chat")
async def chat_endpoint(request: ChatRequest):
    """Proxy endpoint for Groq chat"""
    try:
        # Import here to avoid circular imports
        from langchain_groq import ChatGroq
        from langchain_core.output_parsers import StrOutputParser

        # Initialize Groq LLM (same as in agents.py)
        llm = ChatGroq(model="openai/gpt-oss-120b", temperature=0)

        # Create a simple chain for chat
        chain = llm | StrOutputParser()

        # Invoke with messages
        result = chain.invoke(request.messages)
        return {"response": result}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/api/research", response_model=ResearchResponse)
async def research_endpoint(request: TopicRequest):
    """Run the full research pipeline"""
    try:
        topic = request.topic.strip()
        if not topic:
            raise HTTPException(status_code=400, detail="Topic cannot be empty")

        # Run the research pipeline (same logic as pipeline.py)
        state = {}

        # Step 1: Search agent
        try:
            search_agent = build_search_agent()
            search_result = search_agent.invoke({
                "messages": [("user", f"Find recent, reliable and detailed information about: {topic}")]
            })
            state["search_results"] = search_result['messages'][-1].content
        except Exception as e:
            print(f"Error in search agent: {e}")
            raise HTTPException(status_code=504, detail=f"Search agent error: {e}")

        # Step 2: Reader agent
        try:
            reader_agent = build_reader_agent()
            reader_result = reader_agent.invoke({
                "messages": [
                    ("user",
                        f"Based on the following search result about '{topic}', "
                        f"pick the most relevent URL and scrape it for deeper content.\n\n"
                        f"search Results:\n{state['search_results'][:800]}"
                    )
                ]
            })
            state['scraped_content'] = reader_result['messages'][-1].content
        except Exception as e:
            print(f"Error in reader agent: {e}")
            raise HTTPException(status_code=504, detail=f"Reader agent error: {e}")

        # Step 3: Writer chain
        try:
            research_combined = (
                f"SEARCH RESULTS : \n {state['search_results']} \n\n"
                f"DETAILED SCRAPED CONTENT : \n {state['scraped_content']}"
            )
            state['report'] = writer_chain.invoke({
                "topic": topic,
                "research" : research_combined
            })
        except Exception as e:
            print(f"Error in writer chain: {e}")
            import traceback
            traceback.print_exc()
            raise HTTPException(status_code=504, detail=f"Writer chain error: {e}")

        # Step 4: Critic chain
        try:
            state['feedback'] = critic_chain.invoke({
                "report": state['report']
            })
        except Exception as e:
            print(f"Error in critic chain: {e}")
            import traceback
            traceback.print_exc()
            raise HTTPException(status_code=504, detail=f"Critic chain error: {e}")

        return ResearchResponse(
            search_results=state["search_results"],
            scraped_content=state["scraped_content"],
            report=state["report"],
            feedback=state["feedback"]
        )

    except Exception as e:
        # Log the error and return default response to avoid crashing
        print(f"Error in research endpoint: {e}")
        import traceback
        traceback.print_exc()
        return ResearchResponse(
            search_results="",
            scraped_content="",
            report=f"Error generating report: {str(e)}",
            feedback=f"Error generating feedback: {str(e)}"
        )

# Health check endpoint
@app.get("/health")
async def health_check():
    return {"status": "healthy", "service": "multi-agent-research-backend"}

# Serve frontend
@app.get("/")
async def read_root():
    return FileResponse("../frontend/index.html")

app.mount("/", StaticFiles(directory="../frontend", html=False), name="static")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)