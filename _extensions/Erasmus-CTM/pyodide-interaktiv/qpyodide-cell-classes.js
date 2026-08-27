// qpyodide-cell-classes.js – cell classes of the `pyodide-interaktiv` extension
//
// Structure (clear separation, no duplication):
//   qpyodideExecutePython()  – shared execution layer (one place!)
//   EditorUnit               – ONE Monaco editor with toolbar + output areas;
//                              used both for the main cell and for extra
//                              editors added via "+ Code block"
//   InteractiveCell          – <details> wrapper around one (or more) EditorUnit(s)
//   OutputCell               – runs code and shows only the output
//   SetupCell                – runs code invisibly (setup context)
//   CellContainer            – collection of all cells, starts setup/output/autorun
//
// AI feedback lives entirely in qpyodide-feedback.js and is only wired up
// here via qpyodideFeedback.attach(unit).

// ---------------------------------------------------------------------------
// Theme coupling (Quarto dark mode <-> Monaco & Bootstrap variables)
// ---------------------------------------------------------------------------

function qpyodideIsDarkMode() {
  const cls = document.body.classList;
  if (cls.contains("quarto-dark")) return true;
  if (cls.contains("quarto-light")) return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

function qpyodideMonacoTheme() {
  return qpyodideIsDarkMode() ? "vs-dark" : "vs";
}

function qpyodideSyncMonacoTheme() {
  if (globalThis.monaco) {
    monaco.editor.setTheme(qpyodideMonacoTheme());
  }
}

// Bootstrap only sets its dark-mode variables (--bs-body-bg,
// --bs-border-color, ...) under [data-bs-theme=dark], but Quarto only
// toggles body.quarto-dark/-light. Without this sync, var(--bs-*)
// references in dark mode would resolve to generic, light fallback
// values instead of the active theme's colors (e.g. slate). Scope is
// deliberately <body>, not <html>, so only the page content is affected,
// not Quarto's own navbar (which already has data-bs-theme="dark" fixed).
function qpyodideSyncBsTheme() {
  document.body.setAttribute("data-bs-theme", qpyodideIsDarkMode() ? "dark" : "light");
}

function qpyodideSyncTheme() {
  qpyodideSyncMonacoTheme();
  qpyodideSyncBsTheme();
}

// React live to theme changes (Quarto toggles classes on <body>)
new MutationObserver(qpyodideSyncTheme)
  .observe(document.body, { attributes: true, attributeFilter: ["class"] });
window.matchMedia?.("(prefers-color-scheme: dark)")
  .addEventListener?.("change", qpyodideSyncTheme);
qpyodideSyncBsTheme();

// ---------------------------------------------------------------------------
// Shared execution layer
// ---------------------------------------------------------------------------

// UI lock: one cell computes per click; the page itself stays free,
// because Python runs in the Web Worker.
let qpyodideExecutionBusy = false;

// Detects input() calls in the code (same heuristic as runForOutput()).
function qpyodideCodeHasInput(code) {
  return /\binput\s*\(/.test(code || "");
}

function qpyodideSetRunButtonsEnabled(enabled) {
  document.querySelectorAll(".qpyodide-button-run").forEach((btn) => {
    // input() cells stay locked as long as input() is unavailable
    btn.disabled = !enabled ||
      (btn.dataset.needsInput === "1" && !globalThis.qpyodideInputAvailable());
  });
}

/**
 * Runs Python code in the Pyodide worker.
 * @param {string}  code       Python code to run
 * @param {boolean} wantPickle also deliver figures as pickle
 *                             (only needed when switching to canvas)
 * @returns {Promise<{entries: Array, text: string, html: ?string, images: string[],
 *                    pickles: string[], pickleErrors: string[],
 *                    animations: string[], animationErrors: string[]}>}
 *   entries    – stdout/stderr lines, text – joined as plain text,
 *   html       – HTML return value of the last statement (or null),
 *   animations – automatically detected animations as ready-made player HTML,
 *   images     – the remaining matplotlib figures as base64 PNGs,
 *   pickles    – the same figures as base64 pickle (empty without wantPickle)
 */
async function qpyodideExecutePython(code, wantPickle) {
  const pyodide = await qpyodideReady;
  const result = await pyodide.runCell(code, wantPickle);
  result.text = result.entries.map((entry) => entry.message).join("\n");
  return result;
}

/**
 * Safely render text output (stdout/stderr) into a container.
 * @returns {boolean} true if visible content was produced.
 */
function qpyodideRenderTextOutput(targetDiv, entries) {
  const pre = document.createElement("pre");
  let hasContent = false;

  entries.forEach((entry) => {
    if (!/\S/.test(entry.message)) return;
    const line = document.createElement("code");
    line.className = (entry.type === "stderr")
      ? "qpyodide-output-code-stderr"
      : "qpyodide-output-code-stdout";
    line.textContent = entry.message;
    pre.appendChild(line);
    pre.appendChild(document.createTextNode("\n"));
    hasContent = true;
  });

  if (!hasContent) {
    pre.style.visibility = "hidden";
  }
  targetDiv.appendChild(pre);
  return hasContent;
}

/**
 * Renders matplotlib figures (base64 PNGs from the worker) as a <figure>.
 * @returns {boolean} true if a figure was inserted.
 */
function qpyodideRenderImages(targetDiv, images, figCap) {
  if (!images || images.length === 0) return false;
  const figure = document.createElement("figure");
  images.forEach((base64Png) => {
    const img = document.createElement("img");
    img.src = "data:image/png;base64," + base64Png;
    img.alt = figCap || "Plot";
    figure.appendChild(img);
  });
  if (figCap) {
    const figcaption = document.createElement("figcaption");
    figcaption.innerText = figCap;
    figure.appendChild(figcaption);
  }
  targetDiv.appendChild(figure);
  return true;
}

/**
 * Renders the plot output of a run.
 *
 * Animations first: they come as ready-made player HTML from the worker
 * (matplotlib `to_jshtml`) and already stand in there instead of the
 * figure, which would otherwise arrive as a frozen still image. Then the
 * PNGs of the remaining figures – those are available immediately. If
 * interactive plots are wanted for the cell, it then switches to canvas
 * in the background (second Pyodide instance, see
 * qpyodide-canvas-plots.js). No switch happens for an HTML return value
 * (Plotly, zeige_svg) and when not every figure has a usable pickle.
 */
function qpyodideRenderPlots(targetDiv, result, options) {
  const animations = result.animations || [];
  animations.forEach((animHtml) => qpyodideRenderHtmlOutput(targetDiv, animHtml));
  (result.animationErrors || []).forEach((msg) => {
    // The figure stays as PNG in this case – expected fallback.
    if (msg) console.warn("qpyodide: animation could not be rendered –", msg);
  });

  const hasImages = qpyodideRenderImages(targetDiv, result.images, options["fig-cap"]);
  targetDiv.classList.toggle("has-content", hasImages || animations.length > 0);

  const images  = result.images  || [];
  const pickles = result.pickles || [];
  if (images.length === 0) return;
  if (result.html) return;
  if (!globalThis.qpyodideCanvasWanted?.(options)) return;

  if (pickles.length !== images.length || pickles.some((p) => !p)) {
    // At least one figure couldn't be pickled -> stick with the image,
    // otherwise canvas and PNG would end up mixed together.
    (result.pickleErrors || []).forEach((msg) => {
      if (msg) console.warn("qpyodide: figure could not be pickled –", msg);
    });
    return;
  }

  // Deliberately without await: the cell is done, loading the second
  // instance may run in the background.
  globalThis.qpyodideCanvasUpgrade(targetDiv, pickles, options);
}

/**
 * Renders rich HTML output – including execution of embedded <script>
 * tags (needed for the matplotlib to_jshtml player). The container must
 * already be attached to the document for this.
 */
async function qpyodideRenderHtmlOutput(targetDiv, html) {
  const wrapper = document.createElement("div");
  wrapper.className = "qpyodide-html-output";
  targetDiv.appendChild(wrapper);
  wrapper.innerHTML = html;

  // innerHTML doesn't execute scripts -> replace with executable clones.
  // Order matters: a library loaded via src (e.g. d3) must finish loading
  // before a following inline script uses it. So we go through them in
  // order and wait for external scripts (errors don't block).
  const scripts = Array.from(wrapper.querySelectorAll("script"));
  for (const oldScript of scripts) {
    const newScript = document.createElement("script");
    for (const attr of oldScript.attributes) {
      newScript.setAttribute(attr.name, attr.value);
    }
    newScript.textContent = oldScript.textContent;
    const loaded = newScript.src
      ? new Promise((resolve) => {
          newScript.addEventListener("load", resolve, { once: true });
          newScript.addEventListener("error", resolve, { once: true });
        })
      : null;
    oldScript.replaceWith(newScript);
    if (loaded) await loaded;
  }
}

// ---------------------------------------------------------------------------
// EditorUnit – a Monaco editor with toolbar and output areas
// ---------------------------------------------------------------------------

class EditorUnit {
  /**
   * @param {Object} config
   * @param {string}  config.uid       unique ID (e.g. "3" or "3.2")
   * @param {string}  config.code      initial code of the editor
   * @param {Object}  config.options   cell options (read-only, fig-cap, …)
   * @param {Element} config.hostDiv   container the unit is built into
   */
  constructor({ uid, code, options, hostDiv }) {
    this.uid = uid;
    this.code = code;
    this.options = options;
    this.hostDiv = hostDiv;
    this.editor = null;
    this.isReadOnly = options["read-only"] === "true";
    this.lastRunCode = null;   // code state of the last run
    this.lastOutput = null;    // text output of the last run (for the feedback cache)

    this.buildDom();
    this.initMonaco();
    this.wireButtons();
  }

  /** Builds the toolbar + editor and output areas. */
  buildDom() {
    const uid = this.uid;

    // Toolbar
    this.toolbarDiv = document.createElement("div");
    this.toolbarDiv.className = "qpyodide-editor-toolbar " +
      (this.isReadOnly ? "qpyodide-toolbar-readonly" : "qpyodide-toolbar-editable");
    this.toolbarDiv.id = `qpyodide-editor-toolbar-${uid}`;

    const leftButtonsDiv = document.createElement("div");
    leftButtonsDiv.className = "qpyodide-editor-toolbar-left-buttons";

    const middleToolBarDiv = document.createElement("div");
    middleToolBarDiv.className = "qpyodide-editor-toolbar-middle";

    const rightButtonsDiv = document.createElement("div");
    rightButtonsDiv.className = "qpyodide-editor-toolbar-right-buttons";

    // Run button
    this.runButton = document.createElement("button");
    this.runButton.className = "btn btn-default qpyodide-button qpyodide-button-run";
    this.runButton.type = "button";
    this.runButton.id = `qpyodide-button-run-${uid}`;
    this.runButton.title = QP_L.runTitle;
    if (globalThis.mainPyodide) {
      this.runButton.innerHTML = QP_L.runLabel;
      this.runButton.disabled = false;
    } else {
      this.runButton.textContent = QP_L.runLoading;
      this.runButton.disabled = true;
    }
    leftButtonsDiv.appendChild(this.runButton);

    // Editable/read-only label
    const readOnlyLabel = document.createElement("label");
    readOnlyLabel.className = "qpyodide-label qpyodide-readonly-label";
    readOnlyLabel.id = `qpyodide-readonly-label-${uid}`;
    readOnlyLabel.textContent = this.isReadOnly ? QP_L.labelReadOnly : QP_L.labelEditable;
    middleToolBarDiv.appendChild(readOnlyLabel);

    // Reset button
    this.resetButton = document.createElement("button");
    this.resetButton.className = "btn btn-light btn-xs qpyodide-button qpyodide-button-reset";
    this.resetButton.type = "button";
    this.resetButton.id = `qpyodide-button-reset-${uid}`;
    this.resetButton.title = QP_L.resetTitle;
    this.resetButton.innerHTML = '<i class="fa-solid fa-arrows-rotate"></i>';
    rightButtonsDiv.appendChild(this.resetButton);

    // Copy button
    this.copyButton = document.createElement("button");
    this.copyButton.className = "btn btn-light btn-xs qpyodide-button qpyodide-button-copy";
    this.copyButton.type = "button";
    this.copyButton.id = `qpyodide-button-copy-${uid}`;
    this.copyButton.title = QP_L.copyTitle;
    this.copyButton.innerHTML = '<i class="fa-regular fa-copy"></i>';
    rightButtonsDiv.appendChild(this.copyButton);

    // Feedback button (only when the feature is enabled and the cell is editable)
    this.feedbackButton = null;
    if (globalThis.qpyodideFeedback?.enabled && !this.isReadOnly) {
      this.feedbackButton = document.createElement("button");
      this.feedbackButton.className = "btn btn-default qpyodide-button qpyodide-button-feedback";
      this.feedbackButton.type = "button";
      this.feedbackButton.id = `qpyodide-button-feedback-${uid}`;
      this.feedbackButton.title = QP_L.feedbackTitle;
      this.feedbackButton.innerHTML = QP_L.feedbackLabel;
      this.feedbackButton.disabled = !globalThis.mainPyodide;
      rightButtonsDiv.appendChild(this.feedbackButton);
    }

    this.toolbarDiv.appendChild(leftButtonsDiv);
    this.toolbarDiv.appendChild(middleToolBarDiv);
    this.toolbarDiv.appendChild(rightButtonsDiv);

    // Console: editor + text output + feedback output
    const consoleAreaDiv = document.createElement("div");
    consoleAreaDiv.id = `qpyodide-console-area-${this.uid}`;
    consoleAreaDiv.className = "qpyodide-console-area";

    this.editorDiv = document.createElement("div");
    this.editorDiv.id = `qpyodide-editor-${uid}`;
    this.editorDiv.className = "qpyodide-editor";

    this.outputCodeDiv = document.createElement("div");
    this.outputCodeDiv.id = `qpyodide-output-code-area-${uid}`;
    this.outputCodeDiv.className = "qpyodide-output-code-area";
    this.outputCodeDiv.setAttribute("aria-live", "assertive");
    const placeholderPre = document.createElement("pre");
    placeholderPre.style.visibility = "hidden";
    this.outputCodeDiv.appendChild(placeholderPre);

    this.outputFeedbackDiv = document.createElement("div");
    this.outputFeedbackDiv.id = `qpyodide-output-feedback-area-${uid}`;
    this.outputFeedbackDiv.className = "qpyodide-output-feedback-area";
    this.outputFeedbackDiv.setAttribute("aria-live", "assertive");

    consoleAreaDiv.appendChild(this.editorDiv);
    consoleAreaDiv.appendChild(this.outputCodeDiv);
    if (this.feedbackButton) {
      consoleAreaDiv.appendChild(this.outputFeedbackDiv);
    }

    // Graphics output (matplotlib)
    this.outputGraphDiv = document.createElement("div");
    this.outputGraphDiv.id = `qpyodide-output-graph-area-${uid}`;
    this.outputGraphDiv.className = "qpyodide-output-graph-area";

    // Hint for input() cells when input() is (not yet) available.
    // Hidden by default; updateInputGate() shows it when needed.
    this.inputHintDiv = document.createElement("div");
    this.inputHintDiv.className = "qpyodide-cell-input-hint";
    this.inputHintDiv.hidden = true;

    this.hostDiv.appendChild(this.toolbarDiv);
    this.hostDiv.appendChild(this.inputHintDiv);
    this.hostDiv.appendChild(consoleAreaDiv);
    this.hostDiv.appendChild(this.outputGraphDiv);

    // First gate check based on the initial code (the editor doesn't exist
    // yet; getCode() falls back to this.code).
    this.updateInputGate();
  }

  /** Creates the Monaco editor (height, EOL, keyboard shortcuts). */
  initMonaco() {
    const thiz = this;

    require(["vs/editor/editor.main"], function () {
      thiz.editor = monaco.editor.create(thiz.editorDiv, {
        value: thiz.code,
        language: "python",
        theme: qpyodideMonacoTheme(),
        automaticLayout: true,           // Works wonderfully with RevealJS
        scrollBeyondLastLine: false,
        minimap: { enabled: false },
        fontSize: "17.5pt",              // Bootstrap is 1 rem
        renderLineHighlight: "none",     // Disable current line highlighting
        hideCursorInOverviewRuler: true, // Remove cursor indicator in scroll bar
        readOnly: thiz.isReadOnly
      });

      // Store metadata on the editor (e.g. for other extensions)
      thiz.editor.__qpyodideCounter = thiz.uid;
      thiz.editor.__qpyodideEditorId = `qpyodide-editor-${thiz.uid}`;
      thiz.editor.__qpyodideinitialCode = thiz.code;
      thiz.editor.__qpyodideOptions = thiz.options;

      // Set at the model level the preferred end of line (EOL) character to LF.
      // This prevents `\r\n` from being given to the Pyodide engine on Windows.
      // See details in: https://github.com/coatless/quarto-Pyodide/issues/94
      const model = thiz.editor.getModel();
      model.setEOL(monaco.editor.EndOfLineSequence.LF);

      // Dynamically adjust editor height to fit the content
      const updateHeight = () => {
        const contentHeight = thiz.editor.getContentHeight();
        thiz.editorDiv.style.height = `${contentHeight}px`;
        thiz.editor.layout();
      };

      const isEmptyCodeText = (selected) =>
        (selected === null || selected === undefined || selected === "");

      // Keyboard shortcuts must be re-registered per editor on focus change
      // (Monaco regression since 0.32.0):
      // https://github.com/microsoft/monaco-editor/issues/2947
      const addPyodideKeyboardShortCutCommands = () => {
        // Shift+Enter: run the entire cell content
        thiz.editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => {
          thiz.runCode(thiz.editor.getValue());
        });

        // Ctrl/Cmd+Enter: run the selection (or the current line)
        thiz.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
          const selectedText = thiz.editor.getModel()
            .getValueInRange(thiz.editor.getSelection());

          if (isEmptyCodeText(selectedText)) {
            const currentPosition = thiz.editor.getPosition();
            const currentLine = thiz.editor.getModel()
              .getLineContent(currentPosition.lineNumber);

            const newPosition = new monaco.Position(currentPosition.lineNumber + 1, 1);
            if (newPosition.lineNumber > thiz.editor.getModel().getLineCount()) {
              thiz.editor.executeEdits("addNewLine", [{
                range: new monaco.Range(newPosition.lineNumber, 1, newPosition.lineNumber, 1),
                text: "\n",
                forceMoveMarkers: true,
              }]);
            }

            thiz.runCode(currentLine);
            thiz.editor.setPosition(newPosition);
          } else {
            thiz.runCode(selectedText);
          }
        });
      };

      thiz.editor.onDidFocusEditorText(addPyodideKeyboardShortCutCommands);
      thiz.editor.onDidContentSizeChange(updateHeight);
      // Code changes can add/remove input() -> re-evaluate the gate
      thiz.editor.onDidChangeModelContent(() => thiz.updateInputGate());
      updateHeight();
      thiz.updateInputGate();
    });
  }

  /** Wires up button clicks (Run/Reset/Copy/Feedback). */
  wireButtons() {
    const thiz = this;

    this.runButton.onclick = () => thiz.runCode(thiz.getCode());

    this.copyButton.onclick = () => {
      navigator.clipboard.writeText(thiz.getCode() || "");
    };

    this.resetButton.onclick = () => {
      if (thiz.editor) {
        thiz.editor.setValue(thiz.editor.__qpyodideinitialCode);
      }
      thiz.lastRunCode = null;
      thiz.lastOutput = null;
      [thiz.outputCodeDiv, thiz.outputFeedbackDiv, thiz.outputGraphDiv].forEach((div) => {
        if (div.classList.contains("has-content")) {
          div.innerHTML = "";
          div.classList.remove("has-content");
        }
      });
    };

    // AI feedback: all of its logic lives in qpyodide-feedback.js
    if (this.feedbackButton) {
      qpyodideFeedback.attach({
        uid: this.uid,
        feedbackButton: this.feedbackButton,
        feedbackDiv: this.outputFeedbackDiv,
        getCode: () => thiz.getCode(),
        runForOutput: () => thiz.runForOutput()
      });
    }

    // Keep the input() gate current: on state changes (input() checked/enabled)
    // and once as soon as the Pyodide runtime is ready.
    window.addEventListener("qpyodide-input-state", () => thiz.updateInputGate());
    if (globalThis.qpyodideReady) {
      globalThis.qpyodideReady.then(() => thiz.updateInputGate()).catch(() => {});
    }
  }

  /** Gets the editor's current code (fallback: initial code). */
  getCode() {
    return this.editor ? this.editor.getValue() : this.code;
  }

  /**
   * Locks/unlocks the Run button depending on whether the cell uses
   * input() and whether input() is available on this page. Shows an
   * inline hint with a link to the input() panel above when needed.
   */
  updateInputGate() {
    if (!this.runButton) return;

    const needsInput = qpyodideCodeHasInput(this.getCode());
    const available  = globalThis.qpyodideInputAvailable
      ? globalThis.qpyodideInputAvailable() : true;

    // Marker for the global togglers (qpyodideSetRunButtonsEnabled,
    // qpyodideSetInteractiveButtonState), so they respect the lock.
    if (needsInput) {
      this.runButton.dataset.needsInput = "1";
    } else {
      delete this.runButton.dataset.needsInput;
    }

    const blocked = needsInput && !available;

    // Only touch the Run button when Python is ready and nothing is
    // currently running – otherwise we'd overwrite the loading or stop state.
    if (globalThis.mainPyodide && !qpyodideExecutionBusy) {
      this.runButton.disabled = blocked;
      this.runButton.title = blocked
        ? QP_L.runTitleBlocked
        : QP_L.runTitle;
    }

    // Expand/collapse the inline hint
    if (!this.inputHintDiv) return;
    if (!blocked) {
      this.inputHintDiv.hidden = true;
      this.inputHintDiv.innerHTML = "";
      return;
    }

    const hints = {
      "unavailable":  QP_L.cellInputHintUnavailable,
      "needs-reload": QP_L.cellInputHintNeedsReload,
    };
    this.inputHintDiv.innerHTML =
      hints[globalThis.qpyodideInputState] || QP_L.cellInputHintCheck;
    this.inputHintDiv.hidden = false;
  }

  /**
   * Runs code in the worker and displays the result (text/HTML/plots)
   * below the editor. While running, this cell's Run button turns into a
   * Stop button (graceful abort via interrupt, otherwise a hard worker
   * restart) – the page stays fully usable throughout.
   * @returns {Promise<string>} the interpreter's text output
   */
  async runCode(code) {
    if (qpyodideExecutionBusy) return "";
    qpyodideExecutionBusy = true;
    qpyodideSetRunButtonsEnabled(false);

    const proxy = await qpyodideReady;

    // Create the streaming terminal (runs for all cells, not only with input())
    this.outputCodeDiv.innerHTML = "";
    const terminalDiv = document.createElement("div");
    terminalDiv.className = "qpyodide-terminal";
    this.outputCodeDiv.appendChild(terminalDiv);
    this.outputCodeDiv.classList.add("has-content");

    // Streamed stdout/stderr: each line appears immediately in the terminal
    proxy.onStream = (text, type) => {
      const line = document.createElement("code");
      line.className = type === "stderr"
        ? "qpyodide-output-code-stderr"
        : "qpyodide-output-code-stdout";
      line.textContent = text;
      terminalDiv.appendChild(line);
      terminalDiv.appendChild(document.createTextNode("\n"));
    };

    // Python input(): insert an input field inline into the terminal and
    // then block (only works if the page is cross-origin isolated).
    // The prompt comes directly from the worker (via _qpyodide_set_prompt
    // from Python), since Pyodide only flushes stdout on complete lines
    // (with \n) – input() prompts without \n would otherwise never reach
    // the main thread.
    proxy.onInputRequired = (prompt) => {
      const row = document.createElement("div");
      row.className = "qpyodide-input-row";

      if (prompt) {
        const promptSpan = document.createElement("span");
        promptSpan.className = "qpyodide-input-prompt";
        promptSpan.textContent = prompt;
        row.appendChild(promptSpan);
      }

      const inp = document.createElement("input");
      inp.type = "text";
      inp.className = "qpyodide-terminal-input";
      inp.setAttribute("autocomplete", "off");
      inp.setAttribute("spellcheck", "false");
      row.appendChild(inp);
      terminalDiv.appendChild(row);
      inp.focus();

      inp.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const val = inp.value;
        // Replace the input field with the echo (the prompt label stays)
        const echo = document.createElement("code");
        echo.className = "qpyodide-output-code-stdout qpyodide-input-echo";
        echo.textContent = val;
        inp.replaceWith(echo);
        terminalDiv.appendChild(document.createTextNode("\n"));
        // Hand the value to the worker (wakes Atomics.wait in stdin())
        proxy.provideInput(val);
      });
    };

    // Turn the Run button into a Stop button
    const runButtonHtml = this.runButton.innerHTML;
    this.runButton.innerHTML = QP_L.stopLabel;
    this.runButton.title = proxy.interruptBuffer
      ? QP_L.stopTitle
      : QP_L.stopTitleRestart;
    this.runButton.disabled = false;
    this.runButton.onclick = () => {
      // Mark an open input field as "[Aborted]"
      terminalDiv.querySelectorAll(".qpyodide-input-row").forEach((row) => {
        const aborted = document.createElement("code");
        aborted.className = "qpyodide-output-code-stderr";
        aborted.textContent = QP_L.aborted;
        row.replaceChildren(aborted);
      });
      if (proxy.interruptBuffer) {
        proxy.interrupt();
      } else {
        proxy.restart(QP_L.abortedRestart);
      }
    };

    let text = "";
    try {
      const result = await qpyodideExecutePython(
        code, globalThis.qpyodideCanvasWanted?.(this.options)
      );
      text = result.text;

      // Append HTML return value (e.g. animation) and graphics
      if (result.html) qpyodideRenderHtmlOutput(this.outputCodeDiv, result.html);
      this.outputGraphDiv.innerHTML = "";
      qpyodideRenderPlots(this.outputGraphDiv, result, this.options);

      // Terminal empty + no HTML → remove has-content (don't waste space)
      if (!terminalDiv.hasChildNodes() && !result.html) {
        this.outputCodeDiv.classList.remove("has-content");
      }
    } catch (err) {
      // Hard abort (worker restart) or worker crash
      text = String((err && err.message) || err);
      terminalDiv.querySelectorAll(".qpyodide-input-row").forEach((r) => r.remove());
      const errCode = document.createElement("code");
      errCode.className = "qpyodide-output-code-stderr";
      errCode.textContent = text;
      terminalDiv.appendChild(errCode);
    } finally {
      proxy.onStream = null;
      proxy.onInputRequired = null;
      proxy.clearInterrupt();
      this.runButton.innerHTML = runButtonHtml;
      this.runButton.title = QP_L.runTitle;
      this.runButton.onclick = () => this.runCode(this.getCode());
      qpyodideExecutionBusy = false;
      qpyodideSetRunButtonsEnabled(true);
    }
    this.lastRunCode = code;
    this.lastOutput  = text;
    return text;
  }

  /** For feedback: delivers the interpreter output of the last run.
   *  Feedback NEVER runs the code itself – that is always left to the user.
   *  This way, AI feedback always sees exactly what the user also saw. */
  async runForOutput() {
    const currentCode = this.getCode();
    if (this.lastOutput !== null && this.lastRunCode === currentCode) {
      return this.lastOutput;
    }
    if (this.lastOutput !== null) {
      // Code was changed since the last run
      return QP_L.outputChanged;
    }
    // Code has never been run
    const hasInput = qpyodideCodeHasInput(currentCode);
    if (hasInput) {
      return QP_L.outputNeedsInput;
    }
    return QP_L.outputNotRun;
  }
}

