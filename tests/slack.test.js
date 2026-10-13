import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import { createApp } from '../src/server.js';
import {
  createSlackAlertMessage,
  formatSlackSummaryMessage,
  verifySlackSignature,
  handleSlackInteraction
} from '../src/slack.js';

describe('Slack Interactivity & MCP Integration', () => {
  let app;
  let server;
  let baseUrl;

  before(async () => {
    app = createApp();
    await new Promise((resolve) => {
      server = app.listen(0, () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  describe('createSlackAlertMessage', () => {
    it('creates Block Kit message with interactive Analyze button', () => {
      const log = {
        level: 'error',
        service: 'billing-service',
        message: 'connection refused when connecting to postgres at 5432'
      };

      const message = createSlackAlertMessage({ log, title: 'Database Failure' });

      assert.ok(message.blocks);
      assert.equal(message.blocks[0].type, 'header');
      assert.equal(message.blocks[0].text.text, 'Database Failure');

      // Check button in actions block
      const actionBlock = message.blocks.find(b => b.type === 'actions');
      assert.ok(actionBlock);
      const button = actionBlock.elements[0];
      assert.equal(button.action_id, 'btn_analyze_log');
      assert.equal(button.type, 'button');

      const parsedValue = JSON.parse(button.value);
      assert.equal(parsedValue.service, 'billing-service');
      assert.match(parsedValue.message, /postgres/);
    });

    it('compacts huge logs to avoid Slack 2000 character button value limit', () => {
      const hugeLog = {
        level: 'error',
        service: 'payment-service',
        message: 'payment gateway timeout',
        stack: 'x'.repeat(5000),
        extraContext: 'y'.repeat(5000)
      };

      const message = createSlackAlertMessage({ log: hugeLog });
      const actionBlock = message.blocks.find(b => b.type === 'actions');
      const button = actionBlock.elements[0];
      assert.ok(button.value.length < 2000, 'Button value must be under 2000 chars');
      const parsed = JSON.parse(button.value);
      assert.equal(parsed.service, 'payment-service');
      assert.equal(parsed.message, 'payment gateway timeout');
    });
  });

  describe('formatSlackSummaryMessage', () => {
    it('formats diagnosis into rich Slack Block Kit layout', () => {
      const summary = formatSlackSummaryMessage({
        issue: 'PostgreSQL database connection refused on port 5432',
        user: { id: 'U12345', name: 'alice' },
        log: { service: 'auth-service' }
      });

      assert.equal(summary.response_type, 'in_channel');
      assert.equal(summary.replace_original, false);
      assert.ok(summary.blocks.some(b => b.text?.text?.includes('PostgreSQL')));
      assert.ok(summary.blocks.some(b => b.fields?.some(f => f.text.includes('alice'))));
    });
  });

  describe('verifySlackSignature', () => {
    const secret = 'test-signing-secret-12345';
    const now = Math.floor(Date.now() / 1000);
    const body = 'payload={"type":"block_actions"}';

    it('verifies valid HMAC-SHA256 signature', () => {
      const sigBasestring = `v0:${now}:${body}`;
      const validSig = 'v0=' + crypto.createHmac('sha256', secret).update(sigBasestring).digest('hex');

      const isValid = verifySlackSignature({
        signature: validSig,
        timestamp: String(now),
        rawBody: body,
        signingSecret: secret
      });

      assert.equal(isValid, true);
    });

    it('rejects tampered signature', () => {
      const isValid = verifySlackSignature({
        signature: 'v0=invalidhash',
        timestamp: String(now),
        rawBody: body,
        signingSecret: secret
      });

      assert.equal(isValid, false);
    });

    it('rejects expired timestamp (> 5 minutes old)', () => {
      const oldTime = now - 400; // 400 seconds ago
      const sigBasestring = `v0:${oldTime}:${body}`;
      const validSig = 'v0=' + crypto.createHmac('sha256', secret).update(sigBasestring).digest('hex');

      const isValid = verifySlackSignature({
        signature: validSig,
        timestamp: String(oldTime),
        rawBody: body,
        signingSecret: secret
      });

      assert.equal(isValid, false);
    });
  });

  describe('HTTP API: POST /slack/create-alert', () => {
    it('returns generated Block Kit alert message', async () => {
      const res = await fetch(`${baseUrl}/slack/create-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          log: {
            level: 'error',
            message: 'redis connection refused on port 6379'
          },
          title: 'Cache Error'
        })
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.message.blocks);
      assert.equal(data.message.blocks[0].text.text, 'Cache Error');
    });

    it('returns 400 when log object is missing', async () => {
      const res = await fetch(`${baseUrl}/slack/create-alert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });

      assert.equal(res.status, 400);
    });
  });

  describe('HTTP API: POST /slack/interactions', () => {
    it('handles synchronous button action (?sync=true) and diagnoses log', async () => {
      const slackPayload = {
        type: 'block_actions',
        user: { id: 'U999', name: 'bob' },
        actions: [
          {
            action_id: 'btn_analyze_log',
            value: JSON.stringify({
              level: 'fatal',
              message: 'OutOfMemoryError: Java heap space'
            })
          }
        ]
      };

      const res = await fetch(`${baseUrl}/slack/interactions?sync=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ payload: JSON.stringify(slackPayload) }).toString()
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.match(data.issue, /heap space/i);
    });

    it('asynchronously responds 200 immediately and delivers diagnosis to response_url', async () => {
      // 1. Create a lightweight mock HTTP server simulating Slack's response_url
      let receivedSlackSummary = null;
      const mockSlackServer = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
          receivedSlackSummary = JSON.parse(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      });

      const mockPort = await new Promise(resolve => {
        mockSlackServer.listen(0, () => resolve(mockSlackServer.address().port));
      });
      const mockResponseUrl = `http://127.0.0.1:${mockPort}/mock-slack-response`;

      try {
        const slackPayload = {
          type: 'block_actions',
          user: { id: 'U1001', name: 'charlie' },
          response_url: mockResponseUrl,
          actions: [
            {
              action_id: 'btn_analyze_log',
              value: JSON.stringify({
                level: 'error',
                message: 'MongoDB server selection timed out on port 27017'
              })
            }
          ]
        };

        // 2. Trigger Slack interaction endpoint
        const startTime = Date.now();
        const res = await fetch(`${baseUrl}/slack/interactions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ payload: JSON.stringify(slackPayload) }).toString()
        });

        // 3. Must acknowledge immediately (< 3 seconds)
        assert.equal(res.status, 200);
        assert.ok(Date.now() - startTime < 1000, 'Immediate acknowledgment');

        // 4. Wait for background processing to dispatch summary to response_url
        for (let i = 0; i < 20; i++) {
          if (receivedSlackSummary) break;
          await new Promise(r => setTimeout(r, 50));
        }

        assert.ok(receivedSlackSummary, 'Slack response_url must receive summary');
        assert.equal(receivedSlackSummary.response_type, 'in_channel');
        assert.ok(receivedSlackSummary.blocks.length >= 3);
        const causeBlock = receivedSlackSummary.blocks.find(b => b.text?.text?.includes('Probable Root Cause'));
        assert.ok(causeBlock);
        assert.match(causeBlock.text.text, /mongodb/i);
      } finally {
        await new Promise(resolve => mockSlackServer.close(resolve));
      }
    });

    it('returns 400 for invalid interaction payload', async () => {
      const res = await fetch(`${baseUrl}/slack/interactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invalid: 'payload' })
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /invalid payload/i);
    });
  });
});
