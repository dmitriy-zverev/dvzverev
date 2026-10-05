const SECRET_FIELD_NAMES = new Set([
  'token',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'credential',
  'password',
  'secret',
]);

export function isEnvVarName(envKey) {
  return typeof envKey === 'string' && /^[A-Z][A-Z0-9_]*$/.test(envKey);
}

export function readEnvValue(env, envKey) {
  if (typeof envKey !== 'string' || !envKey.trim()) {
    throw new Error('Environment variable name is required');
  }
  if (!isEnvVarName(envKey)) {
    throw new Error(`Invalid environment variable name: ${envKey}`);
  }
  const value = env[envKey];
  if (value === undefined || value === '') {
    throw new Error(`Missing environment variable: ${envKey}`);
  }
  return value;
}

export function readOptionalEnvValue(env, envKey) {
  if (!envKey) return '';
  const value = env[envKey];
  if (value === undefined || value === '') return '';
  return value;
}

export function assertNoInlineSecrets(value, path) {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInlineSecrets(item, `${path}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = path ? `${path}.${key}` : key;
    if (SECRET_FIELD_NAMES.has(key) && typeof nested === 'string' && nested.trim()) {
      throw new Error(`Inline secret is not allowed at ${nestedPath}; use *Env reference`);
    }
    if (key.endsWith('Env') && typeof nested !== 'string') {
      throw new Error(`${nestedPath} must be an environment variable name`);
    }
    assertNoInlineSecrets(nested, nestedPath);
  }
}
