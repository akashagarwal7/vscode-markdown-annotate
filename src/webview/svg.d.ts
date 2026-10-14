/** SVG files are bundled as their markup (see esbuild.mjs). */
declare module '*.svg' {
  const markup: string;
  export default markup;
}
