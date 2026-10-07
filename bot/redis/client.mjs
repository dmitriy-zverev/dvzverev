import { createClient } from 'redis';

let sharedClient;
let connectPromise;

export function redisConfigured(env = process.env) {
  return Boolean(String(env.BOT_REDIS_URL || '').trim());
}

export async function getRedis(env = process.env) {
  const url = String(env.BOT_REDIS_URL || '').trim();
  if (!url) return null;
  if (sharedClient?.isReady) return sharedClient;
  if (sharedClient?.isOpen) throw new Error('Redis is reconnecting');
  if (!sharedClient) {
    sharedClient = createClient({
      url,
      disableOfflineQueue: true,
      socket: {
        connectTimeout: 5000,
        reconnectStrategy: (retries) =>
          retries >= 3
            ? new Error('Redis connection retry limit reached')
            : Math.min(retries * 100, 3000),
      },
    });
    sharedClient.on('error', (error) => {
      console.error(`Redis error: ${error.message}`);
    });
  }
  if (!connectPromise) {
    connectPromise = sharedClient.connect().catch((error) => {
      connectPromise = undefined;
      throw error;
    });
  }
  await connectPromise;
  return sharedClient;
}

export async function closeRedis() {
  if (sharedClient?.isReady) await sharedClient.quit();
  else if (sharedClient?.isOpen) await sharedClient.disconnect();
  sharedClient = undefined;
  connectPromise = undefined;
}
