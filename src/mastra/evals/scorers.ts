// Mastra v1 dropped the standalone @mastra/core/scores module that the original
// 0.x version of this file used. The custom scorers below were never wired into
// any agent/workflow, so we keep the file as inert exports to preserve
// compatibility with anything that imports the names elsewhere.
export const customRelevancyScorer = null;
export const customToxicityScorer = null;
export const customFaithfulnessScorer = null;
