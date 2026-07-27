import { marked } from "marked";

interface MarkdownRenderRequest {
  readonly id: number;
  readonly source: string;
}

interface MarkdownRenderResponse {
  readonly id: number;
  readonly html?: string;
  readonly error?: string;
}

self.addEventListener("message", (event: MessageEvent<MarkdownRenderRequest>) => {
  const { id, source } = event.data;
  try {
    const html = marked.parse(source, {
      async: false,
      breaks: false,
      gfm: true,
      pedantic: false,
      silent: false,
    });
    const response: MarkdownRenderResponse = {
      id,
      html: typeof html === "string" ? html : "",
    };
    self.postMessage(response);
  } catch (error) {
    const response: MarkdownRenderResponse = {
      id,
      error: error instanceof Error ? error.message : "Markdown rendering failed.",
    };
    self.postMessage(response);
  }
});
