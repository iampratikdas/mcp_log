import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { analyzeLog } from './agent.js';
import { createMcpServer } from './mcp-server.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

dotenv.config();

/**
 * Creates and configures the Express application.
 *
 * @returns {express.Application}
 */
export function createApp() {
  const app = express();

  // 1. JSON Body Parser with explicit payload limit
  app.use(express.json({ limit: '2mb' }));

  // 2. Strict Error Handling for Invalid/Malformed JSON Input
  app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
      return res.status(400).json({
        error: 'Invalid JSON input',
        message: 'Malformed JSON payload: ' + err.message
      });
    }
    next(err);
  });

  // Health check endpoint
  app.get('/health', (req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'log-analyzer-mcp-server'
    });
  });

  /**
   * Primary Endpoint: POST /analyze-log
   *
   * Accepts a request body containing a JSON log object, passes it
   * to an AI agent for analysis, and returns the concise probable issue.
   *
   * Request format:
   *   { ...json log properties... }
   *   or
   *   { "log": { ...json log properties... } }
   *
   * Response format:
   *   { "issue": "<probable issue>" }
   */
  app.post('/analyze-log', async (req, res) => {
    try {
      const payload = req.body;

      // Validate input: ensure payload exists, is an object, not an array, and not empty
      if (
        !payload ||
        typeof payload !== 'object' ||
        Array.isArray(payload) ||
        Object.keys(payload).length === 0
      ) {
        return res.status(400).json({
          error: 'Invalid JSON input',
          message: 'Request body must be a non-empty JSON log object.'
        });
      }

      // Support either direct log object or wrapped { log: ... } format
      const logContent = (payload.log && typeof payload.log === 'object' && !Array.isArray(payload.log))
        ? payload.log
        : payload;

      // Pass the log content to the AI agent
      const probableIssue = await analyzeLog(logContent);

      // Return concise response as requested: { "issue": "<probable issue>" }
      return res.status(200).json({
        issue: probableIssue
      });
    } catch (error) {
      console.error('[Error analyzing log]', error);
      return res.status(500).json({
        error: 'Internal Server Error',
        message: error.message || 'An unexpected error occurred during log analysis.'
      });
    }
  });

  // --- MCP (Model Context Protocol) SSE Integration ---
  const mcpServer = createMcpServer();
  const sseTransports = new Map();

  // SSE endpoint for MCP clients
  app.get('/sse', async (req, res) => {
    try {
      const transport = new SSEServerTransport('/messages', res);
      sseTransports.set(transport.sessionId, transport);

      req.on('close', () => {
        sseTransports.delete(transport.sessionId);
      });

      await mcpServer.connect(transport);
    } catch (err) {
      console.error('[MCP SSE Error]', err);
      if (!res.headersSent) {
        res.status(500).end('Failed to establish MCP SSE connection');
      }
    }
  });

  // Message handler endpoint for MCP clients
  app.post('/messages', async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = sseTransports.get(sessionId) || Array.from(sseTransports.values())[0];

    if (transport) {
      await transport.handlePostMessage(req, res, req.body);
    } else {
      res.status(404).json({ error: 'MCP session not found' });
    }
  });

  // Catch-all 404 handler
  app.use((req, res) => {
    res.status(404).json({
      error: 'Not Found',
      message: `Cannot ${req.method} ${req.path}`
    });
  });

  return app;
}

// Start server if this file is run directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const PORT = process.env.PORT || 3000;
  const app = createApp();

  const server = app.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` Log Analyzer MCP Server listening on port ${PORT}`);
    console.log(` Endpoint:   POST http://localhost:${PORT}/analyze-log`);
    console.log(` MCP SSE:    GET  http://localhost:${PORT}/sse`);
    console.log(` Health:     GET  http://localhost:${PORT}/health`);
    console.log(`=======================================================`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\nGracefully shutting down...');
    server.close(() => {
      console.log('Server closed.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
