import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

const manifestUrl = new URL('../data/rag/sources.json', import.meta.url);
const manifestRootUrl = new URL('./', manifestUrl);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));

for (const document of manifest.documents ?? []) {
  const sourceUrl = new URL(document.file, manifestRootUrl);
  if (!sourceUrl.href.startsWith(manifestRootUrl.href)) {
    throw new Error(`RAG source must stay inside data/rag: ${document.file}`);
  }
  const content = await readFile(sourceUrl, 'utf8');
  document.checksum = createHash('sha256').update(content).digest('hex');
}

await writeFile(manifestUrl, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Updated checksums for ${manifest.documents.length} RAG source documents.`);
