import os
import json
import webbrowser
import uvicorn
import asyncio
from typing import List, Optional, Dict, Any
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import StreamingResponse, FileResponse
from fastapi.templating import Jinja2Templates
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
script_dir = os.path.dirname(__file__)
static_path = os.path.join(script_dir, "static")
app.mount("/static", StaticFiles(directory=static_path), name="static")
# Set up the template directory
templates = Jinja2Templates(directory="templates")

# 2. In-memory Session Storage
sessions: Dict[str, Dict[str, Any]] = {}

# 3. Persistent Settings Path
SETTINGS_FILE = "data/saved_settings.json"
CHAT_HISTORY_FILE = "data/chat_history.json"

def load_persistent_settings():
    """
    PRIORITY HIERARCHY:
    1. saved_settings.json (User-saved configuration)
    2. .env file (Environment variables via config.py)
    3. System Defaults (Fallbacks in config.py)
    """
    # Priority 1: Check for physical settings file
    if os.path.exists(SETTINGS_FILE):
        try:
            with open(SETTINGS_FILE, "r") as f:
                print("📂 Priority 1: Loading from saved_settings.json")
                return json.load(f)
        except Exception as e:
            print(f"⚠️ Error reading settings file: {e}")

    # Priority 2 & 3: Fallback to .env or system defaults
    print("🌿 Priority 2/3: Loading from .env or Defaults")
    initial_settings = asyncio.run(config.setup_chat_settings())
    
    # Ensure data directory exists and initialize the JSON file
    os.makedirs("data", exist_ok=True)
    with open(SETTINGS_FILE, "w") as f:
        json.dump(initial_settings, f, indent=4)
        
    return initial_settings

# Initial load according to the priority hierarchy
current_settings = load_persistent_settings()

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

class HistorySaveRequest(BaseModel):
    history: Dict[str, Any]

# =======================================================
# 🛠️ SESSION HELPER
# =======================================================
async def get_or_create_session(session_id: str, new_settings: dict = None):
    global current_settings
    
    # 1. Update persistent file and global state if UI provides new data
    settings_changed = False
    if new_settings:
        # Check if critical settings actually changed to avoid unnecessary re-initialization
        critical_keys = ["openai_api_key", "openai_base_url", "mcp_command", "openai_model"]
        for key in critical_keys:
            if new_settings.get(key) != current_settings.get(key):
                settings_changed = True
                break
        
        if settings_changed:
            current_settings.update(new_settings)
            with open(SETTINGS_FILE, "w") as f:
                json.dump(current_settings, f, indent=4)
            print("💾 Settings synchronized and saved to data/saved_settings.json")

    # 2. If session doesn't exist OR settings changed, (re)initialize
    if session_id not in sessions or settings_changed:
        # Cleanup existing MCP connection if re-initializing
        if session_id in sessions and "mcp_manager" in sessions[session_id]:
            print(f"🔄 Re-initializing session {session_id} with new settings...")
            # If your MCPManager has a disconnect/close method, call it here
            # await sessions[session_id]["mcp_manager"].disconnect()

        client = AsyncOpenAI(
            api_key=current_settings.get("openai_api_key"),
            base_url=current_settings.get("openai_base_url"),
        )
        
        mcp_manager = MCPManager()
        mcp_cmd = current_settings.get("mcp_command")
        
        if mcp_cmd:
            print(f"🔌 Connecting MCP for session {session_id}...")
            await mcp_manager.connect(mcp_cmd)
            
        sessions[session_id] = {
            "client": client,
            "mcp_manager": mcp_manager,
            "model": current_settings.get("openai_model", "gpt-4o"),
        }
    
    return sessions[session_id]

