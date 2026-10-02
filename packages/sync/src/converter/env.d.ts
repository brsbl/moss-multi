// Vite's import.meta.glob, which inlines the fixture corpus for Node and workerd alike.
interface ImportMeta {
  glob<T = unknown>(pattern: string, options: { query?: string; import?: string; eager: true }): Record<string, T>;
}
