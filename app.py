import os
import json
import webbrowser
import uvicorn
from typing import List, Optional, Dict, Any
from fastapi import FastAPI
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from openai import AsyncOpenAI, APIConnectionError
from components.mcp_manager import MCPManager
import components.config as config

# =======================================================
# 🚀 APP SETUP
# =======================================================
app = FastAPI(title="MCP Chat App")

# 1. Mount Static Files (CSS/JS if you separate them later)
app.mount("/static", StaticFiles(directory="static"), name="static")

# 2. In-memory Session Storage
sessions: Dict[str, Dict[str, Any]] = {}

# =======================================================
# 📦 DATA MODELS
# =======================================================
class ChatMessage(BaseModel):
    role: str
    content: str | List[Dict[str, Any]]

class ChatRequest(BaseModel):
    session_id: str
    messages: List[ChatMessage]
    settings: Optional[Dict[str, Any]] = None

# =======================================================
# 🛠️ SESSION HELPER
# =======================================================
async def get_or_create_session(session_id: str, settings: dict):
    if session_id not in sessions:
        if not settings:
            settings = await config.setup_chat_settings()
        
        client = AsyncOpenAI(
            api_key=settings.get("openai_api_key"),
            base_url=settings.get("openai_base_url"),
        )
        
        mcp_manager = MCPManager()
        mcp_cmd = settings.get("mcp_command")
        
        if mcp_cmd:
            print(f"🔌 Connecting MCP for session {session_id}...")
            await mcp_manager.connect(mcp_cmd)
            
        sessions[session_id] = {
            "client": client,
            "mcp_manager": mcp_manager,
            "model": settings.get("openai_model", "gpt-4o"),
        }
    return sessions[session_id]

# =======================================================
# 🔄 STREAMING LOGIC
# =======================================================
async def process_stream(client, model, messages, mcp_manager):
    current_messages = messages.copy()
    tools = mcp_manager.get_openai_tools()

    while True:
        try:
            stream = await client.chat.completions.create(
                model=model, messages=current_messages, tools=tools, stream=True
            )
            
            tool_calls = []
            
            async for chunk in stream:
                delta = chunk.choices[0].delta
                if delta.content:
                    yield json.dumps({"type": "token", "content": delta.content}) + "\n"
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        if tc.index >= len(tool_calls):
                            tool_calls.append({"id": "", "function": {"name": "", "arguments": ""}})
                        if tc.id: tool_calls[tc.index]["id"] = tc.id
                        if tc.function.name: tool_calls[tc.index]["function"]["name"] += tc.function.name
                        if tc.function.arguments: tool_calls[tc.index]["function"]["arguments"] += tc.function.arguments

            if not tool_calls:
                break

            yield json.dumps({"type": "status", "content": "🛠️ Executing tools..."}) + "\n"
            
            current_messages.append({
                "role": "assistant",
                "content": None,
                "tool_calls": [{"id": tc["id"], "type": "function", "function": tc["function"]} for tc in tool_calls]
            })

            for tc in tool_calls:
                func_name = tc["function"]["name"]
                args = tc["function"]["arguments"]
                result_text = await mcp_manager.execute_tool(func_name, args)
                
                yield json.dumps({"type": "tool_result", "tool": func_name, "result": result_text}) + "\n"
                
                current_messages.append({"role": "tool", "tool_call_id": tc["id"], "content": result_text})

        except APIConnectionError as e:
            yield json.dumps({"type": "error", "content": str(e)}) + "\n"
            break
        except Exception as e:
            yield json.dumps({"type": "error", "content": f"Unexpected error: {str(e)}"}) + "\n"
            break

# =======================================================
# 🌐 ROUTES
# =======================================================

@app.get("/")
async def serve_ui():
    """Serves the frontend HTML."""
    return FileResponse('static/index.html')

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    session = await get_or_create_session(request.session_id, request.settings)
    formatted_messages = [msg.dict() for msg in request.messages]

    return StreamingResponse(
        process_stream(
            client=session["client"],
            model=session["model"],
            messages=formatted_messages,
            mcp_manager=session["mcp_manager"]
        ),
        media_type="application/x-ndjson"
    )

if __name__ == "__main__":
    # Open browser automatically
    webbrowser.open("http://localhost:8000")
    print("🚀 Server starting... UI opening at http://localhost:8000")
    uvicorn.run(app, host="0.0.0.0", port=8000)