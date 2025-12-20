import os
import json
from contextlib import AsyncExitStack
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

class MCPManager:
    def __init__(self):
        self.session = None
        self._exit_stack = None
        self.tools = []

    async def connect(self, command_str):
        """Connects to an MCP server via command line stdio using an AsyncExitStack."""
        if not command_str:
            return None, "No command provided."
        
        # If already connected, disconnect first to avoid leaked handles
        if self.session:
            await self.disconnect()

        parts = command_str.split()
        server_params = StdioServerParameters(
            command=parts[0],
            args=parts[1:],
            env=os.environ.copy()
        )

        self._exit_stack = AsyncExitStack()

        try:
            # 1. Properly enter the stdio transport context
            read, write = await self._exit_stack.enter_async_context(stdio_client(server_params))
            
            # 2. Properly enter the session context
            self.session = await self._exit_stack.enter_async_context(ClientSession(read, write))
            
            # 3. Protocol initialization
            await self.session.initialize()
            
            # Fetch available tools
            tools_response = await self.session.list_tools()
            self.tools = tools_response.tools
            
            return self.tools, f"✅ Connected. Loaded {len(self.tools)} tools."
        
        except Exception as e:
            await self.disconnect()
            return None, f"❌ MCP Connection Failed: {str(e)}"

    def get_openai_tools(self):
        """Converts internal MCP tools to OpenAI API format."""
        if not self.tools:
            return None
            
        openai_tools = []
        for tool in self.tools:
            openai_tools.append({
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.inputSchema
                }
            })
        return openai_tools

    async def execute_tool(self, tool_name, tool_args_json):
        """Executes a tool call requested by the LLM."""
        if not self.session:
            return "Error: No active MCP session."
        
        try:
            # Ensure args are a dictionary (LLMs send JSON strings)
            args = json.loads(tool_args_json) if isinstance(tool_args_json, str) else tool_args_json
            
            result = await self.session.call_tool(tool_name, arguments=args)
            
            # Handle multiple content types (text, images, etc.) - extract text for LLM
            text_parts = [c.text for c in result.content if hasattr(c, 'text')]
            return "\n".join(text_parts) if text_parts else "Success (No Output)"
            
        except Exception as e:
            return f"Tool Execution Error: {str(e)}"

    async def disconnect(self):
        """Cleanly closes the session and transport."""
        if self._exit_stack:
            await self._exit_stack.aclose()
            self._exit_stack = None
        self.session = None
        self.tools = []