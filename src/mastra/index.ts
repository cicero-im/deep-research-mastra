import { Mastra } from '@mastra/core';
import { CloudflareDeployer } from '@mastra/deployer-cloudflare';
import { ConsoleLogger } from '@mastra/core/logger';
import { LangfuseExporter } from '@mastra/langfuse';
import { SamplingStrategyType } from './config/tracing-shim';

import { createLibSQLStore } from './config/libsql-storage';
import { researchWorkflow } from './workflows/researchWorkflow';
import { learningExtractionAgent } from './agents/learningExtractionAgent';
import { evaluationAgent } from './agents/evaluationAgent';
import { reportAgent } from './agents/reportAgent';
import { researchAgent } from './agents/researchAgent';
import { webSummarizationAgent } from './agents/webSummarizationAgent';
import { generateReportWorkflow } from './workflows/generateReportWorkflow';
import { comprehensiveResearchWorkflow } from './workflows/comprehensiveResearchWorkflow';
import { ragAgent } from './agents/ragAgent';
import { githubAgent } from './agents/githubAgent';
import { monitorAgent } from './agents/monitorAgent';
import { planningAgent } from './agents/planningAgent';
import { qualityAssuranceAgent } from './agents/qualityAssuranceAgent';
import { githubPlanningWorkflow } from './workflows/githubPlanningWorkflow';
import { githubQualityWorkflow } from './workflows/githubQualityWorkflow';
import { publisherAgent } from './agents/publisherAgent';
import { copywriterAgent } from './agents/copywriterAgent';
import { editorAgent } from './agents/editorAgent';
import { assistant } from './agents/assistant';

const logger = new ConsoleLogger({ level: 'info' });

logger.info('Starting Mastra application');

export const mastra = new Mastra({
  deployer: new CloudflareDeployer({
    name: 'deep-research-mastra-api',
    compatibility_date: '2025-05-01',
    compatibility_flags: ['nodejs_compat'],
    // Storage and vector indexes are reached via REST in libsql-storage.ts;
    // pushing creds via wrangler `secret put` keeps process.env hydrated at runtime.
  }),
  storage: createLibSQLStore(),
  agents: {
    researchAgent,
    reportAgent,
    evaluationAgent,
    learningExtractionAgent,
    webSummarizationAgent,
    ragAgent,
    githubAgent,
    monitorAgent,
    planningAgent,
    qualityAssuranceAgent,
    publisherAgent,
    copywriterAgent,
    editorAgent,
    assistant,
  },
  workflows: {
    generateReportWorkflow,
    researchWorkflow,
    comprehensiveResearchWorkflow,
    githubPlanningWorkflow,
    githubQualityWorkflow,
  },
  observability: {
    serviceName: process.env.SERVICE_NAME ?? 'mastra',
    sampling: { type: SamplingStrategyType.ALWAYS },
    exporters: [
      new LangfuseExporter({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl: process.env.LANGFUSE_BASE_URL,
        realtime: process.env.NODE_ENV === 'development',
      }),
    ],
  },
});
