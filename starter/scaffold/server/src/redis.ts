import { Redis } from 'ioredis';
import { config } from './config.js';

let client: Redis | undefined;

export async function connectRedis(): Promise<Redis> {
  if (!client) {
    client = new Redis(config.redisUrl, {
      lazyConnect: true,
      maxRetriesPerRequest: 2,
      retryStrategy: (attempt) => (attempt <= 5 ? Math.min(attempt * 200, 1000) : null),
    });
  }
  if (client.status === 'wait') await client.connect();
  await client.ping();
  return client;
}

export function getRedis(): Redis {
  if (!client || client.status !== 'ready') {
    throw new Error('Redis is not connected');
  }
  return client;
}

export async function clearApplicationRedisData(): Promise<void> {
  const redis = getRedis();
  let cursor = '0';
  do {
    const [nextCursor, keys] = await redis.scan(cursor, 'MATCH', 'switchboard:*', 'COUNT', 100);
    cursor = nextCursor;
    if (keys.length > 0) await redis.del(...keys);
  } while (cursor !== '0');
}

export async function closeRedis(): Promise<void> {
  if (client) {
    if (client.status === 'ready') await client.quit();
    else client.disconnect();
  }
  client = undefined;
}
