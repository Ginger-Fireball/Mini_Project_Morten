// qpyodide-document-engine-initialization.js – start Pyodide in a Web Worker
//
// Core idea: Python runs in its own thread (Web Worker). This keeps the page
// fully responsive during execution – even for long computations. The
// worker is created as a blob module worker directly from this file (the
// extension only injects inline scripts).
//
// Aborting a running execution:
//   * page is cross-origin isolated (COOP/COEP headers set):
//     graceful abort via SharedArrayBuffer + setInterruptBuffer
//     (KeyboardInterrupt, variables are preserved).
//   * otherwise: hard restart of the worker (variables are lost,
//     setup/output/autorun cells run again afterwards).
//
// Global interfaces for other modules/extensions:
//   qpyodideReady    – Promise that resolves with the Pyodide proxy
//   qpyodideInstance – alias for the same Promise (compatibility, used
//                      e.g. by Erasmus-CTM/py-exercise)
//   mainPyodide      – the proxy (set once the worker is ready);
//                      offers runPythonAsync, loadPackagesFromImports,
//                      loadPackage, globals.set, and toPy as RPC variants

// ---------------------------------------------------------------------------
// Worker source (runs in the background thread)
// ---------------------------------------------------------------------------
// Important: String.raw, so escape sequences arrive in the worker unchanged.
// Don't use backticks or "dollar-curly-brace" in the worker source!

