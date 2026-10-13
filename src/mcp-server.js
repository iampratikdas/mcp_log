import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import { analyzeLog } from './agent.js';

/**
 * Creates and configures the Model Context Protocol (MCP) server.
 * Registers the 'analyze_log' tool which accepts a JSON log object
 * and returns the AI-diagnosed probable issue.
 *
 * @returns {McpServer}
 */
export function createMcpServer() {
  const server = new McpServer({
    name: 'log-analyzer-mcp-server',
    version: '1.0.0'
  });

  server.tool(
    'analyze_log',
    'Analyzes a JSON log object and returns the probable issue',
    {
      log: z.record(z.any()).describe('The JSON log object containing error or event details to analyze')
    },
    async ({ log }) => {
      try {
        const issue = await analyzeLog(log);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ issue })
            }
          ]
        };
      } catch (error) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({ error: 'Failed to analyze log', message: error.message })
            }
          ]
        };
      }
    }
  );

  return server;
}

// Start stdio transport if executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const mcpServer = createMcpServer();
  const transport = new StdioServerTransport();

  mcpServer.connect(transport).then(() => {
    // Note: Diagnostics must be logged to stderr in stdio MCP mode
    console.error('[MCP Server] Log Analyzer MCP Server running on stdio');
  }).catch((err) => {
    console.error('[MCP Server] Fatal initialization error:', err);
    process.exit(1);
  });
}
