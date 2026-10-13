# Log Analyzer MCP Server

A lightweight Node.js Model Context Protocol (MCP) and Express.js server that accepts JSON log objects, passes them to an AI agent for diagnostic analysis, and returns a concise probable root-cause issue.

---

## Features

- **Single HTTP Endpoint**: Exposes `POST /analyze-log`.
- **AI Agent Diagnostics**: Evaluates error messages, status codes, and stack traces to return a concise summary string (`{ "issue": "<probable issue>" }`).
- **Hybrid AI Engine**:
  - Connects to LLM providers (**OpenAI**, **Google Gemini**, or **Anthropic Claude**) when configured via environment variables.
  - Features an intelligent, built-in **heuristic diagnostic engine** that runs completely offline with zero setup/external API keys needed.
- **Robust JSON Error Handling**: Intercepts malformed or invalid JSON payloads and responds with `HTTP 400 Bad Request`.
- **Dual MCP Protocol Support**:
  - Direct HTTP REST API via Express.js (`POST /analyze-log`).
  - Standard MCP server tool (`analyze_log`) supporting both **Server-Sent Events (SSE)** and **stdio** transport for hosts like Claude Desktop, Cursor, and Antigravity.
- **Lightweight & Fast**: Built with modern ES Modules and native Node.js APIs.

---

## Getting Started

### 1. Installation

Ensure Node.js (v18+) is installed:

```bash
npm install
```

### 2. Configuration (Optional)

Copy `.env.example` to `.env` if you want to use an LLM provider:

```bash
# Optional: OpenAI / Local Ollama
OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o-mini

# Optional: Google Gemini
# GEMINI_API_KEY=...

# Optional: Port (default: 3000)
PORT=3000
```

> **Note:** If no API key is specified, the server automatically utilizes the high-accuracy built-in heuristic AI agent, so it runs completely out of the box!

### 3. Start the Server

```bash
npm start
```

---

## API Specification

### `POST /analyze-log`

Analyzes a JSON log object and returns the probable issue.

#### Headers
```http
Content-Type: application/json
```

#### Request Body
Can be a direct log object or wrapped in a `log` property:

```json
{
  "timestamp": "2026-10-13T07:00:00Z",
  "level": "error",
  "service": "billing-service",
  "message": "Connection refused when connecting to postgres at db.internal:5432"
}
```

#### Success Response (`200 OK`)
```json
{
  "issue": "PostgreSQL database connection refused on port 5432"
}
```

---

### Error Handling

#### Malformed JSON Syntax (`400 Bad Request`)
When the client sends invalid JSON syntax (e.g., missing quotes, trailing comma):
```bash
curl -X POST http://localhost:3000/analyze-log \
  -H "Content-Type: application/json" \
  -d '{"level": "error", "message": unquoted}'
```
Response:
```json
{
  "error": "Invalid JSON input",
  "message": "Malformed JSON payload: Expected property name or '}' in JSON..."
}
```

#### Non-Object or Empty Payload (`400 Bad Request`)
When the client sends an empty payload, an array, or an empty `{}`:
```bash
curl -X POST http://localhost:3000/analyze-log \
  -H "Content-Type: application/json" \
  -d '{}'
```
Response:
```json
{
  "error": "Invalid JSON input",
  "message": "Request body must be a valid, non-empty JSON log object."
}
```

---

## Example Usage with cURL

### 1. Database Connection Failure
```bash
curl -X POST http://localhost:3000/analyze-log \
  -H "Content-Type: application/json" \
  -d '{
    "timestamp": "2026-10-13T07:00:00Z",
    "level": "error",
    "service": "auth-service",
    "message": "connection refused when connecting to postgres at 5432"
  }'
```
**Response:**
```json
{"issue":"PostgreSQL database connection refused on port 5432"}
```

### 2. Memory Exhaustion
```bash
curl -X POST http://localhost:3000/analyze-log \
  -H "Content-Type: application/json" \
  -d '{
    "level": "fatal",
    "error": "FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory"
  }'
```
**Response:**
```json
{"issue":"Node.js V8 process out of memory (heap exhaustion)"}
```

### 3. Expired Authentication Token
```bash
curl -X POST http://localhost:3000/analyze-log \
  -H "Content-Type: application/json" \
  -d '{
    "error": "jwt expired at 1700000000",
    "statusCode": 401
  }'
```
**Response:**
```json
{"issue":"Authentication failure: Expired JWT token"}
```

---

## MCP (Model Context Protocol) Usage

### Stdio Transport (Claude Desktop / Cursor / Antigravity)
Run the server over stdio:
```bash
npm run mcp
```

Add to your MCP configuration (e.g. `claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "log-analyzer": {
      "command": "node",
      "args": ["E:/DEMO/src/mcp-server.js"]
    }
  }
}
```

### Server-Sent Events (SSE) Transport
When `npm start` is running, MCP clients can connect over SSE:
- **SSE URL:** `http://localhost:3000/sse`
- **Messages URL:** `http://localhost:3000/messages`

---

---

## Slack Interactivity Integration

You can trigger log analysis directly from a Slack channel when an engineer clicks an interactive button, and post the diagnostic summary back into the channel.

### How It Works

```
[ Slack Channel Alert ]
         │
    (Clicks "🔍 Analyze with MCP" Button)
         │
         ▼
[ POST /slack/interactions ]  ───────►  Immediate HTTP 200 OK (<3s timeout rule)
         │
   (Asynchronous)
         ▼
[ MCP Engine (analyze_log) ]  ───────►  Diagnoses issue with AI / Heuristics
         │
         ▼
[ POST payload.response_url ] ───────►  Renders summary back into Slack channel
```

### Endpoints

1. **`POST /slack/create-alert`**
   Generates a Slack Block Kit message with an embedded interactive button containing the log payload:
   ```bash
   curl -X POST http://localhost:3000/slack/create-alert \
     -H "Content-Type: application/json" \
     -d '{
       "title": "🚨 Auth Service Error",
       "log": {
         "service": "auth-service",
         "level": "error",
         "message": "connection refused when connecting to postgres at 5432"
       }
     }'
   ```

2. **`POST /slack/interactions`**
   The webhook URL configured in your Slack App under **Interactivity & Shortcuts**:
   - Immediately acknowledges Slack (`200 OK`) to satisfy the 3-second deadline.
   - Extracts the log payload from `action.value`.
   - Runs the MCP / AI diagnosis.
   - Posts the rich Block Kit diagnosis to the channel via Slack's `response_url`.

### Simulating a Slack Button Click with cURL

```bash
curl -X POST "http://localhost:3000/slack/interactions?sync=true" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  --data-urlencode 'payload={
    "type": "block_actions",
    "user": { "id": "U12345", "name": "alice" },
    "actions": [
      {
        "action_id": "btn_analyze_log",
        "value": "{\"level\":\"error\",\"message\":\"connection refused on port 5432\"}"
      }
    ]
  }'
```

---

## Running Automated Tests

Run the test suite using Node.js's native test runner:

```bash
npm test
```
All 25 tests covering HTTP endpoints, Slack Block Kit button interactions, signature verification, error handling, AI agent heuristics, and MCP registrations will execute.

---

## Running with Docker

### Build Image
```bash
docker build -t log-analyzer-mcp-server .
```

### Run Container
```bash
docker run -d -p 3000:3000 --name log-analyzer log-analyzer-mcp-server
```

Or with Docker Compose:
```bash
docker compose up -d
```


