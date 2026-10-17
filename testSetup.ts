// Mastra v1 dropped `attachListeners` from @mastra/evals; the per-test eval
// hookup is gone. The file stays so vitest's setupFiles config still resolves.
import { beforeAll } from 'vitest';

beforeAll(async () => {});
