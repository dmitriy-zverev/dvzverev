import { createClient } from 'redis';

let sharedClient;
let connectPromise;

export function redisConfigured(env = process.env) {
  return Boolean(String(env.BOT_REDIS_URL || '').trim());
}

export async function getRedis(env = process.env) {
  const url = String(env.BOT_REDIS_URL || '').trim();
  if (!url) return null;
  if (sharedClient?.isOpen) return sharedClient;
  if (!sharedClient) {
    sharedClient = createClient({
      url,
      socket: {
        reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
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
  if (!sharedClient?.isOpen) return;
  await sharedClient.quit();
  sharedClient = undefined;
  connectPromise = undefined;
}
