// Compatibility shim for code that referenced @mastra/core/ai-tracing in 0.x.
// Mastra v1 removed the bespoke AI-tracing namespace; observability is now driven
// through OTel + Langfuse. This shim keeps existing call sites compiling without
// pulling in a removed subpath. The values are inert string tokens.
export const AISpanType = {
  GENERIC: 'generic',
} as const;

export type AISpanType = (typeof AISpanType)[keyof typeof AISpanType];

// SamplingStrategyType moved to @mastra/core/observability in v1; re-export so
// callers that imported it from the old ai-tracing path keep working.
export { SamplingStrategyType } from '@mastra/core/observability';