const qpyodideWorkerSource = String.raw`
// Pyodide worker of the pyodide-interaktiv extension
let pyodide = null;
let runEntries = [];

// Input buffer for Atomics-based stdin (null if unavailable)
let inputStatusBuf = null;   // Int32Array(SharedArrayBuffer) 0=idle 1=waiting 2=ready 3=aborted
let inputDataBuf   = null;   // Uint8Array(SharedArrayBuffer) UTF-8-encoded input (null-terminated)

// Prompt text of the next input() call (set by Python via _qpyodide_set_prompt)
let pendingInputPrompt = "";
self._qpyodide_set_prompt = (p) => { pendingInputPrompt = String(p); };

// Python setup: matplotlib on AGG (PNG rendering without DOM), plt.show() as
// the output trigger like in a local script, a figure collector, and the
// zeige_animation() helper for special cases like GIF output.
const PY_SETUP = [
  "import matplotlib",
  "matplotlib.use('AGG')",
  "from matplotlib import pyplot as plt",
  "",
  "# Track animations. Without a GUI there is no timer driving a",
  "# FuncAnimation - when shown it therefore has to become a JS player",
  "# instead of a still image. For that, the animation belonging to a",
  "# figure needs to be findable, and matplotlib keeps no registry for it.",
  "# We hook into Animation.__init__ so that FuncAnimation and",
  "# ArtistAnimation are captured alike (both call it via super()). The",
  "# entry also keeps the animation alive - otherwise matplotlib warns",
  "# 'Animation was deleted without rendering anything' if nobody assigns",
  "# it to a variable.",
  "import matplotlib.animation as _qanim",
  "_qpyodide_animations = []",
  "def _qpyodide_anim_init(self, *args, _orig=_qanim.Animation.__init__, **kwargs):",
  "    _orig(self, *args, **kwargs)",
  "    _qpyodide_animations.append(self)",
  "_qanim.Animation.__init__ = _qpyodide_anim_init",
  "del _qanim, _qpyodide_anim_init",
  "",
  "# Display exactly like in a local script: plt.show() is the trigger.",
  "# Without a call, nothing is output; with a call, everything currently",
  "# open appears. The shown figures are closed in the process - locally,",
  "# closing the windows is exactly what ends a blocking show(), and a",
  "# following plt.plot() starts a new figure instead of drawing into the",
  "# old one.",
  "# A custom show() replacement is necessary anyway: AGG isn't",
  "# interactive, the real plt.show() would do nothing except warn.",
  "_qpyodide_shown       = []   # figures that get output as PNG",
  "_qpyodide_shown_anims = []   # already-rendered animation players (HTML)",
  "_qpyodide_anim_errors = []",
  "",
  "def _qpyodide_show_figure(fig):",
  "    # If an animation is attached to the figure, it becomes a JS player.",
  "    # If that fails, the figure falls back to the normal PNG path - the",
  "    # same fallback pattern as for the pickles.",
  "    for ani in _qpyodide_animations:",
  "        if getattr(ani, '_fig', None) is not fig:",
  "            continue",
  "        try:",
  "            _qpyodide_shown_anims.append(ani.to_jshtml())",
  "            plt.close(fig)",
  "            return",
  "        except Exception as exc:",
  "            _qpyodide_anim_errors.append(type(exc).__name__ + ': ' + str(exc))",
  "            break",
  "    _qpyodide_shown.append(fig)",
  "    plt.close(fig)",
  "",
  "def _qpyodide_show(*args, **kwargs):",
  "    # get_fignums() returns a copy, so closing inside the loop is fine.",
  "    for num in plt.get_fignums():",
  "        _qpyodide_show_figure(plt.figure(num))",
  "plt.show = _qpyodide_show",
  "",
  "# fig.show() shows only that one figure (non-blocking in a script).",
  "import matplotlib.figure as _qfigmod",
  "def _qpyodide_figure_show(self, *args, **kwargs):",
  "    _qpyodide_show_figure(self)",
  "_qfigmod.Figure.show = _qpyodide_figure_show",
  "del _qfigmod, _qpyodide_figure_show",
  "",
  "def _qpyodide_collect_figures(want_pickle=False):",
  "    # Outputs what plt.show() released. Always as PNG; additionally as",
  "    # pickle if the main thread wants to redraw the figure interactively",
  "    # (see qpyodide-canvas-plots.js). Order: pickle first, then save -",
  "    # savefig attaches a renderer to the figure that shouldn't be",
  "    # pickled along with it.",
  "    import base64, io, pickle, warnings",
  "    animations  = list(_qpyodide_shown_anims)",
  "    anim_errors = list(_qpyodide_anim_errors)",
  "    images, pickles, errors = [], [], []",
  "    for fig in _qpyodide_shown:",
  "        if want_pickle:",
  "            try:",
  "                # Matplotlib internally stores an itertools color cycle when",
  "                # pickling; Python 3.14 warns about this (pickle support is",
  "                # going away) - pure library noise, so deliberately silenced.",
  "                with warnings.catch_warnings():",
  "                    warnings.filterwarnings('ignore', category=DeprecationWarning, message='.*itertools.*')",
  "                    pickles.append(base64.b64encode(pickle.dumps(fig)).decode('ascii'))",
  "                errors.append('')",
  "            except Exception as exc:",
  "                pickles.append('')",
  "                errors.append(type(exc).__name__ + ': ' + str(exc))",
  "        buf = io.BytesIO()",
  "        fig.savefig(buf, format='png', bbox_inches='tight')",
  "        images.append(base64.b64encode(buf.getvalue()).decode('ascii'))",
  "    _qpyodide_shown.clear()",
  "    _qpyodide_shown_anims.clear()",
  "    _qpyodide_anim_errors.clear()",
  "    _qpyodide_animations.clear()",
  "    # Discard figures that were never shown: a cell run corresponds to a",
  "    # script run, after which the figure state is empty again. Otherwise",
  "    # figures would pile up across repeated runs of the same cell, and a",
  "    # later plt.show() would output all of them at once.",
  "    plt.close('all')",
  "    return images, pickles, errors, animations, anim_errors",
  "",
  "",
  "# Intercept the input() prompt: Pyodide buffers stdout line by line, so",
  "# the prompt (no \\n) would never reach the main thread. Instead we write",
  "# it via js._qpyodide_set_prompt into a JS variable, which stdin() reads",
  "# on the next call and sends along with inputRequired.",
  "# _orig is bound via a default argument at definition time (stays intact",
  "# even after the helper names are deleted from the namespace).",
  "import builtins as _qbt",
  "def _qpyodide_input(prompt='', _orig=_qbt.input):",
  "    import js",
  "    js._qpyodide_set_prompt(str(prompt))",
  "    return _orig('')",
  "_qbt.input = _qpyodide_input",
  "del _qbt, _qpyodide_input",
  "",
  "def zeige_animation(ani, format='jshtml', fps=None):",
  "    # Returns a matplotlib animation as embeddable HTML.",
  "    # Not needed for normal display - plt.show() already outputs an",
  "    # animation as a player on its own (see _qpyodide_show_figure). This",
  "    # call remains useful when you want to control the format or frame",
  "    # rate.",
  "    # format='jshtml': interactive JS player (default)",
  "    # format='gif'   : animated GIF as <img> (requires the 'Pillow' package)",
  "    from matplotlib import pyplot as plt",
  "    if format == 'gif':",
  "        import base64, os, tempfile",
  "        from matplotlib.animation import PillowWriter",
  "        writer = PillowWriter(fps=fps or 10)",
  "        with tempfile.NamedTemporaryFile(suffix='.gif', delete=False) as tmp:",
  "            path = tmp.name",
  "        try:",
  "            ani.save(path, writer=writer)",
  "            with open(path, 'rb') as fh:",
  "                data = base64.b64encode(fh.read()).decode('ascii')",
  "        finally:",
  "            os.remove(path)",
  "        html = '<img src=\"data:image/gif;base64,' + data + '\" alt=\"Animation\"/>'",
  "    else:",
  "        html = ani.to_jshtml(fps=fps) if fps else ani.to_jshtml()",
  "    plt.close(ani._fig)",
  "    return html"
].join("\n");

// stdin: blocks the worker thread until the user enters something.
// Called by Pyodide as the stdin handler when Python executes input().
// First sends a request to the main thread, then the worker waits via
// Atomics.wait (blocks only the worker thread, not the page).
// If no SharedArrayBuffer is available, stdin returns null (EOF).
function stdin() {
  if (!inputStatusBuf || !inputDataBuf) return null;
  const prompt = pendingInputPrompt;
  pendingInputPrompt = "";
  Atomics.store(inputStatusBuf, 0, 1);              // status: waiting
  self.postMessage({ type: "inputRequired", prompt }); // notify the main thread
  Atomics.wait(inputStatusBuf, 0, 1);               // block until status != 1
  const status = Atomics.load(inputStatusBuf, 0);
  Atomics.store(inputStatusBuf, 0, 0);              // status: idle
  if (status !== 2) return null;                    // aborted (status 3) -> EOF
  let end = 0;
  while (end < inputDataBuf.length && inputDataBuf[end] !== 0) end++;
  return new TextDecoder().decode(inputDataBuf.slice(0, end)) + "\n";
}

function postStatus(text) {
  self.postMessage({ type: "status", text: text });
}

// Does a return value look like (whole) HTML?
function looksLikeHtml(text) {
  const trimmed = text.trim();
  return trimmed.startsWith("<") && /<\/?[a-zA-Z][^>]*>/.test(trimmed) && trimmed.endsWith(">");
}

async function init(config) {
  // Translated status texts come along from the main thread (the worker doesn't know QP_L)
  const msg = config.messages || {};
  const mod = await import(config.indexURL + "pyodide.mjs");

  postStatus(msg.workerLoading || "Loading Python (Pyodide) ...");
  pyodide = await mod.loadPyodide({
    indexURL: config.indexURL,
    env: config.env,
    stdin: stdin,
    stdout: function(text) {
      runEntries.push({ message: text, type: "stdout" });
      self.postMessage({ type: "streamStdout", text: text });
    },
    stderr: function(text) {
      runEntries.push({ message: text, type: "stderr" });
      self.postMessage({ type: "streamStderr", text: text });
    }
  });

  postStatus(msg.workerInitPackages || "Initialising Python packages ...");
  await pyodide.loadPackage("micropip");

  // Packages requested by the document (pyodide: packages: [...])
  if (config.packages && config.packages.length > 0) {
    postStatus(msg.workerExtraPackages || "Installing additional packages ...");
    const micropip = pyodide.pyimport("micropip");
    await micropip.install(config.packages);
    micropip.destroy();
  }

  // Shim requests/urllib3 (synchronous XHR is allowed in the worker)
  await pyodide.loadPackage("pyodide_http");
  await pyodide.runPythonAsync("import pyodide_http\npyodide_http.patch_all()");

  await pyodide.loadPackage("matplotlib");
  await pyodide.runPythonAsync(PY_SETUP);
}

// Run one document cell: collect output, detect an HTML return value,
// collect animated figures as a JS player and the remaining open
// matplotlib figures as PNG (base64). With wantPickle, the PNG figures
// additionally come along as pickle, so a second Pyodide instance on the
// main thread can redraw them interactively.
async function runCell(code, wantPickle) {
  runEntries = [];
  let resultValue;
  try {
    await pyodide.loadPackagesFromImports(code);
    resultValue = await pyodide.runPythonAsync(code);
  } catch (err) {
    // An uncaught Python exception never goes through the stdout/stderr
    // callbacks above (those only see explicit prints); runPythonAsync
    // instead rejects with the formatted traceback as its message. Stream
    // it live too - interactive cells only render stdout/stderr via the
    // live stream (see runCode() in qpyodide-cell-classes.js), not from
    // this function's return value, so without this an uncaught exception
    // would silently show nothing at all in the terminal.
    const message = String(err);
    runEntries.push({ message: message, type: "stderr" });
    self.postMessage({ type: "streamStderr", text: message });
  }

  let html = null;
  if (resultValue !== undefined && resultValue !== null) {
    const asText = String(resultValue);
    if (typeof resultValue === "object" && typeof resultValue.destroy === "function") {
      resultValue.destroy();
    }
    if (looksLikeHtml(asText)) {
      html = asText;
    } else {
      runEntries.push({ message: asText, type: "stdout" });
    }
  }

  let images = [];
  let pickles = [];
  let pickleErrors = [];
  let animations = [];
  let animationErrors = [];
  try {
    const collect = pyodide.globals.get("_qpyodide_collect_figures");
    const proxy = collect(!!wantPickle);
    const collected = proxy.toJs();
    images      = collected[0];
    pickles     = collected[1];
    pickleErrors = collected[2];
    animations  = collected[3];
    animationErrors = collected[4];
    proxy.destroy();
    collect.destroy();
  } catch (err) {
    runEntries.push({ message: "Plot export failed: " + String(err), type: "stderr" });
  }

  return {
    entries: runEntries,
    html: html,
    images: images,
    pickles: pickles,
    pickleErrors: pickleErrors,
    animations: animations,
    animationErrors: animationErrors
  };
}

// Raw Python call (RPC variant of runPythonAsync, e.g. for
// py-exercise). Result must be structured-clone-capable.
async function runPythonRaw(code) {
  const result = await pyodide.runPythonAsync(code);
  if (result && typeof result.toJs === "function") {
    let value;
    try {
      value = result.toJs({ dict_converter: Object.fromEntries, create_pyproxies: false });
    } catch (err) {
      value = String(result);
    }
    result.destroy();
    return value;
  }
  return result;
}

self.onmessage = async function(event) {
  const msg = event.data;
  try {
    let value = true;
    switch (msg.type) {
      case "init":
        await init(msg.config);
        break;
      case "setInterrupt":
        pyodide.setInterruptBuffer(msg.buffer);
        break;
      case "setInputBuffers":
        inputStatusBuf = msg.inputStatusBuf;
        inputDataBuf   = msg.inputDataBuf;
        break;
      case "runCell":
        value = await runCell(msg.code, msg.wantPickle);
        break;
      case "runPython":
        value = await runPythonRaw(msg.code);
        break;
      case "loadPackagesFromImports":
        await pyodide.loadPackagesFromImports(msg.code);
        break;
      case "loadPackage":
        await pyodide.loadPackage(msg.name);
        break;
      case "setGlobal":
        pyodide.globals.set(msg.name, pyodide.toPy(msg.value));
        break;
      default:
        throw new Error("Unknown command: " + msg.type);
    }
    self.postMessage({ type: "result", id: msg.id, value: value });
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, message: String((err && err.message) || err) });
  }
};
`;

