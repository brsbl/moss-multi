// Generation only: `pnpm --filter web db:generate`. Migrations apply with `wrangler d1 migrations apply` (A§6).
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
