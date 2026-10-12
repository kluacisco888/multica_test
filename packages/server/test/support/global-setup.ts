import type { TestProject } from 'vitest/node';
import { ensureTestPostgres } from '../../../../scripts/test-postgres.mjs';

declare module 'vitest' {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}

export default function setup(project: TestProject) {
  project.provide('testDatabaseUrl', ensureTestPostgres());
}