// ---------------------------------------------------------------------------
// Cell classes
// ---------------------------------------------------------------------------

/**
 * BaseCell – shared base for all cell types.
 */
class BaseCell {
  constructor(cellData) {
    this.code = cellData.code;
    this.id = cellData.id;
    this.options = cellData.options;
    this.insertionLocation = document.getElementById(
      `qpyodide-insertion-location-${this.id}`
    );
  }

  /** Called by CellContainer after Pyodide has started. */
  async runStartup() { /* default: nothing to do */ }
}

// ---------------------------------------------------------------------------
// Fold nudge: shown once, under a cell the reader just expanded by hand,
// offering to reveal every other still-folded cell in one click.
// ---------------------------------------------------------------------------

// Sets a fold <details>'s open state programmatically, marking it via the
// data attribute ONLY when the state actually changes. A same-state
// assignment (e.g. `.open = false` on a <details> that's already closed,
// the common case for a cell that starts folded) never fires a `toggle`
// event at all - flagging it anyway would leave the flag stuck forever,
// silently swallowing that cell's next *real* user click instead of the
// (nonexistent) programmatic event it was meant for. Used everywhere a
// fold state is set from code: initial cell construction, "Show/Hide All
// Code", and this nudge's own "show all" button.
function qpyodideSetFoldOpen(details, open) {
  if (details.open === open) return;
  details.dataset.qpyodideProgrammatic = "1";
  details.open = open;
}
globalThis.qpyodideSetFoldOpen = qpyodideSetFoldOpen;

