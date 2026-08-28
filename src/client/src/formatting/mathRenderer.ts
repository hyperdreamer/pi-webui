export class MathJaxNotReadyError extends Error {
  constructor() {
    super("MathJax has not finished loading yet");
    this.name = "MathJaxNotReadyError";
  }
}

interface MathJaxEngine {
  convertLatex(texSource: string, display: boolean): string;
  mathJaxStyles(): string;
}

let enginePromise: Promise<MathJaxEngine> | undefined;
let readyEngine: MathJaxEngine | undefined;

/** Start loading the MathJax engine once. Resolves with the engine when ready. */
export function startMathJax(): Promise<MathJaxEngine> {
  enginePromise ??= import("./mathjaxEngine")
    .then((engine) => {
      const style = document.createElement("style");
      style.textContent = engine.mathJaxStyles();
      document.head.append(style);
      readyEngine = engine;
      return engine;
    })
    .catch((error: unknown) => {
      console.error("MathJax failed to load; math will render as literal source.", error);
      throw error;
    });
  return enginePromise;
}

export function isMathJaxReady(): boolean {
  return readyEngine !== undefined;
}

export function whenMathJaxReady(): Promise<void> {
  return startMathJax().then(() => undefined);
}

/** Synchronous renderer used as the pipeline default. Throws before readiness. */
export function renderLatexWithMathJax(tex: string, options: { displayMode: boolean }): string {
  if (readyEngine === undefined) {
    throw new MathJaxNotReadyError();
  }
  return readyEngine.convertLatex(tex, options.displayMode);
}
