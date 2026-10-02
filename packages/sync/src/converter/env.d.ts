// Vite's import.meta.glob, which inlines the fixture corpus for Node and workerd alike.
interface ImportMeta {
  glob<T = unknown>(pattern: string, options: { query?: string; import?: string; eager: true }): Record<string, T>;
}

// Asset imports moss's shared barrel carries; type-only imports of the barrel bring them into the program.
declare module '*.png' {
  const src: string;
  export default src;
}
declare module '*?raw' {
  const text: string;
  export default text;
}
