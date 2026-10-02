// ported-from: packages/shared/src/types/markdown.d.ts @ 762abb777
declare module '*.md?raw' {
  const content: string;
  export default content;
}
