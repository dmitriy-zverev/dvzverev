const SAFE_ERROR_PREFIXES = [
  'Invalid service config:',
  'Missing environment variable:',
  'Unknown project:',
  'Project is disabled:',
  'Pass --config',
  'Pass --project ID',
  'Config path is required',
  'No enabled projects',
  'Multi-project config is not enabled',
  'Prompt path',
  'Invalid environment variable name:',
  'Environment variable name is required',
  'Unexpected token',
  'is not valid JSON',
];

export function isOperatorSafeError(error) {
  if (!(error instanceof Error)) return false;
  if (error instanceof SyntaxError) return true;
  return SAFE_ERROR_PREFIXES.some((prefix) => error.message.startsWith(prefix));
}

function isGenerationFailure(error) {
  return (
    error instanceof Error &&
    typeof error.reason === 'string' &&
    error.message.startsWith('OpenRouter generation failed:')
  );
}

export function formatCliError(error) {
  if (isGenerationFailure(error)) {
    return `OpenRouter: ${error.reason} (code ${error.code || '—'})`;
  }
  if (isOperatorSafeError(error)) return error.message;
  return 'Bot stopped: check environment, queue, state and file permissions. Run bot tests for validation.';
}