let qpyodideFoldNudgeShown = false;

function qpyodideShowFoldNudge(cellDetails) {
  if (qpyodideFoldNudgeShown) return;
  // Only worth offering the shortcut when there's a real batch left to
  // reveal. If a single other cell is still folded, clicking it directly
  // is no more effort than clicking the nudge's own button, so it would
  // just be a nag for no benefit.
  const otherFoldedCount = Array.from(document.querySelectorAll(".qpyodide-code-fold"))
    .filter((details) => details !== cellDetails && !details.open).length;
  if (otherFoldedCount < 2) return;

  qpyodideFoldNudgeShown = true;

  const banner = document.createElement("div");
  banner.className = "qpyodide-fold-nudge";

  const text = document.createElement("span");
  text.textContent = QP_L.foldNudgeQuestion;
  banner.appendChild(text);

  const showAllBtn = document.createElement("button");
  showAllBtn.type = "button";
  showAllBtn.className = "btn btn-light btn-sm qpyodide-button";
  showAllBtn.textContent = QP_L.foldNudgeShowAll;
  showAllBtn.onclick = () => {
    document.querySelectorAll(".qpyodide-code-fold").forEach((details) => {
      qpyodideSetFoldOpen(details, true);
    });
    banner.remove();
  };
  banner.appendChild(showAllBtn);

  const dismissBtn = document.createElement("button");
  dismissBtn.type = "button";
  dismissBtn.className = "btn btn-light btn-sm qpyodide-button";
  dismissBtn.textContent = QP_L.foldNudgeDismiss;
  dismissBtn.onclick = () => banner.remove();
  banner.appendChild(dismissBtn);

  // Appended *inside* the <details> (not as a sibling after it): a closed
  // <details> natively hides its children, so folding this cell back up
  // hides the banner along with it instead of leaving it stranded on the
  // page for a reader who never clicks either button.
  cellDetails.appendChild(banner);
}

