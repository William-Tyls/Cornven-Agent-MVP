import './cli-environment.js';
import { CachedSemanticProvider } from './embedding-cache.js';
import { createEmbeddingProvider } from './embeddings.js';
import { DocumentsService } from './documents.service.js';
import { writeIndexSnapshot } from './index-snapshot.js';
const reuseCache = process.argv.includes('--reuse-semantic-cache');
const provider = reuseCache ? await CachedSemanticProvider.create(false) : undefined;
if (provider && createEmbeddingProvider(process.env).id !== provider.id)
  throw new Error('Configured provider must match the approved semantic cache.');
const index = await new DocumentsService(
  provider ? { embeddingProvider: provider } : {},
).buildIndex();
await writeIndexSnapshot(index);
console.log(`Memory index published: ${index.chunks.length} chunks; ${index.identity}`);
