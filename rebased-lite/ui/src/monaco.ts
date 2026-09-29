// Monaco with only the features that Rebased Lite uses. The full "edcore.main" loads about 60 features and
// costs about 24 MB more in the WebKit process on open.
import "monaco-editor/esm/vs/editor/browser/coreCommands.js";
import "monaco-editor/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js";
import "monaco-editor/esm/vs/editor/browser/widget/diffEditor/diffEditor.contribution.js";
import "monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController.js";
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/esm/vs/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
export * from "monaco-editor/esm/vs/editor/editor.api.js";
