/** Postgres unique_violation (23505), possibly wrapped by drizzle. */
export function isUniqueViolation(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } }).cause ?? error;
  return (cause as { code?: string }).code === '23505';
}