# =======================================================
# 🔄 STREAMING LOGIC
# =======================================================
async def process_stream(client, model, messages, mcp_manager):
    current_messages = messages.copy()
    
    # Ensure tools exist; if list is empty, pass None to avoid API errors
    mcp_tools = mcp_manager.get_openai_tools()
    tools = mcp_tools if mcp_tools else None

    while True:
        try:
            stream = await client.chat.completions.create(
                model=model, 
                messages=current_messages, 
                tools=tools, 
                stream=True
            )
            
            full_content = ""
            tool_calls_buffer = {} # Use dict to track by index
            
            async for chunk in stream:
                if not chunk.choices:
                    continue
                    
                delta = chunk.choices[0].delta
                
                # Handle Text Content
                if delta.content:
                    full_content += delta.content
                    yield json.dumps({"type": "token", "content": delta.content}) + "\n"
                
                # Handle Tool Calls (Streaming logic)
                if delta.tool_calls:
                    for tc in delta.tool_calls:
                        idx = tc.index
                        if idx not in tool_calls_buffer:
                            tool_calls_buffer[idx] = {
                                "id": tc.id, 
                                "function": {"name": "", "arguments": ""}
                            }
                        
                        if tc.id: 
                            tool_calls_buffer[idx]["id"] = tc.id
                        if tc.function.name: 
                            tool_calls_buffer[idx]["function"]["name"] += tc.function.name
                        if tc.function.arguments: 
                            tool_calls_buffer[idx]["function"]["arguments"] += tc.function.arguments

            # Convert buffer to list
            tool_calls = list(tool_calls_buffer.values())

            # If no tools were called, we are done
            if not tool_calls:
                break

            # 1. Append Assistant's tool request to history
            assistant_msg = {
                "role": "assistant",
                "content": full_content or None,
                "tool_calls": [
                    {
                        "id": tc["id"], 
                        "type": "function", 
                        "function": tc["function"]
                    } for tc in tool_calls
                ]
            }
            current_messages.append(assistant_msg)

            # 2. Execute tools and append results
            yield json.dumps({"type": "status", "content": "🛠️ Executing tools..."}) + "\n"
            
            for tc in tool_calls:
                func_name = tc["function"]["name"]
                args = tc["function"]["arguments"]
                
                # Logic check: Ensure execute_tool handles JSON string args internally
                result_text = await mcp_manager.execute_tool(func_name, args)
                
                yield json.dumps({
                    "type": "tool_result", 
                    "tool": func_name, 
                    "result": result_text
                }) + "\n"
                
                current_messages.append({
                    "role": "tool", 
                    "tool_call_id": tc["id"], 
                    "content": str(result_text)
                })

            # The loop continues to send the tool results back to the LLM
            
        except Exception as e:
            yield json.dumps({"type": "error", "content": f"Error: {str(e)}"}) + "\n"
            break

# =======================================================
# 🌐 ROUTES
# =======================================================

@app.get("/")
async def serve_ui(request: Request):
    """Serves the frontend HTML."""
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/settings")
async def get_settings():
    """Returns the current application settings."""
    return current_settings

@app.get("/history")
async def get_history():
    """Returns the chat history."""
    if not os.path.exists(CHAT_HISTORY_FILE):
        return {}
    with open(CHAT_HISTORY_FILE, "r") as f:
        return json.load(f)

@app.get("/history/{chat_id}")
async def get_chat_history(chat_id: str):
    """Returns a specific chat history."""
    if not os.path.exists(CHAT_HISTORY_FILE):
        raise HTTPException(status_code=404, detail="Chat history not found")
    with open(CHAT_HISTORY_FILE, "r") as f:
        history = json.load(f)
        chat = history.get(chat_id)
        if not chat:
            raise HTTPException(status_code=404, detail="Chat not found")
        return chat

@app.post("/history")
async def save_history(request: HistorySaveRequest):
    """Saves the chat history."""
    with open(CHAT_HISTORY_FILE, "w") as f:
        json.dump(request.history, f, indent=4)
    return {"status": "ok"}


@app.delete("/history")
async def clear_history():
    """Deletes all chat history."""
    if os.path.exists(CHAT_HISTORY_FILE):
        with open(CHAT_HISTORY_FILE, "w") as f:
            json.dump({}, f)
    return {"status": "ok"}

@app.delete("/history/{chat_id}")
async def delete_history(chat_id: str):
    """Deletes a specific chat history."""
    if not os.path.exists(CHAT_HISTORY_FILE):
        raise HTTPException(status_code=404, detail="Chat history not found")
    with open(CHAT_HISTORY_FILE, "r+") as f:
        history = json.load(f)
        if chat_id not in history:
            raise HTTPException(status_code=404, detail="Chat not found")
        del history[chat_id]
        f.seek(0)
        json.dump(history, f, indent=4)
        f.truncate()
    return {"status": "ok"}

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    try:
        # Pass settings to session creator; it will handle disk saving and re-init
        session = await get_or_create_session(request.session_id, request.settings)
        
        # If this was just a settings sync (no messages), return a success status
        if not request.messages:
            return {"status": "settings_updated"}

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
    except Exception as e:
        print(f"❌ Chat Endpoint Error: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    # Open browser automatically
    webbrowser.open("http://localhost:8000")
    print("🚀 Server starting... UI opening at http://localhost:8000")
    uvicorn.run("app:app", host="0.0.0.0", port=8000, reload=True)