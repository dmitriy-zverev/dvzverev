// Runs in the same broker process as HTTP routes, sharing single-flight refresh.
export function createRefreshTick(client, report, now = Date.now) {
  let failures = 0;
  let retryAt = 0;
  return async () => {
    if (now() < retryAt) return;
    try {
      if (!client.status().connected) return;
      await client.accessToken(); // Refreshes only within five minutes of expiry.
      failures = 0;
      retryAt = 0;
    } catch (error) {
      failures += 1;
      retryAt = now() + Math.min(60, 2 ** Math.min(failures - 1, 6)) * 60000;
      await report(error);
    }
  };
}

export function startRefreshWorker(tick) {
  let stopped = false;
  let timer;
  const run = async () => {
    try {
      await tick();
    } catch {
      // Reporting failure must not crash the cabinet or create overlapping ticks.
    } finally {
      if (!stopped) {
        timer = setTimeout(run, 60000);
        timer.unref();
      }
    }
  };
  timer = setTimeout(run, 1000);
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
