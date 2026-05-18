import DefaultTheme from "vitepress/theme";
import { onContentUpdated } from "vitepress";
import "./custom.css";

let currentMermaidMode: "light" | "dark" | null = null;
let mermaidModulePromise: Promise<typeof import("mermaid")> | null = null;

function getMermaidMode() {
  if (typeof document === "undefined") {
    return "light" as const;
  }

  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getMermaidThemeVariables(mode: "light" | "dark") {
  if (mode === "dark") {
    return {
      background: "#0f1d2d",
      primaryColor: "#183a3c",
      primaryTextColor: "#ecf5fb",
      primaryBorderColor: "#62e0d0",
      lineColor: "#62e0d0",
      secondaryColor: "#13283a",
      tertiaryColor: "#0c1826"
    };
  }

  return {
    background: "#ffffff",
    primaryColor: "#dff8f3",
    primaryTextColor: "#082f49",
    primaryBorderColor: "#0f766e",
    lineColor: "#0f766e",
    secondaryColor: "#eef7fb",
    tertiaryColor: "#f8fcff"
  };
}

function resetMermaidDiagrams() {
  if (typeof document === "undefined") {
    return;
  }

  for (const node of document.querySelectorAll<HTMLElement>(".vp-mermaid[data-mermaid]")) {
    const source = node.dataset.mermaid;

    if (!source) {
      continue;
    }

    node.innerHTML = "";
    try {
      node.textContent = decodeURIComponent(source);
    } catch {
      node.textContent = "";
    }
    node.removeAttribute("data-processed");
  }
}

async function renderMermaidDiagrams() {
  if (typeof document === "undefined") {
    return;
  }

  const nodes = Array.from(document.querySelectorAll<HTMLElement>(".vp-mermaid[data-mermaid]"));

  if (nodes.length === 0) {
    return;
  }

  const mode = getMermaidMode();

  if (currentMermaidMode !== mode) {
    currentMermaidMode = mode;
    resetMermaidDiagrams();
  }

  mermaidModulePromise ??= import("mermaid");
  const { default: mermaid } = await mermaidModulePromise;

  mermaid.initialize({
    startOnLoad: false,
    theme: "base",
    securityLevel: "loose",
    fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif",
    themeVariables: getMermaidThemeVariables(mode)
  });

  for (const node of nodes) {
    const source = node.dataset.mermaid;

    if (!source || node.dataset.processed === "true") {
      continue;
    }

    try {
      node.textContent = decodeURIComponent(source);
    } catch {
      node.textContent = "";
    }
  }

  try {
    await mermaid.run({ nodes, suppressErrors: false });
  } catch (error) {
    console.error("Failed to render Mermaid diagram.", error);

    for (const node of nodes) {
      if (node.dataset.processed !== "true") {
        node.dataset.processed = "error";
      }
    }
  }
}

export default {
  extends: DefaultTheme,
  enhanceApp() {
    onContentUpdated(() => {
      void renderMermaidDiagrams();
    });

    if (typeof document !== "undefined") {
      const observer = new MutationObserver(() => {
        const mode = getMermaidMode();

        if (mode !== currentMermaidMode) {
          void renderMermaidDiagrams();
        }
      });

      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"]
      });
    }
  }
};
