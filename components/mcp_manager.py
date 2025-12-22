import os
import json
from contextlib import AsyncExitStack, asynccontextmanager
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.client.streamable_http import streamable_http_client
from typing import AsyncGenerator

class MCPManager:
    def __init__(self):
        self.session = None
        self._exit_stack = None
        self.tools = []

    async def connect(self, connection_str: str):
        if not connection_str:
            return None, "No connection string provided."

        if self.session:
            await self.disconnect()

        self._exit_stack = AsyncExitStack()

        try:
            if connection_str.startswith(("http://", "https://")):
                # streamable_http_client returns a pair of (read, write) streams
                streams = await self._exit_stack.enter_async_context(
                    streamable_http_client(connection_str)
                )
                self.session = await self._exit_stack.enter_async_context(
                    ClientSession(streams[0], streams[1])
                )
                print(f"Connected to MCP server at {connection_str} via HTTP.")
            else:
                parts = connection_str.split()
                server_params = StdioServerParameters(
                    command=parts[0],
                    args=parts[1:],
                    env=os.environ.copy()
                )
                # Stdio returns a pair of (read, write) streams
                read, write = await self._exit_stack.enter_async_context(
                    stdio_client(server_params)
                )
                self.session = await self._exit_stack.enter_async_context(
                    ClientSession(read, write)
                )
                print(f"Connected to MCP server via stdio command: {connection_str}")
            
            await self.session.initialize()
            
            tools_response = await self.session.list_tools()
            self.tools = tools_response.tools
            
            return self.tools, f"✅ Connected. Loaded {len(self.tools)} tools."
    
        except Exception as e:
            await self.disconnect()
            return None, f"❌ MCP Connection Failed: {str(e)}"

    def get_openai_tools(self):
        if not self.tools:
            return None
        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": tool.inputSchema,
                },
            }
            for tool in self.tools
        ]

    def is_tool_streamable(self, tool_name: str) -> bool:
        tool_def = next((t for t in self.tools if t.name == tool_name), None)
        return tool_def.streamable if tool_def else False

    @asynccontextmanager
    async def execute_tool_stream(self, tool_name: str, tool_args_json: str) -> AsyncGenerator[str, None]:
        if not self.session:
            raise Exception("No active MCP session.")
        
        args = json.loads(tool_args_json) if isinstance(tool_args_json, str) else tool_args_json
        
        try:
            async with self.session.call_tool_stream(tool_name, arguments=args) as stream:
                yield stream
        except Exception as e:
            raise Exception(f"Tool Execution Error: {str(e)}")

    async def execute_tool(self, tool_name: str, tool_args_json: str) -> str:
        if not self.session:
            return "Error: No active MCP session."
        
        try:
            args = json.loads(tool_args_json) if isinstance(tool_args_json, str) else tool_args_json
            
            result = await self.session.call_tool(tool_name, arguments=args)
            
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