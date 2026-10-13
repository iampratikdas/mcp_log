import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';

describe('Log Analyzer MCP Server - HTTP API', () => {
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

  it('GET /health should return 200 OK', async () => {
    const res = await fetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'ok');
  });

  it('POST /analyze-log should return 200 and { issue: "..." } for valid database error log', async () => {
    const payload = {
      timestamp: '2026-10-13T07:00:00Z',
      level: 'error',
      service: 'user-service',
      message: 'connection refused when connecting to postgres at 5432'
    };

    const res = await fetch(`${baseUrl}/analyze-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.issue, 'Response must contain an "issue" property');
    assert.match(data.issue, /postgres/i);
    assert.match(data.issue, /5432/);
  });

  it('POST /analyze-log should handle memory exhaustion log', async () => {
    const payload = {
      level: 'fatal',
      error: 'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory'
    };

    const res = await fetch(`${baseUrl}/analyze-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.issue);
    assert.match(data.issue, /heap/i);
  });

  it('POST /analyze-log should handle wrapped { log: { ... } } format', async () => {
    const payload = {
      log: {
        timestamp: '2026-10-13T07:10:00Z',
        level: 'warn',
        message: 'jwt expired at 1700000000'
      }
    };

    const res = await fetch(`${baseUrl}/analyze-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.issue);
    assert.match(data.issue, /jwt/i);
  });

  it('POST /analyze-log should return 400 for malformed JSON syntax', async () => {
    const malformedJson = '{"level": "error", "message": unquoted_value}';

    const res = await fetch(`${baseUrl}/analyze-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: malformedJson
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'Invalid JSON input');
    assert.ok(data.message, 'Error should include details');
  });

  it('POST /analyze-log should return 400 for empty request body', async () => {
    const res = await fetch(`${baseUrl}/analyze-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: ''
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'Invalid JSON input');
  });

  it('POST /analyze-log should return 400 for empty object {}', async () => {
    const res = await fetch(`${baseUrl}/analyze-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'Invalid JSON input');
  });

  it('POST /analyze-log should return 400 for JSON array instead of object', async () => {
    const res = await fetch(`${baseUrl}/analyze-log`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['not', 'an', 'object'])
    });

    assert.equal(res.status, 400);
    const data = await res.json();
    assert.equal(data.error, 'Invalid JSON input');
  });
});