/**
 * InteractiveCell – collapsible cell with one (or, via "+ Code block",
 * two) EditorUnit(s).
 */
class InteractiveCell extends BaseCell {
  constructor(cellData) {
    super(cellData);
    this.units = [];
    this.setupElement();
  }

  setupElement() {
    const mainDiv = document.createElement("div");
    mainDiv.id = `qpyodide-interactive-area-${this.id}`;
    mainDiv.className = "qpyodide-interactive-area";
    if (this.options.classes) {
      mainDiv.className += " " + this.options.classes;
    }
    if (this.options.label) {
      mainDiv.setAttribute("data-id", this.options.label);
    }

    // Collapsible frame around the whole cell. Initial open/closed state
    // follows Quarto's `code-fold` (document/project default or this
    // cell's own `#| code-fold:` override), resolved ahead of time by the
    // Lua filter into this.options["code-fold"] ("hide" or "show").
    const details = document.createElement("details");
    details.className = "qpyodide-code-fold";
    qpyodideSetFoldOpen(details, this.options["code-fold"] !== "hide");
    // Distinguishes a reader manually opening this cell from any
    // programmatic change (initial state above, "Show/Hide All Code",
    // or the nudge's own "show all" button) via the flag those set.
    details.addEventListener("toggle", () => {
      if (details.dataset.qpyodideProgrammatic) {
        delete details.dataset.qpyodideProgrammatic;
        return;
      }
      if (details.open) {
        qpyodideShowFoldNudge(details);
      }
    });
    const summary = document.createElement("summary");
    summary.textContent = QP_L.showPythonCode;
    details.appendChild(summary);

    // Main editor
    const unitHost = document.createElement("div");
    details.appendChild(unitHost);
    this.primaryUnit = new EditorUnit({
      uid: String(this.id),
      code: this.code,
      options: this.options,
      hostDiv: unitHost
    });
    this.units.push(this.primaryUnit);

    // "+ Code block" button: appends ONE additional, empty, editable
    // editor below the cell (useful e.g. under read-only examples). Uses
    // the same EditorUnit class – no duplicates.
    const addCodeBlockButton = document.createElement("button");
    addCodeBlockButton.className = "btn btn-default qpyodide-button qpyodide-button-codeblock";
    addCodeBlockButton.type = "button";
    addCodeBlockButton.id = `qpyodide-button-codeblock-${this.id}`;
    addCodeBlockButton.title = QP_L.addCodeBlockTitle;
    addCodeBlockButton.innerHTML = QP_L.addCodeBlockLabel;
    this.primaryUnit.toolbarDiv
      .querySelector(".qpyodide-editor-toolbar-right-buttons")
      .appendChild(addCodeBlockButton);

    const thiz = this;
    addCodeBlockButton.onclick = function () {
      const extraHost = document.createElement("div");
      extraHost.className = "qpyodide-extra-codeblock";
      details.appendChild(extraHost);

      const extraOptions = { ...thiz.options, "read-only": "false", "autorun": "" };
      thiz.units.push(new EditorUnit({
        uid: `${thiz.id}.${thiz.units.length + 1}`,
        code: "",
        options: extraOptions,
        hostDiv: extraHost
      }));

      addCodeBlockButton.disabled = true;
    };

    mainDiv.appendChild(details);
    this.insertionLocation.appendChild(mainDiv);
  }

