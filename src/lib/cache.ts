import { redis } from './redis';

const DEFAULT_TTL = 60; // secondes

export async function cachedGet<T>(
  key: string,
  fetcher: () => Promise<T>,
  ttl = DEFAULT_TTL
): Promise<T> {
  // 1. check cache
  try {
    const cached = await redis.get<T>(key);
    const hit = cached !== null;
    console.log(`[cache] ${hit ? 'HIT' : 'MISS'} ${key}`);
    if (hit) return cached as T;
  } catch {
    // Silent: si Redis down → fallback direct
  }

  // 2. fetch depuis Supabase
  const data = await fetcher();

  // 3. stocker en cache
  try {
    await redis.set(key, data, { ex: ttl });
  } catch {
    // Silent
  }

  return data;
}

export async function invalidateCache(key: string) {
  try {
    await redis.del(key);
  } catch {
    // Silent
  }
}
