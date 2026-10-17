import { D1Store } from '@mastra/cloudflare-d1';
import { CloudflareVector } from '@mastra/vectorize';
import { Memory } from '@mastra/memory';
import { embedMany } from 'ai';
import { ConsoleLogger } from '@mastra/core/logger';
import { google } from '@ai-sdk/google';
import type { UIMessage } from 'ai';
import z from 'zod';

const logger = new ConsoleLogger({ name: 'storage', level: 'info' });

export type TracingSpanInput = { type: string; name: string; input?: Record<string, unknown> };
export type SpanEndInput = { output?: Record<string, unknown>; metadata?: Record<string, unknown> };

export interface QueryResult {
  id: string;
  score: number;
  metadata: Record<string, unknown>;
  document?: string;
  vector?: number[];
}

export interface Message {
  id?: string;
  role?: 'user' | 'assistant' | 'system' | 'data';
  content?: string;
  createdAt?: string | number | Date;
  threadId?: string;
}

export const STORAGE_CONFIG = {
  DEFAULT_DIMENSION: 1536,
  DEFAULT_DATABASE_URL: 'file:./deep-research.db',
  VECTOR_DATABASE_URL: 'file:./vector-store.db',
  VECTOR_INDEXES: {
    RESEARCH_DOCUMENTS: 'research_documents',
    WEB_CONTENT: 'web_content',
    LEARNINGS: 'learnings',
    REPORTS: 'reports',
  },
} as const;

