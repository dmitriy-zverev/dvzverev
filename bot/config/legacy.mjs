const LEGACY_PUBLISHING_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'VK_ACCESS_TOKEN',
  'VK_GROUP_ID',
  'OPENROUTER_API_KEY',
  'BOT_POST_SOURCE',
  'BOT_CONTENT_MODE',
  'BOT_PROMPT',
  'BOT_TIMES',
];

export function hasLegacyPublishingEnv(env = process.env) {
  return LEGACY_PUBLISHING_KEYS.some((key) => {
    const value = env[key];
    return value !== undefined && String(value).trim() !== '';
  });
}

export function dualConfigWarnings(env = process.env) {
  const warnings = [];
  const configPath = env.BOT_CONFIG_PATH?.trim();
  if (!configPath) return warnings;
  if (!hasLegacyPublishingEnv(env)) return warnings;
  warnings.push(
    'BOT_CONFIG_PATH is set together with legacy TELEGRAM/VK/OpenRouter env vars. Multi-project config takes precedence; migrate secrets into the service config and remove duplicate legacy values.',
  );
  return warnings;
}
