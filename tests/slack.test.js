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

  // Helper to generate Slack HMAC signature headers if SLACK_SIGNING_SECRET is active
  function getAuthHeaders(body) {
    const secret = process.env.SLACK_SIGNING_SECRET;
    if (!secret) return {};
    const timestamp = String(Math.floor(Date.now() / 1000));
    const sigBasestring = `v0:${timestamp}:${body}`;
    const signature = 'v0=' + crypto.createHmac('sha256', secret).update(sigBasestring).digest('hex');
    return {
      'x-slack-signature': signature,
      'x-slack-request-timestamp': timestamp
    };
  }

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
    it('formats diagnosis into rich Slack Block Kit layout with target channel', () => {
      const summary = formatSlackSummaryMessage({
        issue: 'PostgreSQL database connection refused on port 5432',
        user: { id: 'U12345', name: 'alice' },
        log: { service: 'auth-service' },
        channel: 'C123456789'
      });

      assert.equal(summary.response_type, 'in_channel');
      assert.equal(summary.replace_original, false);
      assert.equal(summary.channel, 'C123456789');
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

  describe('handleSlackInteraction with channel targeting', () => {
    it('posts directly to channel using chat.postMessage when botToken is provided', async () => {
      let postedToChannelPayload = null;
      const mockFetch = async (url, opts) => {
        if (url === 'https://slack.com/api/chat.postMessage') {
          postedToChannelPayload = JSON.parse(opts.body);
          return {
            ok: true,
            status: 200,
            json: async () => ({ ok: true, ts: '1700000000.000100' })
          };
        }
        return { ok: true, status: 200, json: async () => ({ ok: true }) };
      };

      const result = await handleSlackInteraction(
        {
          type: 'block_actions',
          user: { id: 'U111', name: 'dave' },
          channel: { id: 'C999888' },
          container: { message_ts: '1700000000.000050' },
          actions: [
            {
              action_id: 'btn_analyze_log',
              value: JSON.stringify({ level: 'error', message: 'connection refused on port 5432' })
            }
          ]
        },
        {
          fetchFn: mockFetch,
          botToken: 'xoxb-mock-token'
        }
      );

      assert.equal(result.success, true);
      assert.equal(result.channelId, 'C999888');
      assert.equal(result.postedToChannel, true);
      assert.ok(postedToChannelPayload);
      assert.equal(postedToChannelPayload.channel, 'C999888');
      assert.equal(postedToChannelPayload.thread_ts, '1700000000.000050');
      assert.ok(postedToChannelPayload.blocks);
    });
  });

  describe('HTTP API: POST /slack/interactions', () => {
    it('handles synchronous button action (?sync=true) and diagnoses log', async () => {
      const slackPayload = {
        type: 'block_actions',
        user: { id: 'U999', name: 'bob' },
        channel: { id: 'C123456' },
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

      const bodyStr = new URLSearchParams({ payload: JSON.stringify(slackPayload) }).toString();
      const authHeaders = getAuthHeaders(bodyStr);

      const res = await fetch(`${baseUrl}/slack/interactions?sync=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          ...authHeaders
        },
        body: bodyStr
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.channelId, 'C123456');
      assert.match(data.issue, /heap space/i);
    });

    it('asynchronously responds 200 immediately and delivers diagnosis with channel to response_url', async () => {
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
          channel: { id: 'C987654' },
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

        const bodyStr = new URLSearchParams({ payload: JSON.stringify(slackPayload) }).toString();
        const authHeaders = getAuthHeaders(bodyStr);

        // 2. Trigger Slack interaction endpoint
        const startTime = Date.now();
        const res = await fetch(`${baseUrl}/slack/interactions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...authHeaders
          },
          body: bodyStr
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
        assert.equal(receivedSlackSummary.channel, 'C987654');
        assert.equal(receivedSlackSummary.response_type, 'in_channel');
        assert.ok(receivedSlackSummary.blocks.length >= 3);
        const causeBlock = receivedSlackSummary.blocks.find(b => b.text?.text?.includes('Probable Root Cause'));
        assert.ok(causeBlock);
        assert.match(causeBlock.text.text, /mongodb/i);
      } finally {
        await new Promise(resolve => mockSlackServer.close(resolve));
      }
    });

    it('handles url_verification challenge handshake when sent to /slack/interactions', async () => {
      const payload = {
        type: 'url_verification',
        token: 'test_token',
        challenge: 'interactions_verify_challenge_999'
      };

      const bodyStr = JSON.stringify(payload);
      const authHeaders = getAuthHeaders(bodyStr);

      const res = await fetch(`${baseUrl}/slack/interactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: bodyStr
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.challenge, 'interactions_verify_challenge_999');
    });

    it('returns 400 for invalid interaction payload', async () => {
      const bodyStr = JSON.stringify({ invalid: 'payload' });
      const authHeaders = getAuthHeaders(bodyStr);

      const res = await fetch(`${baseUrl}/slack/interactions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: bodyStr
      });

      assert.equal(res.status, 400);
      const data = await res.json();
      assert.match(data.error, /invalid payload/i);
    });
  });

  describe('Slack Events API: POST /slack/events & app_mention', () => {
    it('handles url_verification challenge handshake', async () => {
      const payload = {
        type: 'url_verification',
        token: 'test_token',
        challenge: 'verify_me_123456789'
      };

      const bodyStr = JSON.stringify(payload);
      const authHeaders = getAuthHeaders(bodyStr);

      const res = await fetch(`${baseUrl}/slack/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: bodyStr
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.challenge, 'verify_me_123456789');
    });

    it('processes app_mention event and replies with API response to channel and thread', async () => {
      let postedMessage = null;
      const mockClient = {
        chat: {
          postMessage: async (msg) => {
            postedMessage = msg;
            return { ok: true, status: 200 };
          }
        }
      };

      const appMentionEvent = {
        type: 'app_mention',
        user: 'U456',
        channel: 'C789',
        ts: '1700000000.000200',
        thread_ts: '1700000000.000100',
        text: '<@U_BOT_123> connection refused when connecting to postgres at 5432'
      };

      const bodyStr = JSON.stringify({
        type: 'event_callback',
        event: appMentionEvent
      });
      const authHeaders = getAuthHeaders(bodyStr);

      const res = await fetch(`${baseUrl}/slack/events?sync=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: bodyStr
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ok, true);
      assert.equal(data.channel, 'C789');
      assert.equal(data.thread_ts, '1700000000.000100');
      assert.match(data.result, /postgres/i);
    });

    it('ignores bot messages to prevent recursive reply loops', async () => {
      const botEvent = {
        type: 'app_mention',
        bot_id: 'B999',
        subtype: 'bot_message',
        channel: 'C789',
        text: 'Self mention'
      };

      const bodyStr = JSON.stringify({
        type: 'event_callback',
        event: botEvent
      });
      const authHeaders = getAuthHeaders(bodyStr);

      const res = await fetch(`${baseUrl}/slack/events?sync=true`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...authHeaders
        },
        body: bodyStr
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.ignored, true);
    });
  });
});
