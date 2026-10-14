import express from 'express';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { analyzeLog } from './agent.js';
import { createMcpServer } from './mcp-server.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { createSlackAlertMessage, handleSlackInteraction, handleSlackEvent, slackClient, verifySlackSignature } from './slack.js';

dotenv.config();

/**
 * Creates and configures the Express application.
 *
 * @returns {express.Application}
 */
export function createApp() {
  const app = express();

  // 1. JSON Body Parser with raw body capture for signature verification
  app.use(express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  // 2. URL-encoded Body Parser (Slack sends interactivity payloads as x-www-form-urlencoded)
  app.use(express.urlencoded({
    extended: true,
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  }));

  // 3. Strict Error Handling for Invalid/Malformed JSON Input
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

      // Return concise response: { "issue": "<probable issue>" }
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

  /**
   * Slack Interactivity Endpoint: POST /slack/interactions
   *
   * Receives button clicks from Slack Block Kit, validates signature (if configured),
   * immediately acknowledges to avoid 3-second timeout, then runs log analysis
   * and posts the summary back to the Slack channel using payload.response_url.
   */
  app.post('/slack/interactions', async (req, res) => {
    try {
      // 1. Signature verification if SLACK_SIGNING_SECRET is configured
      const signingSecret = process.env.SLACK_SIGNING_SECRET;
      if (signingSecret) {
        const isValid = verifySlackSignature({
          signature: req.headers['x-slack-signature'],
          timestamp: req.headers['x-slack-request-timestamp'],
          rawBody: req.rawBody,
          signingSecret
        });

        if (!isValid) {
          return res.status(401).json({ error: 'Invalid Slack signature' });
        }
      }

      // Handle URL verification if user set /slack/interactions as Event Subscriptions URL
      if (req.body?.type === 'url_verification') {
        return res.status(200).json({ challenge: req.body.challenge });
      }

      // Handle event callback if sent to this endpoint
      if (req.body?.type === 'event_callback') {
        const event = req.body.event;
        const isSync = req.query.sync === 'true' || req.headers['x-test-sync'] === 'true';
        if (isSync) {
          const result = await handleSlackEvent(event);
          return res.status(200).json(result);
        }
        res.status(200).send();
        handleSlackEvent(event).catch((err) => {
          console.error('[Slack Events Background Error]:', err);
        });
        return;
      }

      // 2. Extract payload: Slack sends URL-encoded form data where 'payload' is a JSON string
      let payload;
      if (typeof req.body.payload === 'string') {
        try {
          payload = JSON.parse(req.body.payload);
        } catch {
          return res.status(400).json({ error: 'Invalid JSON payload in form-urlencoded body' });
        }
      } else if (req.body && typeof req.body === 'object' && req.body.type) {
        payload = req.body;
      } else {
        return res.status(400).json({ error: 'Invalid payload: missing Slack interactive payload' });
      }

      const channelId = payload.channel?.id || payload.channel || payload.container?.channel_id || payload.channel_id;
      console.log(`[Slack Interaction] Received button action from channel: ${channelId || 'unknown'}`);

      const isSync = req.query.sync === 'true' || req.headers['x-test-sync'] === 'true';

      if (isSync) {
        // Synchronous mode (used for automated tests or debugging)
        const result = await handleSlackInteraction(payload);
        return res.status(200).json(result);
      }

      // 3. Slack 3-second timeout rule: Immediately acknowledge receipt
      res.status(200).send();

      // 4. Asynchronously analyze log and post summary to target channel / response_url
      handleSlackInteraction(payload).catch((err) => {
        console.error('[Slack Interaction Background Error]:', err);
      });
    } catch (err) {
      console.error('[Slack Interaction Handler Error]:', err);
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Failed to process Slack interaction', message: err.message });
      }
    }
  });

  /**
   * Slack Events API Endpoint: POST /slack/events
   *
   * Handles Slack Event Subscriptions:
   * 1. URL Verification handshake (challenge)
   * 2. 'app_mention' / 'message.channels' events when bot is tagged in a reply with an error
   * 3. Analyzes the error and replies back to the channel/thread using client.chat.postMessage:
   *    await client.chat.postMessage({
   *      channel: event.channel,
   *      thread_ts: event.thread_ts || event.ts,
   *      text: response.ok ? `API response:\n${result}` : `API error (${response.status}): ${result}`
   *    });
   */
  app.post('/slack/events', async (req, res) => {
    try {
      // 1. Signature verification if SLACK_SIGNING_SECRET is configured
      const signingSecret = process.env.SLACK_SIGNING_SECRET;
      if (signingSecret) {
        const isValid = verifySlackSignature({
          signature: req.headers['x-slack-signature'],
          timestamp: req.headers['x-slack-request-timestamp'],
          rawBody: req.rawBody,
          signingSecret
        });

        if (!isValid) {
          return res.status(401).json({ error: 'Invalid Slack signature' });
        }
      }

      // 2. Handle Slack URL verification challenge during Event Subscriptions setup
      if (req.body?.type === 'url_verification') {
        return res.status(200).json({ challenge: req.body.challenge });
      }

      // 3. Avoid duplicate processing on Slack retries
      if (req.headers['x-slack-retry-num']) {
        console.log(`[Slack Events] Ignoring retry attempt #${req.headers['x-slack-retry-num']}`);
        return res.status(200).send();
      }

      // 4. Handle event callbacks (e.g. app_mention)
      if (req.body?.type === 'event_callback') {
        const event = req.body.event;
        console.log(`[Slack Events] Received ${event?.type} in channel: ${event?.channel || 'unknown'}`);

        const isSync = req.query.sync === 'true' || req.headers['x-test-sync'] === 'true';

        if (isSync) {
          const result = await handleSlackEvent(event);
          return res.status(200).json(result);
        }

        // Acknowledge receipt immediately to avoid 3-second timeout
        res.status(200).send();

        // Process in background and reply to the channel/thread
        handleSlackEvent(event).catch((err) => {
          console.error('[Slack Events Background Error]:', err);
        });
        return;
      }

      return res.status(400).json({ error: 'Unsupported Slack event type' });
    } catch (err) {
      console.error('[Slack Events Handler Error]:', err);
      if (!res.headersSent) {
        return res.status(500).json({ error: 'Failed to process Slack event', message: err.message });
      }
    }
  });

  /**
   * Helper Endpoint: POST /slack/create-alert
   *
   * Formats a JSON log into a Slack Block Kit alert message containing
   * the "Analyze with MCP" interactive button.
   */
  app.post('/slack/create-alert', (req, res) => {
    try {
      const { log, title, channel } = req.body || {};
      if (!log || typeof log !== 'object' || Array.isArray(log) || Object.keys(log).length === 0) {
        return res.status(400).json({ error: 'Missing or invalid log object in request body' });
      }
      const slackMessage = createSlackAlertMessage({ log, title, channel });
      return res.status(200).json({ message: slackMessage });
    } catch (err) {
      return res.status(500).json({ error: err.message });
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
    console.log(` Endpoint:     POST http://localhost:${PORT}/analyze-log`);
    console.log(` Slack Events: POST http://localhost:${PORT}/slack/events`);
    console.log(` Slack Int:    POST http://localhost:${PORT}/slack/interactions`);
    console.log(` Slack Alert:  POST http://localhost:${PORT}/slack/create-alert`);
    console.log(` MCP SSE:      GET  http://localhost:${PORT}/sse`);
    console.log(` Health:       GET  http://localhost:${PORT}/health`);
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
