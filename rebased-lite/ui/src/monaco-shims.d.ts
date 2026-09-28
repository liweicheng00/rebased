// The editor-core entry point has the same API as the full package, without the language services.
declare module "monaco-editor/esm/vs/editor/edcore.main" {
  export * from "monaco-editor";
}
declare module "monaco-editor/esm/vs/basic-languages/monaco.contribution";
