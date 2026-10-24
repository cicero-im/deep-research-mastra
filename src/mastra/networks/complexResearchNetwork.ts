// Mastra v1 dropped `NewAgentNetwork`. Multi-agent orchestration now lives on
// the Agent class itself (via sub-agents/tool delegation). This file used to
// register a `vnext_networks` entry; it's kept as a no-op export so existing
// imports don't break, but the network is no longer wired into Mastra.
export const complexResearchNetwork = null;
