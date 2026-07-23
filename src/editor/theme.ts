import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";

const syntax = HighlightStyle.define([
  { tag: [tags.keyword, tags.modifier], color: "#c7a7ff" },
  { tag: [tags.name, tags.deleted, tags.character, tags.propertyName], color: "#d7dbea" },
  { tag: [tags.function(tags.variableName), tags.labelName], color: "#85bffd" },
  { tag: [tags.color, tags.constant(tags.name), tags.standard(tags.name)], color: "#ffcb78" },
  { tag: [tags.definition(tags.name), tags.separator], color: "#9ed6c8" },
  { tag: [tags.typeName, tags.className, tags.number, tags.changed, tags.annotation], color: "#f7a975" },
  { tag: [tags.angleBracket, tags.tagName, tags.attributeName], color: "#7fd3b8" },
  { tag: [tags.regexp, tags.escape, tags.special(tags.string)], color: "#e6a6b5" },
  { tag: [tags.link, tags.string, tags.inserted], color: "#a9d18e" },
  { tag: [tags.meta, tags.comment], color: "#8b93a8", fontStyle: "italic" },
  { tag: tags.strong, fontWeight: "700" },
  { tag: tags.emphasis, fontStyle: "italic" },
  { tag: tags.invalid, color: "#ff6b7a" },
]);

export const editorTheme: Extension = [
  EditorView.theme(
    {
      "&": {
        height: "100%",
        color: "#e8e8e8",
        backgroundColor: "#000000",
        fontSize: "15px",
      },
      ".cm-content": {
        caretColor: "#ffffff",
        padding: "20px 0 48px",
        fontFamily: "var(--font-mono)",
        fontVariantLigatures: "none",
        fontWeight: "400",
        lineHeight: "1.7",
      },
      ".cm-line": { padding: "0 22px 0 9px" },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#ffffff", borderLeftWidth: "2px" },
      "&.cm-focused": { outline: "none" },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: "#ffffff24 !important",
      },
      ".cm-activeLine": { backgroundColor: "#ffffff05" },
      ".cm-gutters": {
        backgroundColor: "#000000",
        color: "#737373",
        border: "none",
        paddingLeft: "8px",
      },
      ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#999999" },
      ".cm-foldPlaceholder": { backgroundColor: "#181818", border: "none", color: "#b0b0b0" },
      ".cm-tooltip": { backgroundColor: "#0b0b0b", border: "1px solid #2c2c2c", color: "#e6e6e6" },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "#1c1c1c", color: "#fff" },
      ".cm-panels": { backgroundColor: "#080808", color: "#e6e6e6" },
      ".cm-panels.cm-panels-top": { borderBottom: "1px solid #262626" },
      ".cm-searchMatch": { backgroundColor: "#554d2f", outline: "1px solid #8b7c45" },
      ".cm-searchMatch.cm-searchMatch-selected": { backgroundColor: "#3a3a3a" },
    },
    { dark: true },
  ),
  syntaxHighlighting(syntax),
];
