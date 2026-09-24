import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerTools, INTEGRATION_GUIDE_STATIC_TEXT } from './tools.js';

// @article topic:mcp-server
// 獨立的 subprocess 入口，不跟 src/server.ts（Express）共用同一個 process
// ——理由見 docs/requirements/07-mcp-server.md「架構決定」：MCP server 只
// 透過 /admin/* REST API 操作，不直接碰 DB，避免跟 Express process 各自
// 獨立的 adapter cache 互相不通步。這代表跑這支程式前，Express backend
// （npm run start）必須已經在跑。
const server = new McpServer(
  { name: 'personal-llm-router', version: '0.1.0' },
  { instructions: INTEGRATION_GUIDE_STATIC_TEXT },
);

registerTools(server);

const transport = new StdioServerTransport();
await server.connect(transport);
