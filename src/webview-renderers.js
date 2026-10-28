import katex from 'katex';
import mermaid from 'mermaid';

const MAX_MATH_CHARS = 8_000;
const MAX_DIAGRAM_CHARS = 20_000;
const MAX_DIAGRAM_SVG_CHARS = 300_000;
let diagramSequence = 0;

const editorStyles = getComputedStyle(document.documentElement);
const foreground = editorStyles.getPropertyValue('--vscode-editor-foreground').trim() || '#222222';
const background = editorStyles.getPropertyValue('--vscode-editor-background').trim() || '#ffffff';
const surface = editorStyles.getPropertyValue('--vscode-editorWidget-background').trim() || background;

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  htmlLabels: false,
  maxTextSize: MAX_DIAGRAM_CHARS,
  maxEdges: 500,
  theme: 'base',
  themeVariables: {
    background,
    primaryColor: surface,
    primaryTextColor: foreground,
    primaryBorderColor: foreground,
    lineColor: foreground,
    secondaryColor: background,
    tertiaryColor: surface,
  },
});

function renderMath(source, displayMode) {
  if (typeof source !== 'string' || source.length > MAX_MATH_CHARS) {
    throw new Error('Math input exceeds the rendering limit.');
  }
  return katex.renderToString(source, {
    displayMode: displayMode === true,
    output: 'mathml',
    throwOnError: true,
    trust: false,
    maxSize: 20,
    maxExpand: 1_000,
  });
}

async function renderDiagram(source) {
  if (typeof source !== 'string' || source.length > MAX_DIAGRAM_CHARS) {
    throw new Error('Diagram input exceeds the rendering limit.');
  }
  const result = await mermaid.render(`pi-chat-diagram-${++diagramSequence}`, source);
  if (typeof result.svg !== 'string' || result.svg.length > MAX_DIAGRAM_SVG_CHARS) {
    throw new Error('Diagram output exceeds the rendering limit.');
  }
  return result.svg;
}

window.piChatRenderers = Object.freeze({ renderMath, renderDiagram });
