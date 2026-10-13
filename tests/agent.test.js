import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeLog } from '../src/agent.js';
import { createMcpServer } from '../src/mcp-server.js';

describe('AI Agent Log Analysis', () => {
  it('identifies timeout issues concisely', async () => {
    const issue = await analyzeLog({
      timestamp: '2026-10-13T07:15:00Z',
      error: 'connect ETIMEDOUT 10.0.1.25:443'
    });
    assert.match(issue, /timeout/i);
    assert.ok(issue.length < 150, 'Issue must be concise');
  });

  it('identifies rate limit errors', async () => {
    const issue = await analyzeLog({
      statusCode: 429,
      error: 'Too Many Requests: rate limit exceeded for client_id 987'
    });
    assert.match(issue, /429|rate limit/i);
  });

  it('identifies DNS resolution failures', async () => {
    const issue = await analyzeLog({
      code: 'ENOTFOUND',
      syscall: 'getaddrinfo',
      hostname: 'api.internal.service'
    });
    assert.match(issue, /dns|enotfound/i);
  });

  it('identifies disk space exhaustion', async () => {
    const issue = await analyzeLog({
      code: 'ENOSPC',
      message: 'write error: no space left on device'
    });
    assert.match(issue, /disk|enospc/i);
  });

  it('handles stack trace in error field', async () => {
    const issue = await analyzeLog({
      name: 'TypeError',
      stack: 'TypeError: Cannot read properties of undefined (reading "id")\n    at getUser (/app/src/user.js:42:15)'
    });
    assert.match(issue, /null or undefined/i);
  });
});

describe('MCP Server Registration', () => {
  it('creates an MCP server instance with analyze_log tool', () => {
    const mcp = createMcpServer();
    assert.ok(mcp);
    assert.equal(mcp.server._serverInfo.name, 'log-analyzer-mcp-server');
    assert.ok(mcp._registeredTools['analyze_log'], 'analyze_log tool must be registered');
  });
});
