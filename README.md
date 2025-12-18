# AI Chat App

This is a simple, yet powerful, chat application that connects to an OpenAI-compatible API and can be extended with custom tools using the *Master Control Program (MCP)*.

## Features

- **OpenAI Integration:** Connects to any OpenAI-compatible API for chat completions.
- **Extensible Tooling:** Integrate custom tools via the MCP server. The application dynamically loads and makes these tools available to the language model.
- **Web-Based UI:** A clean and simple web interface for chatting.
- **Session Management:** Persists chat sessions and settings.
- **Configuration:** Easily configure the application through a `data/saved_settings.json` file.
- **Chat History:** Saves and loads chat history from `data/chat_history.json`.

## How It Works

The application is composed of a few key components:

- **`app.py`:** A [FastAPI](https://fastapi.tiangolo.com/) backend that serves the web UI, handles chat sessions, and communicates with the OpenAI API.
- **`static/index.html`:** The frontend of the application, written in HTML and JavaScript.
- **`components/mcp_manager.py`:** A manager for the Master Control Program (MCP). This component is responsible for connecting to the MCP server, discovering available tools, and executing them.
- **`components/config.py`:** Manages the application's configuration settings.

The general workflow is as follows:

1.  The user opens the web UI.
2.  The user configures the OpenAI API settings and the MCP command.
3.  The user starts a chat session.
4.  The backend connects to the MCP server and retrieves the list of available tools.
5.  The backend sends the user's message, along with the list of tools, to the OpenAI API.
6.  If the language model decides to use a tool, the backend executes the tool on the MCP server and sends the result back to the language model.
7.  The language model's response is streamed back to the UI.

## Getting Started

### Prerequisites

- Python 3.7+
- An OpenAI-compatible API key and base URL.
- An MCP server to connect to (optional).

### Installation

1.  Clone this repository:
    ```bash
    git clone <repository-url>
    ```
2.  Install the required Python packages:
    ```bash
    pip install -r requirements.txt
    ```

### Running the Application

1.  Start the application:
    ```bash
    python app.py
    ```
2.  Open your web browser and navigate to `http://localhost:8000`.
3.  Configure the settings in the UI, including your OpenAI API key, base URL, and the MCP command if you have one.
4.  Start chatting!

## Configuration

The application can be configured through a `.env` file in the root of the project, or by editing the `data/saved_settings.json` file directly. The application loads settings with the following priority:

1.  `data/saved_settings.json`
2.  `.env` file
3.  Default values in `config.py`

Create a `.env` file in the root of the project and add the following variables:

```
OPENAI_API_KEY="your-api-key"
OPENAI_BASE_URL="your-base-url"
OPENAI_MODEL="your-model"
MCP_COMMAND="your-mcp-command"
```

The following settings are available:

- `openai_api_key`: Your OpenAI API key.
- `openai_base_url`: The base URL of the OpenAI API.
- `openai_model`: The model to use for chat completions.
- `mcp_command`: The command to start the MCP server.