const userProfileSchema = z.object({
  name: z.string().optional(),
  location: z.string().optional(),
  timezone: z.string().optional(),
  preferences: z
    .object({
      communicationStyle: z.string().optional(),
      projectGoal: z.string().optional(),
      deadlines: z.array(z.string()).optional(),
    })
    .optional(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

function readCfConfig() {
  // Cloudflare runs an upload-time preflight that boots the Worker without
  // secrets; D1Store/CloudflareVector throw on empty creds, which would block
  // the deploy. Fall back to placeholder values so the constructors succeed —
  // real calls still fail at runtime if creds are missing, but the Worker can
  // boot long enough for the secrets to be applied.
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID ?? process.env.CF_ACCOUNT_ID ?? 'preflight';
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.CF_API_TOKEN ?? 'preflight';
  const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID ?? process.env.CF_D1_DATABASE_ID ?? '00000000-0000-0000-0000-000000000000';
  return { accountId, apiToken, databaseId };
}

let _store: D1Store | undefined;
export const createLibSQLStore = (_tracingContext?: unknown) => {
  if (_store) return _store;
  const { accountId, apiToken, databaseId } = readCfConfig();
  try {
    _store = new D1Store({ id: 'deep-research', accountId, apiToken, databaseId, disableInit: true });
  } catch (err) {
    logger.error('D1Store init failed; returning a fallback that will fail on first real query', {
      error: err instanceof Error ? err.message : String(err),
    });
    _store = new D1Store({
      id: 'deep-research',
      accountId: 'preflight',
      apiToken: 'preflight',
      databaseId: '00000000-0000-0000-0000-000000000000',
      disableInit: true,
    });
  }
  return _store;
};

let _vector: CloudflareVector | undefined;
export const createLibSQLVectorStore = (_tracingContext?: unknown) => {
  if (_vector) return _vector;
  const { accountId, apiToken } = readCfConfig();
  try {
    _vector = new CloudflareVector({ id: 'deep-research-vec', accountId, apiToken });
  } catch (err) {
    logger.error('CloudflareVector init failed; returning a fallback', {
      error: err instanceof Error ? err.message : String(err),
    });
    _vector = new CloudflareVector({ id: 'deep-research-vec', accountId: 'preflight', apiToken: 'preflight' });
  }
  return _vector;
};

export const initializeVectorIndexes = async () => {
  const v = createLibSQLVectorStore();
  for (const indexName of Object.values(STORAGE_CONFIG.VECTOR_INDEXES)) {
    try {
      await v.createIndex({ indexName, dimension: STORAGE_CONFIG.DEFAULT_DIMENSION });
    } catch (err) {
      logger.warn('createIndex failed (likely already exists)', {
        indexName,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
};

export const searchSimilarContent = async (
  query: string,
  indexName: string,
  topK = 5,
  _tracingContext?: unknown,
) => {
  try {
    const v = createLibSQLVectorStore();
    const embedder = google.textEmbedding('gemini-embedding-001');
    const embedRes = (await embedMany({ values: [query], model: embedder })) as
      | { embeddings?: number[][] }
      | number[][];
    const embeddings: number[][] = Array.isArray(embedRes)
      ? (embedRes as number[][])
      : ((embedRes as { embeddings?: number[][] }).embeddings ?? []);
    const queryVector = embeddings[0];
    if (!queryVector) return [] as QueryResult[];
    const results = (await v.query({ indexName, queryVector, topK })) as QueryResult[];
    return results;
  } catch (err) {
    logger.error('searchSimilarContent failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return [] as QueryResult[];
  }
};

export const createResearchMemory = () =>
  new Memory({
    storage: createLibSQLStore(),
    vector: createLibSQLVectorStore(),
    embedder: google.textEmbedding('gemini-embedding-001'),
    options: {
      lastMessages: 500,
      workingMemory: {
        enabled: true,
        template:
          '# Agent Memory Context\n- **User Task**: Research summary, analysis, recommendations.\n- **Target Audience**\n- **Key Findings**\n- **User Goals**\n- **Process**\n- **Previous Interactions**\n- **Client Requirements**\n- **Agent Notepad**\n',
      },
      semanticRecall: { topK: 5, messageRange: 3, scope: 'thread' },
      generateTitle: true,
    },
  });

export const createReportMemory = () =>
  new Memory({
    storage: createLibSQLStore(),
    vector: createLibSQLVectorStore(),
    embedder: google.textEmbedding('gemini-embedding-001'),
    options: {
      lastMessages: 100,
      workingMemory: {
        enabled: true,
        template:
          '# Report Generation Context\n- **Report Type**\n- **Target Audience**\n- **Key Findings**\n- **Structure Preferences**\n- **Citation Style**\n- **Previous Reports**\n- **Client Requirements**',
      },
      semanticRecall: { topK: 10, messageRange: 3, scope: 'resource' },
      generateTitle: true,
    },
  });

export interface ExtractParams {
  title?: boolean | { summaries?: Array<'self' | 'prev' | 'next'>; nodeTemplate?: string; combineTemplate?: string };
  summary?: boolean | { summaries?: Array<'self' | 'prev' | 'next'>; promptTemplate?: string };
  keywords?: boolean | { keywords?: number; promptTemplate?: string };
  questions?: boolean | { questions?: number; promptTemplate?: string; embeddingOnly?: boolean };
}

export class VectorStoreError extends Error {
  public operation: string;
  public context: Record<string, unknown>;
  constructor(message: string, operation: string, context: Record<string, unknown> = {}) {
    super(message);
    this.name = 'VectorStoreError';
    this.operation = operation;
    this.context = context;
  }
}

export async function upsertVectors(
  indexName: string,
  vectors: ReadonlyArray<readonly number[]>,
  metadata: ReadonlyArray<Record<string, unknown>>,
  ids: readonly string[],
  _tracingContext?: unknown,
): Promise<{ success: boolean; count?: number; error?: string }> {
  try {
    const v = createLibSQLVectorStore();
    await v.upsert({
      indexName,
      vectors: vectors.map((row) => Array.from(row)),
      metadata: metadata.map((m) => ({ ...m })),
      ids: Array.from(ids),
    });
    return { success: true, count: vectors.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new VectorStoreError(message, 'upsert_vectors', { indexName, vectorCount: vectors.length });
  }
}

export async function createVectorIndex(
  indexName: string,
  dimension = STORAGE_CONFIG.DEFAULT_DIMENSION,
  metric: 'cosine' | 'euclidean' | 'dotproduct' = 'cosine',
  _tracingContext?: unknown,
): Promise<{ success: boolean; error?: string }> {
  try {
    const v = createLibSQLVectorStore();
    await v.createIndex({ indexName, dimension, metric });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new VectorStoreError(message, 'create_vector_index', { indexName, dimension, metric });
  }
}

export async function queryVectors(
  indexName: string,
  queryVector: readonly number[],
  topK = 5,
  filter?: Record<string, unknown>,
  includeVector = false,
  _tracingContext?: unknown,
): Promise<QueryResult[]> {
  try {
    const v = createLibSQLVectorStore();
    const results = (await v.query({
      indexName,
      queryVector: Array.from(queryVector),
      topK,
      filter: filter as never,
      includeVector,
    })) as QueryResult[];
    return results.map((r) => ({ id: r.id, score: r.score, metadata: r.metadata ?? {} }));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    throw new VectorStoreError(message, 'query_vectors', { indexName, topK });
  }
}

export async function searchMemoryMessages(
  _memory: Readonly<Memory>,
  threadId: string,
  query: string,
  topK = 5,
): Promise<{ messages: Message[]; uiMessages: UIMessage[] }> {
  logger.info('searchMemoryMessages called (stub in v1)', { threadId, queryLength: query.length, topK });
  return { messages: [], uiMessages: [] };
}

// Eager init at module scope is forbidden in CF Workers (random IDs / I/O).
// Lazily expose the vector store via a getter so consumers still see a value
// when they touch the module, but no work happens until the first access.
export const upstashVector = new Proxy({} as ReturnType<typeof createLibSQLVectorStore>, {
  get(_t, prop) {
    const v = createLibSQLVectorStore();
    return Reflect.get(v as object, prop);
  },
});

export interface ChunkWithMetadata {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
}

export function extractChunkMetadata(
  chunks: ChunkWithMetadata[],
  extractParams: ExtractParams,
): ChunkWithMetadata[] {
  return chunks.map((chunk, index) => {
    const enhanced: Record<string, unknown> = { ...chunk.metadata };
    if (extractParams.title) {
      const firstLine = chunk.content.split('\n')[0]?.trim();
      const firstSentence = chunk.content.split(/[.!?]/)[0]?.trim();
      enhanced.extractedTitle = firstLine || firstSentence || `Chunk ${index + 1}`;
    }
    if (extractParams.summary) {
      enhanced.extractedSummary = `${chunk.content.substring(0, 100)}...`;
    }
    if (extractParams.keywords) {
      const words = chunk.content.toLowerCase().match(/\b\w{4,}\b/g) ?? [];
      const wordCount: Record<string, number> = {};
      for (const w of words) wordCount[w] = (wordCount[w] || 0) + 1;
      enhanced.extractedKeywords = Object.entries(wordCount)
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5)
        .map(([w]) => w);
    }
    if (extractParams.questions) {
      enhanced.extractedQuestions = chunk.content
        .split(/[.!?]/)
        .map((s) => s.trim())
        .filter((s) => s.endsWith('?'))
        .slice(0, 3);
    }
    return { ...chunk, metadata: enhanced };
  });
}
