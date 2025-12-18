import os
from dotenv import load_dotenv

# Load .env file if it exists
load_dotenv()

async def setup_chat_settings():
    """
    Returns a dictionary of settings loaded from environment variables.
    """
    settings = {
        "openai_api_key": os.getenv("OPENAI_API_KEY", ""),
        "openai_base_url": os.getenv("OPENAI_BASE_URL", "http://localhost:11434/v1"),
        "openai_model": os.getenv("OPENAI_MODEL", "gpt-4o-mini"),
        # MCP Command example: "uvx -q mcp-server-filesystem" or "npx -y @modelcontextprotocol/server-filesystem /Users/me/Desktop"
        "mcp_command": os.getenv("MCP_COMMAND", "") 
    }
    
    if not settings["openai_api_key"]:
        print("⚠️ Warning: OPENAI_API_KEY not found in environment variables.")
        
    return settings