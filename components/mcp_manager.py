import os
import json
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

class MCPManager:
    def __init__(self):
        self.session = None
        self.exit_stack = None
        self.tools = []

    async def connect(self, command_str):
        """Connects to an MCP server via command line stdio."""
        if not command_str:
            return None, "No command provided."

        parts = command_str.split()
        server_params = StdioServerParameters(
            command=parts[0],
            args=parts[1:],
            env=os.environ.copy()
        )

        try:
            # Initialize connection context
            transport_ctx = stdio_client(server_params)
            read, write = await transport_ctx.__aenter__()
            
            self.session = ClientSession(read, write)
            await self.session.__aenter__()
            await self.session.initialize()
            
            # Fetch available tools
            tools_response = await self.session.list_tools()
            self.tools = tools_response.tools
            
            return self.tools, f"✅ Connected. Loaded {len(self.tools)} tools."
        except Exception as e:
            return None, f"❌ MCP Connection Failed: {str(e)}"

    def get_openai_tools(self):
        """Converts internal MCP tools to OpenAI API format."""
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
        return openai_tools if openai_tools else None

    async def execute_tool(self, tool_name, tool_args_json):
        """Executes a tool call requested by the LLM."""
        if not self.session:
            return "Error: No active MCP session."
        
        try:
            args = json.loads(tool_args_json)
            result = await self.session.call_tool(tool_name, arguments=args)
            return result.content[0].text if result.content else "Success (No Output)"
        except Exception as e:
            return f"Tool Execution Error: {str(e)}"