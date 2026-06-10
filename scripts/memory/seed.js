'use strict';

/**
 * One-time seeding script: fetches PRs from a GitHub repo for the past N days,
 * batches embeddings, and stores them in the Redis memory index.
 *
 * Usage:
 *   GITHUB_TOKEN=...  REDIS_URL=...  OPENAI_API_KEY=...  \
 *   SEED_REPO=redis/docs  DAYS_BACK=365  node scripts/memory/seed.js
 *
 * Optional env vars:
 *   SEED_REPO        — repo to fetch from (default: redis/docs)
 *   DAYS_BACK        — how many days of history to seed (default: 365)
 *   EMBEDDING_MODEL  — embedding model (default: text-embedding-3-small)
 *   DRY_RUN=true     — fetch and embed but do not write to Redis
 */

const { createClient, SchemaFieldTypes, VectorAlgorithms } = require('redis');
const OpenAI = require('openai');

const SEED_REPO     = process.env.SEED_REPO     || 'redis/docs';
const DAYS_BACK     = parseInt(process.env.DAYS_BACK) || 365;
const EMBED_MODEL   = process.env.EMBEDDING_MODEL || 'text-embedding-3-small';
const VECTOR_DIM    = 1536;
const BATCH_SIZE    = 100; // embeddings per OpenAI call
const INDEX_NAME    = 'repo_memory_idx';
const KEY_PREFIX    = 'memory:';
const DRY_RUN       = process.env.DRY_RUN === 'true';

async function fetchPRs(repo, cutoff, token) {
  const [owner, name] = repo.split('/');
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };

  const prs = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${name}/pulls?state=all&sort=created&direction=desc&per_page=100&page=${page}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);

    const batch = await res.json();
    if (!batch.length) break;

    let done = false;
    for (const pr of batch) {
      if (new Date(pr.created_at) < cutoff) { done = true; break; }
      prs.push({
        id:         `${repo.replace('/', '_')}_pr_${pr.number}`,
        type:       'pr_summary',
        repo,
        title:      pr.title,
        bodySummary: (pr.body || '').slice(0, 500),
        sourceUrl:  pr.html_url,
        createdAt:  pr.created_at,
        tags:       (pr.labels || []).map(l => l.name).join(','),
        searchText: `${pr.title}\n${(pr.body || '').slice(0, 1000)}`,
      });
    }

    console.log(`  page ${page}: fetched ${batch.length} PRs, kept ${prs.length} total`);
    if (done || batch.length < 100) break;
    page++;
  }

  return prs;
}

async function embedBatch(texts, openai) {
  const res = await openai.embeddings.create({ model: EMBED_MODEL, input: texts });
  return res.data.map(d => d.embedding);
}

async function ensureIndex(client) {
  const exists = await client.ft.info(INDEX_NAME).then(() => true).catch(() => false);
  if (exists) return;
  await client.ft.create(
    INDEX_NAME,
    {
      type:         { type: SchemaFieldTypes.TAG },
      repo:         { type: SchemaFieldTypes.TAG },
      title:        { type: SchemaFieldTypes.TEXT, WEIGHT: 2 },
      body_summary: { type: SchemaFieldTypes.TEXT },
      source_url:   { type: SchemaFieldTypes.TEXT, NOSTEM: true },
      created_at:   { type: SchemaFieldTypes.TEXT },
      tags:         { type: SchemaFieldTypes.TAG, SEPARATOR: ',' },
      embedding: {
        type:            SchemaFieldTypes.VECTOR,
        ALGORITHM:       VectorAlgorithms.HNSW,
        TYPE:            'FLOAT32',
        DIM:             VECTOR_DIM,
        DISTANCE_METRIC: 'COSINE',
      },
    },
    { ON: 'HASH', PREFIX: KEY_PREFIX }
  );
  console.log(`Created index: ${INDEX_NAME}`);
}

async function main() {
  const token    = process.env.GITHUB_TOKEN;
  const redisUrl = process.env.REDIS_URL;
  const openaiKey = process.env.OPENAI_API_KEY;

  if (!token)    { console.error('GITHUB_TOKEN is required'); process.exit(1); }
  if (!redisUrl) { console.error('REDIS_URL is required');    process.exit(1); }
  if (!openaiKey){ console.error('OPENAI_API_KEY is required'); process.exit(1); }

  const cutoff = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);
  console.log(`Seeding from ${SEED_REPO}, past ${DAYS_BACK} days (since ${cutoff.toISOString().slice(0, 10)})`);
  if (DRY_RUN) console.log('DRY RUN — no writes to Redis');

  console.log('\nFetching PRs from GitHub...');
  const prs = await fetchPRs(SEED_REPO, cutoff, token);
  console.log(`Total PRs to seed: ${prs.length}`);

  if (!prs.length) { console.log('Nothing to seed.'); return; }

  const openai = new OpenAI({ apiKey: openaiKey });

  // Embed in batches
  console.log(`\nEmbedding in batches of ${BATCH_SIZE}...`);
  const embeddings = [];
  for (let i = 0; i < prs.length; i += BATCH_SIZE) {
    const slice = prs.slice(i, i + BATCH_SIZE);
    const vecs  = await embedBatch(slice.map(p => p.searchText), openai);
    embeddings.push(...vecs);
    console.log(`  embedded ${Math.min(i + BATCH_SIZE, prs.length)}/${prs.length}`);
  }

  if (DRY_RUN) {
    console.log('\nDry run complete — skipping Redis writes.');
    return;
  }

  // Write to Redis
  const client = createClient({ url: redisUrl });
  client.on('error', err => console.error('Redis error:', err.message));
  await client.connect();

  try {
    await ensureIndex(client);

    console.log('\nWriting to Redis...');
    let written = 0;
    for (let i = 0; i < prs.length; i++) {
      const pr  = prs[i];
      const vec = embeddings[i];
      const buf = Buffer.from(new Float32Array(vec).buffer);

      await client.hSet(`${KEY_PREFIX}${pr.id}`, {
        id:           pr.id,
        type:         pr.type,
        repo:         pr.repo,
        title:        pr.title,
        body_summary: pr.bodySummary,
        source_url:   pr.sourceUrl,
        created_at:   pr.createdAt,
        tags:         pr.tags,
        embedding:    buf,
      });
      written++;
      if (written % 100 === 0) console.log(`  wrote ${written}/${prs.length}`);
    }

    console.log(`\nDone. Seeded ${written} PRs from ${SEED_REPO} into ${INDEX_NAME}.`);
  } finally {
    await client.quit();
  }
}

main().catch(err => {
  console.error('Seed failed:', err.message);
  process.exit(1);
});
