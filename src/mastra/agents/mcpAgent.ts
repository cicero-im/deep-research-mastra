// MCP integration was rebuilt in Mastra v1: MCPClient.getTools() and
// Agent.tools (as a property) were removed. The original implementation pulled
// tools at agent-construction time over HTTP to a sibling MCP server, which
// also doesn't fit the Cloudflare Workers runtime cleanly. We keep this file
// as an inert export so other files importing from it (none today) still
// resolve, but the agent isn't registered with Mastra anymore.
export const mcpServer = null;