  /** autorun option: run the code once after Pyodide has started. */
  async runStartup() {
    if (this.options.autorun === "true") {
      await this.primaryUnit.runCode(this.code);
    }
  }
}

/**
 * OutputCell – runs the code at startup and shows only the output.
 */
class OutputCell extends BaseCell {
  constructor(cellData) {
    super(cellData);
    this.setupElement();
  }

  setupElement() {
    const mainDiv = document.createElement("div");
    mainDiv.id = `qpyodide-noninteractive-area-${this.id}`;
    mainDiv.className = "qpyodide-non-interactive-area";
    if (this.options.classes) {
      mainDiv.className += " " + this.options.classes;
    }
    if (this.options.label) {
      mainDiv.setAttribute("data-id", this.options.label);
    }

    // Loading indicator until the code has run at startup
    this.loadingContainer = document.createElement("div");
    this.loadingContainer.className =
      "qpyodide-non-interactive-loading-container qpyodide-cell-needs-evaluation";
    const statusText = document.createElement("p");
    statusText.className = "qpyodide-status-text qpyodide-cell-needs-evaluation";
    statusText.innerText = QP_L.runAtStartup;
    this.loadingContainer.appendChild(statusText);
    mainDiv.appendChild(this.loadingContainer);

    this.outputCodeDiv = document.createElement("div");
    this.outputCodeDiv.className = "qpyodide-output-code-area";
    this.outputCodeDiv.setAttribute("aria-live", "assertive");
    mainDiv.appendChild(this.outputCodeDiv);

    this.outputGraphDiv = document.createElement("div");
    this.outputGraphDiv.className = "qpyodide-output-graph-area";
    mainDiv.appendChild(this.outputGraphDiv);

    this.insertionLocation.appendChild(mainDiv);
  }

