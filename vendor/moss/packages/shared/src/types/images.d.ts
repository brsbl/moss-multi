// ported-from: packages/shared/src/types/images.d.ts @ 762abb777
declare module '*.png' {
  const value: string;
  export default value;
}

declare module '../../../../../logos/*.png' {
  const value: string;
  export default value;
}

declare module '*.jpg' {
  const value: string;
  export default value;
}

declare module '*.jpeg' {
  const value: string;
  export default value;
}

declare module '*.gif' {
  const value: string;
  export default value;
}
