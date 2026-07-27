/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import { sanitizeMarkdownHtml } from "./controller";

describe("Markdown preview sanitization", () => {
  it("removes scripts, event handlers, unsafe URLs and inline styles", async () => {
    const html = await sanitizeMarkdownHtml(`
      <script>window.compromised = true</script>
      <img src="x" onerror="window.compromised = true">
      <a href="javascript:alert(1)" style="position:fixed" target="_blank">unsafe</a>
      <h1 id="app">Safe heading</h1>
      <p><strong>Allowed formatting</strong></p>
    `);
    const host = document.createElement("div");
    host.innerHTML = html;

    expect(host.querySelector("script")).toBeNull();
    expect(host.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(host.querySelector("a")?.hasAttribute("href")).toBe(false);
    expect(host.querySelector("a")?.hasAttribute("style")).toBe(false);
    expect(host.querySelector("a")?.hasAttribute("target")).toBe(false);
    expect(host.querySelector("h1")?.hasAttribute("id")).toBe(false);
    expect(host.querySelector("strong")?.textContent).toBe("Allowed formatting");
  });

  it("removes interactive embedded content", async () => {
    const html = await sanitizeMarkdownHtml(`
      <form><input value="spoofed"><button>Submit</button></form>
      <iframe srcdoc="<script>alert(1)</script>"></iframe>
      <video src="https://example.com/tracker.mp4"></video>
    `);
    const host = document.createElement("div");
    host.innerHTML = html;

    expect(host.querySelector("form, input, button, iframe, video")).toBeNull();
  });
});