  // Idempotent: runs again after a hard worker restart without
  // duplicating output.
  async runStartup() {
    const result = await qpyodideExecutePython(
      this.code, globalThis.qpyodideCanvasWanted?.(this.options)
    );

    this.loadingContainer.remove();
    this.outputCodeDiv.innerHTML = "";
    this.outputGraphDiv.innerHTML = "";

    const hasText = qpyodideRenderTextOutput(this.outputCodeDiv, result.entries);
    if (result.html) {
      qpyodideRenderHtmlOutput(this.outputCodeDiv, result.html);
    }
    this.outputCodeDiv.classList.toggle("has-content", hasText || !!result.html);

    qpyodideRenderPlots(this.outputGraphDiv, result, this.options);
  }
}

/**
 * SetupCell – runs the code invisibly at startup.
 */
class SetupCell extends BaseCell {
  async runStartup() {
    // Output and any plots are deliberately discarded
    await qpyodideExecutePython(this.code);
  }
}

// ---------------------------------------------------------------------------
// Container + factory
// ---------------------------------------------------------------------------

/**
 * CellContainer – manages all cells in document order.
 */
class CellContainer {
  constructor() {
    this.cells = [];
  }

  addCell(cell) {
    this.cells.push(cell);
  }

  /**
   * Startup phase after Pyodide boots: first all setup cells, then
   * output cells, finally interactive cells with autorun.
   */
  async runStartupCells() {
    const order = { setup: 0, output: 1, interactive: 2 };
    const sorted = this.cells.slice().sort((a, b) =>
      (order[a.options.context] ?? 2) - (order[b.options.context] ?? 2)
    );
    for (const cell of sorted) {
      try {
        await cell.runStartup();
      } catch (err) {
        console.error(`qpyodide: startup phase of cell ${cell.id} failed`, err);
      }
    }
  }
}

/**
 * Factory function to create different types of cells based on options.
 * @param {Object} cellData - JSON object containing code, id, and options.
 * @returns {BaseCell} Instance of the appropriate cell class.
 */
globalThis.qpyodideCreateCell = function(cellData) {
  switch (cellData.options.context) {
    case "interactive":
      return new InteractiveCell(cellData);
    case "output":
      return new OutputCell(cellData);
    case "setup":
      return new SetupCell(cellData);
    default:
      return new InteractiveCell(cellData);
  }
}

// Global container that qpyodide-cell-initialization.js populates
globalThis.qpyodideCellContainer = new CellContainer();