// ---------------------------------------------------------------------------
// Main thread: start the worker + provide the RPC proxy
// ---------------------------------------------------------------------------

function qpyodideBootPyodideWorker() {
  const pending = new Map();
  let nextId = 1;

  const blobUrl = URL.createObjectURL(
    new Blob([qpyodideWorkerSource], { type: "text/javascript" })
  );
  const worker = new Worker(blobUrl, { type: "module" });

  function rpc(type, payload = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ type, id, ...payload });
    });
  }

  worker.onmessage = (event) => {
    const msg = event.data;
    if (msg.type === "status")      { qpyodideUpdateStatusHeaderSpinner(msg.text); return; }
    if (msg.type === "streamStdout") { proxy.onStream?.(msg.text, "stdout"); return; }
    if (msg.type === "streamStderr") { proxy.onStream?.(msg.text, "stderr"); return; }
    if (msg.type === "inputRequired") { proxy.onInputRequired?.(msg.prompt ?? ""); return; }
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.type === "error") {
      entry.reject(new Error(msg.message));
    } else {
      entry.resolve(msg.value);
    }
  };

  worker.onerror = (event) => {
    console.error("qpyodide: error in the Pyodide worker", event);
  };

  // Proxy object: what `await qpyodideReady` / `mainPyodide` resolves to.
  // The Pyodide-like methods are RPC variants, so that extensions like
  // py-exercise keep working (postMessage guarantees ordering, so e.g.
  // globals.set may be called without await before runPythonAsync).
  const proxy = {
    isWorkerProxy: true,
    interruptBuffer: null,
    inputStatusBuf: null,     // Int32Array(SharedArrayBuffer) – input status
    inputDataBuf: null,       // Uint8Array(SharedArrayBuffer) – input data (UTF-8)
    onStream: null,           // Callback(text, type) – streamed stdout/stderr
    onInputRequired: null,    // Callback() – Python is waiting for input

    runCell: (code, wantPickle) => rpc("runCell", { code, wantPickle }),
    runPythonAsync: (code) => rpc("runPython", { code }),
    loadPackagesFromImports: (code) => rpc("loadPackagesFromImports", { code }),
    loadPackage: (name) => rpc("loadPackage", { name }),
    toPy: (value) => value,   // conversion happens worker-side
    globals: {
      set: (name, value) => rpc("setGlobal", { name, value })
    },

    /** Graceful abort (KeyboardInterrupt) – only with SharedArrayBuffer. */
    interrupt() {
      if (this.interruptBuffer) this.interruptBuffer[0] = 2;   // SIGINT
      this.abortInput();
    },
    clearInterrupt() {
      if (this.interruptBuffer) this.interruptBuffer[0] = 0;
    },

    /** Aborts a pending input() wait in the worker (status 3 = aborted). */
    abortInput() {
      if (this.inputStatusBuf && Atomics.load(this.inputStatusBuf, 0) === 1) {
        Atomics.store(this.inputStatusBuf, 0, 3);
        Atomics.notify(this.inputStatusBuf, 0, 1);
      }
    },

    /** Delivers an input value to the waiting worker (status 2 = ready). */
    provideInput(text) {
      if (!this.inputStatusBuf || !this.inputDataBuf) return;
      const encoded = new TextEncoder().encode(text);
      this.inputDataBuf.fill(0);
      this.inputDataBuf.set(encoded.slice(0, this.inputDataBuf.length - 1));
      Atomics.store(this.inputStatusBuf, 0, 2);
      Atomics.notify(this.inputStatusBuf, 0, 1);
    },

    /**
     * Hard restart: terminate the worker, reject all pending calls, and
     * boot a fresh runtime (startup cells run again).
     */
    restart(reason) {
      worker.terminate();
      const error = new Error(reason || "Python was restarted.");
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();

      globalThis.mainPyodide = undefined;
      globalThis.qpyodideReady = qpyodideBootPyodideWorker();
      globalThis.qpyodideInstance = globalThis.qpyodideReady;
      globalThis.qpyodideReady.then(() => {
        return globalThis.qpyodideCellContainer?.runStartupCells();
      }).catch((err) => console.error("qpyodide: restart failed", err));
    }
  };

  return (async () => {
    qpyodideUpdateStatusHeaderSpinner(QP_L.workerLoading);
    const timerStart = performance.now();

    try {
      await rpc("init", {
        config: {
          indexURL: qpyodideCustomizedPyodideOptions.indexURL,
          env: qpyodideCustomizedPyodideOptions.env,
          packages: qpyodideSetupPythonPackages ? qpyodideInstallPythonPackagesList : [],
          messages: {
            workerLoading:       QP_L.workerLoading,
            workerInitPackages:  QP_L.workerInitPackages,
            workerExtraPackages: QP_L.workerExtraPackages
          }
        }
      });
    } catch (err) {
      qpyodideUpdateStatusHeader(QP_L.engineFailed(err.message));
      throw err;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }

    // Enable the shared buffer if the page is cross-origin isolated.
    // Interrupt buffer: graceful abort (KeyboardInterrupt).
    // Input buffer: Atomics-based input() (Python pauses via Atomics.wait).
    if (globalThis.crossOriginIsolated && typeof SharedArrayBuffer !== "undefined") {
      try {
        proxy.interruptBuffer = new Uint8Array(new SharedArrayBuffer(1));
        await rpc("setInterrupt", { buffer: proxy.interruptBuffer });

        proxy.inputStatusBuf = new Int32Array(new SharedArrayBuffer(4));
        proxy.inputDataBuf   = new Uint8Array(new SharedArrayBuffer(4096));
        await rpc("setInputBuffers", {
          inputStatusBuf: proxy.inputStatusBuf,
          inputDataBuf:   proxy.inputDataBuf
        });
      } catch (err) {
        proxy.interruptBuffer = null;
        proxy.inputStatusBuf  = null;
        proxy.inputDataBuf    = null;
        console.warn("qpyodide: shared buffer unavailable", err);
      }
    }

    globalThis.mainPyodide = proxy;

    qpyodideSetInteractiveButtonState(QP_L.runLabel, true);
    qpyodideUpdateStatusHeader(QP_L.engineReady);

    const elapsed = (performance.now() - timerStart) / 1000;
    console.log(`qpyodide: Pyodide worker ready after ${elapsed.toFixed(1)}s`);

    return proxy;
  })();
}

globalThis.qpyodideReady = qpyodideBootPyodideWorker();

// Compatibility alias: older extensions (e.g. py-exercise) expect
// `qpyodideInstance` and `await` on it.
globalThis.qpyodideInstance = qpyodideReady;

// Create a function to retrieve the promise object.
globalThis._qpyodideGetInstance = function() {
  return globalThis.qpyodideInstance;
}
