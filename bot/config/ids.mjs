export const ENTITY_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;

export function isEntityId(value) {
  return typeof value === 'string' && ENTITY_ID_PATTERN.test(value);
}
