// qpyodide-feedback.js – AI feedback module (ONE implementation for all cells)
//
// Provides `globalThis.qpyodideFeedback`:
//   attach(unit)     – wires up the feedback button of an editor unit;
//                      `unit` provides { uid, feedbackButton, feedbackDiv,
//                      getCode(), runForOutput() }
//   buildSettingsUI()– builds the (collapsible) settings panel
//
// Provider-neutral: any OpenAI-compatible endpoint works via
// POST {baseUrl}/chat/completions with a bearer key and a freely chosen
// model (OpenRouter, Cerebras, Groq, OpenAI, Ollama, …). NOTHING is
// guessed – in particular no model lookup via GET /models.
//
// Two modes:
//   "api"  – direct API call (default)
//   "copy" – generates a copyable prompt including the system prompt for
//            ChatGPT/Claude & co. (no API key needed)
//
// Configuration is stored, depending on the choice, in localStorage
// (persistent) or sessionStorage (per tab) – exclusively in the user's browser.

const qfOptions = globalThis.qpyodideFeedbackOptions ?? { enabled: false, storage: "local", hints: true };

const QF_STORAGE_KEY = "qpyodide-feedback-config";

// ---------------------------------------------------------------------------
// Load/save configuration
// ---------------------------------------------------------------------------

function qfLoadConfig() {
  for (const store of [localStorage, sessionStorage]) {
    try {
      const raw = store.getItem(QF_STORAGE_KEY);
      if (raw) {
        const cfg = JSON.parse(raw);
        cfg.storage = (store === localStorage) ? "local" : "session";
        return cfg;
      }
    } catch (e) { /* broken JSON or blocked storage -> ignore */ }
  }
  return { baseUrl: "", apiKey: "", model: "", mode: "api", storage: qfOptions.storage || "local" };
}

function qfSaveConfig(cfg) {
  const target = (cfg.storage === "session") ? sessionStorage : localStorage;
  const other  = (cfg.storage === "session") ? localStorage : sessionStorage;
  try {
    target.setItem(QF_STORAGE_KEY, JSON.stringify(cfg));
    other.removeItem(QF_STORAGE_KEY);
  } catch (e) {
    console.warn("qpyodide-feedback: failed to save configuration", e);
  }
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

// Prompts come from the locale table (qpyodide-locales.js), so the tutor
// responds in the page's language.
const QF_SYSTEM_PROMPT = QP_L.systemPrompt;

// Extra instruction per hint level (rises with the click count per cell)
const QF_HINT_INSTRUCTIONS = QP_L.hintInstructions;

function qfBuildUserPrompt(code, output, hintLevel) {
  let prompt =
    QP_L.promptCodeIntro + "\n```python\n" + code + "\n```\n\n" +
    QP_L.promptOutputIntro + "\n```\n" +
    (output && output.trim() ? output : QP_L.promptNoOutput) + "\n```";
  if (hintLevel > 0) {
    prompt += "\n\n" + (QF_HINT_INSTRUCTIONS[Math.min(hintLevel, 3)]);
  }
  return prompt;
}

// ---------------------------------------------------------------------------
// API call (OpenAI-compatible)
// ---------------------------------------------------------------------------

async function qfRequestFeedback(cfg, messages) {
  const endpoint = cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";

  const headers = { "Content-Type": "application/json" };
  if (cfg.apiKey) {
    headers["Authorization"] = `Bearer ${cfg.apiKey}`;
  }

  // Token limit is just a generous safety net against runaway output –
  // the actual length limit lives in the system prompt (~250 words).
  // This means feedback no longer gets cut off mid-sentence.
  // Modern approach: set both token fields; some providers reject one – in
  // that case, retry once without the rejected field.
  let body = {
    model: cfg.model,
    messages: messages,
    max_tokens: 2000,
    max_completion_tokens: 2000
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      // Remove the rejected token field and retry
      if (response.status === 400 && "max_completion_tokens" in body && /max_completion_tokens/.test(errorText)) {
        delete body.max_completion_tokens;
        continue;
      }
      if (response.status === 400 && "max_tokens" in body && /max_tokens/.test(errorText)) {
        delete body.max_tokens;
        continue;
      }
      throw new Error(`HTTP ${response.status} ${response.statusText}\n${errorText.slice(0, 600)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error(QP_L.errNoContent);
    }
    return content;
  }
  throw new Error(QP_L.errTokenRejected);
}

// ---------------------------------------------------------------------------
// Fetch model list (explicit click in the panel – no silent guessing)
// ---------------------------------------------------------------------------

// Is a model free? true/false, or null if the provider doesn't supply
// pricing info (e.g. Groq, Cerebras, Ollama).
function qfIsFreeModel(model) {
  if (typeof model.id === "string" && model.id.endsWith(":free")) return true;
  const pricing = model.pricing;
  if (pricing && ("prompt" in pricing || "completion" in pricing)) {
    return Number(pricing.prompt ?? 0) === 0 && Number(pricing.completion ?? 0) === 0;
  }
  return null;
}

async function qfFetchModels(baseUrl, apiKey) {
  const endpoint = baseUrl.replace(/\/+$/, "") + "/models";
  const headers = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const response = await fetch(endpoint, { headers });
  if (!response.ok) {
    const errorText = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${response.statusText}\n${errorText.slice(0, 300)}`);
  }

  const data = await response.json();
  const list = Array.isArray(data.data) ? data.data
             : Array.isArray(data.models) ? data.models
             : [];
  return list
    .map((model) => ({ id: model.id || model.name, free: qfIsFreeModel(model) }))
    .filter((model) => typeof model.id === "string" && model.id);
}

// ---------------------------------------------------------------------------
// Rendering (safe: model output is escaped, then mini-Markdown)
// ---------------------------------------------------------------------------

function qfEscapeHtml(text) {
  return text
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Very small Markdown subset: ```code blocks```, `inline code`, **bold**
function qfRenderMarkdownLite(text) {
  const parts = text.split(/```(?:[a-zA-Z0-9_-]*\n)?/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // Content between ``` fences
      html += "<pre class='qpyodide-feedback-code'><code>" + qfEscapeHtml(parts[i]) + "</code></pre>";
    } else {
      let chunk = qfEscapeHtml(parts[i]);
      chunk = chunk.replace(/`([^`\n]+)`/g, "<code>$1</code>");
      chunk = chunk.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
      chunk = chunk.replace(/\n/g, "<br>");
      html += chunk;
    }
  }
  return html;
}

// The settings panel can be living inside `targetDiv` (qfOpenSettingsNear
// moved it there earlier); wiping innerHTML would silently detach it. Move
// it back home first so it's never lost, just relocated.
function qfClearTargetDiv(targetDiv) {
  if (qfUi.panel && qfUi.homeParent && targetDiv.contains(qfUi.panel)) {
    qfUi.homeParent.appendChild(qfUi.panel);
  }
  targetDiv.innerHTML = "";
}

function qfRenderFeedback(targetDiv, feedbackText, hintLevel) {
  qfClearTargetDiv(targetDiv);

  const header = document.createElement("div");
  header.className = "qpyodide-feedback-header";
  header.textContent = QP_L.feedbackHeader +
    (hintLevel > 0 ? QP_L.feedbackHintLevel(Math.min(hintLevel, 3)) : "") + ":";
  targetDiv.appendChild(header);

  const bodyDiv = document.createElement("div");
  bodyDiv.className = "qpyodide-feedback-body";
  bodyDiv.innerHTML = qfRenderMarkdownLite(feedbackText);
  targetDiv.appendChild(bodyDiv);

  targetDiv.classList.add("has-content");
}

// `showSettingsLink`: adds a button that relocates the settings panel
// right into `targetDiv` instead of making the reader hunt for the gear
// icon at the top of the page - used for the "not configured yet" error.
function qfRenderError(targetDiv, message, { showSettingsLink = false } = {}) {
  qfClearTargetDiv(targetDiv);

  const box = document.createElement("div");
  box.className = "qpyodide-feedback-error";
  const header = document.createElement("strong");
  header.textContent = QP_L.feedbackErrorHeader;
  const text = document.createElement("span");
  text.textContent = message;
  box.appendChild(header);
  box.appendChild(text);

  if (showSettingsLink) {
    const gearBtn = document.createElement("button");
    gearBtn.type = "button";
    gearBtn.className = "btn btn-light btn-sm qpyodide-button qpyodide-feedback-error-gear";
    gearBtn.innerHTML = '<i class="fa-solid fa-gear"></i> ' + QP_L.gearTitle;
    // Moves the settings panel right into this cell's feedback area
    // (appended after `box` below) instead of sending the reader to the
    // top of the page.
    gearBtn.onclick = () => qfOpenSettingsNear(targetDiv);
    box.appendChild(gearBtn);
  }

  targetDiv.appendChild(box);

  targetDiv.classList.add("has-content");
}

// Box with a copyable prompt ("Copy prompt" mode, including the system prompt)
function qfRenderCopyPrompt(targetDiv, promptText) {
  qfClearTargetDiv(targetDiv);

  const header = document.createElement("div");
  header.className = "qpyodide-feedback-header";
  header.textContent = QP_L.copyPromptHeader;
  targetDiv.appendChild(header);

  const pre = document.createElement("pre");
  pre.className = "qpyodide-feedback-code qpyodide-feedback-copyprompt";
  pre.textContent = promptText;
  targetDiv.appendChild(pre);

  const copyBtn = document.createElement("button");
  copyBtn.className = "btn btn-default qpyodide-button";
  copyBtn.type = "button";
  copyBtn.textContent = QP_L.copyPromptBtn;
  copyBtn.onclick = function() {
    navigator.clipboard.writeText(promptText).then(function() {
      copyBtn.textContent = QP_L.copyPromptDone;
      setTimeout(function() { copyBtn.textContent = QP_L.copyPromptBtn; }, 2000);
    });
  };
  targetDiv.appendChild(copyBtn);

  targetDiv.classList.add("has-content");
}

// ---------------------------------------------------------------------------
// Settings panel
// ---------------------------------------------------------------------------

const qfUi = {};   // references to the panel's UI elements

function qfMakeField(labelText, input) {
  // <div> instead of <label> avoids the double-click issue on <select> wrappers
  const wrapper = document.createElement("div");
  wrapper.className = "qpyodide-feedback-field";
  const span = document.createElement("span");
  span.textContent = labelText;
  wrapper.appendChild(span);
  wrapper.appendChild(input);
  return wrapper;
}

function qfBuildHelpBox() {
  const helpDiv = document.createElement("div");
  helpDiv.className = "qpyodide-feedback-help";
  helpDiv.style.display = "none";
  helpDiv.innerHTML = QP_L.helpBox;
  return helpDiv;
}

// Provider presets: fill in base URL + example model with a click, so
// beginners don't have to type anything themselves. The key comes from the user.
const QF_PROVIDER_PRESETS = {
  cerebras:   { label: QP_L.presetCerebras,   baseUrl: "https://api.cerebras.ai/v1",  model: "gpt-oss-120b",                          modelsUrl: "https://inference-docs.cerebras.ai/models/overview" },
  openrouter: { label: QP_L.presetOpenrouter, baseUrl: "https://openrouter.ai/api/v1", model: "meta-llama/llama-3.3-70b-instruct:free", modelsUrl: "https://openrouter.ai/models?max_price=0" },
  openai:     { label: QP_L.presetOpenai,     baseUrl: "https://api.openai.com/v1",    model: "gpt-4o-mini",                           modelsUrl: "https://platform.openai.com/docs/models" },
  ollama:     { label: QP_L.presetOllama,     baseUrl: "http://localhost:11434/v1",    model: "" }
};

function qfBuildSettingsUI() {
  const cfg = qfLoadConfig();

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "btn btn-light btn-sm qpyodide-button qpyodide-feedback-toggle";
  toggleBtn.innerHTML = '<i class="fa-solid fa-gear"></i>';
  toggleBtn.title = QP_L.gearTitle;

  const statusSpan = document.createElement("span");
  statusSpan.className = "qpyodide-feedback-settings-status";

  const panel = document.createElement("div");
  panel.className = "qpyodide-feedback-panel";

  // Provider preset (fills in base URL + example model)
  const presetSelect = document.createElement("select");
  presetSelect.add(new Option(QP_L.presetPlaceholder, ""));
  for (const [key, preset] of Object.entries(QF_PROVIDER_PRESETS)) {
    presetSelect.add(new Option(preset.label, key));
  }

  // Input fields
  const baseUrlInput = document.createElement("input");
  baseUrlInput.type = "text";
  baseUrlInput.placeholder = QP_L.phBaseUrl;
  baseUrlInput.value = cfg.baseUrl || "";
  baseUrlInput.autocomplete = "off";

  const apiKeyInput = document.createElement("input");
  apiKeyInput.type = "password";
  apiKeyInput.placeholder = QP_L.phApiKey;
  apiKeyInput.value = cfg.apiKey || "";
  apiKeyInput.autocomplete = "off";

  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.placeholder = QP_L.phModel;
  modelInput.value = cfg.model || "";
  modelInput.autocomplete = "off";

  const modeSelect = document.createElement("select");
  const optApi = new Option(QP_L.modeApi, "api");
  const optCopy = new Option(QP_L.modeCopy, "copy");
  modeSelect.add(optApi);
  modeSelect.add(optCopy);
  modeSelect.value = cfg.mode || "api";


  presetSelect.onchange = () => {
    const preset = QF_PROVIDER_PRESETS[presetSelect.value];
    if (preset) {
      baseUrlInput.value = preset.baseUrl;
      modelInput.value = "";
      modelHintEl.style.display = "none";
      modelHintEl.innerHTML = "";
      doFetchModels(true);
    }
  };

  // "Fetch models": queries {baseUrl}/models and shows a picker list,
  // filtered to free models by default (so nobody accidentally spends money).
  const fetchModelsBtn = document.createElement("button");
  fetchModelsBtn.type = "button";
  fetchModelsBtn.className = "btn btn-light btn-sm qpyodide-button";
  fetchModelsBtn.innerHTML = QP_L.fetchModelsBtn;

  const modelRow = document.createElement("div");
  modelRow.className = "qpyodide-feedback-inputrow";
  modelRow.appendChild(modelInput);
  modelRow.appendChild(fetchModelsBtn);

  const modelHintEl = document.createElement("div");
  modelHintEl.style.cssText = "font-size:0.85em;color:#888;margin-top:3px;display:none";

  const modelListDiv = document.createElement("div");
  modelListDiv.className = "qpyodide-feedback-modellist";
  modelListDiv.style.display = "none";

  const modelListInfo = document.createElement("div");
  modelListInfo.className = "qpyodide-feedback-modellist-info";

  const freeOnlyLabel = document.createElement("label");
  const freeOnlyCheckbox = document.createElement("input");
  freeOnlyCheckbox.type = "checkbox";
  freeOnlyCheckbox.checked = true;
  freeOnlyLabel.appendChild(freeOnlyCheckbox);
  freeOnlyLabel.appendChild(document.createTextNode(QP_L.freeOnlyLabel));

  const modelPicker = document.createElement("select");

  modelListDiv.appendChild(modelListInfo);
  modelListDiv.appendChild(freeOnlyLabel);
  modelListDiv.appendChild(modelPicker);

  let fetchedModels = [];

  function renderModelList() {
    const hasPricingInfo = fetchedModels.some((model) => model.free !== null);
    freeOnlyLabel.style.display = hasPricingInfo ? "block" : "none";

    let models = fetchedModels;
    if (hasPricingInfo && freeOnlyCheckbox.checked) {
      models = models.filter((model) => model.free === true);
    }
    // Free ones first, then alphabetically
    models = models.slice().sort((a, b) =>
      (b.free === true) - (a.free === true) || a.id.localeCompare(b.id)
    );

    modelPicker.innerHTML = "";
    modelPicker.style.display = "";
    modelPicker.add(new Option(QP_L.modelChoose(models.length), ""));
    models.forEach((model) => {
      const suffix = model.free === true ? QP_L.modelSuffixFree
                   : model.free === false ? QP_L.modelSuffixPaid
                   : "";
      modelPicker.add(new Option(model.id + suffix, model.id));
    });

    modelListInfo.textContent = hasPricingInfo
      ? QP_L.modelListInfoPricing
      : QP_L.modelListInfoNoPricing;
    modelListDiv.style.display = "block";
  }

  freeOnlyCheckbox.onchange = renderModelList;

  modelPicker.onchange = () => {
    if (modelPicker.value) {
      modelInput.value = modelPicker.value;
    }
  };

  // Fetch models – via button (isAuto=false) or automatically after
  // choosing a preset (isAuto=true). The auto-fetch often fails without a
  // key/due to CORS; in that case the pre-filled example model stays as a
  // fallback and the message stays gentle instead of a red error.
  async function doFetchModels(isAuto) {
    const baseUrl = baseUrlInput.value.trim();
    if (!baseUrl) {
      if (isAuto) return;
      modelListInfo.textContent = QP_L.errNeedBaseUrl;
      freeOnlyLabel.style.display = "none";
      modelPicker.innerHTML = "";
      modelPicker.style.display = "none";
      modelListDiv.style.display = "block";
      return;
    }

    const originalLabel = fetchModelsBtn.innerHTML;
    fetchModelsBtn.disabled = true;
    fetchModelsBtn.innerHTML = QP_L.fetchModelsBusy;
    try {
      fetchedModels = await qfFetchModels(baseUrl, apiKeyInput.value.trim());
      if (fetchedModels.length === 0) {
        throw new Error(QP_L.errNoModels);
      }
      const freeOnes = fetchedModels.filter((m) => m.free === true);
      const pool = freeOnes.length > 0 ? freeOnes : fetchedModels;
      modelInput.value = pool[Math.floor(Math.random() * pool.length)].id;
      modelHintEl.style.display = "none";
      modelHintEl.innerHTML = "";
      renderModelList();
    } catch (error) {
      if (isAuto) {
        const preset = QF_PROVIDER_PRESETS[presetSelect.value];
        if (preset?.modelsUrl) {
          modelHintEl.innerHTML = QP_L.modelHintKeyNeeded(preset.modelsUrl);
          modelHintEl.style.display = "";
        }
        return;
      }
      modelListInfo.textContent = QP_L.errModelListFailed(error.message || error);
      freeOnlyLabel.style.display = "none";
      modelPicker.innerHTML = "";
      modelPicker.style.display = "none";
      modelListDiv.style.display = "block";
    } finally {
      fetchModelsBtn.disabled = false;
      fetchModelsBtn.innerHTML = originalLabel;
    }
  }

  fetchModelsBtn.onclick = () => doFetchModels(false);

  panel.appendChild(qfMakeField(QP_L.fieldPreset, presetSelect));
  panel.appendChild(qfMakeField(QP_L.fieldBaseUrl, baseUrlInput));
  panel.appendChild(qfMakeField(QP_L.fieldApiKey, apiKeyInput));
  panel.appendChild(qfMakeField(QP_L.fieldModel, modelRow));
  panel.appendChild(modelHintEl);
  panel.appendChild(modelListDiv);
  panel.appendChild(qfMakeField(QP_L.fieldMode, modeSelect));

  // Action row: save + help
  const actionRow = document.createElement("div");
  actionRow.className = "qpyodide-feedback-actions";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn-default qpyodide-button";
  saveBtn.textContent = QP_L.saveBtn;

  const infoBtn = document.createElement("button");
  infoBtn.type = "button";
  infoBtn.className = "btn btn-light btn-sm qpyodide-button";
  infoBtn.textContent = QP_L.infoBtn;

  actionRow.appendChild(saveBtn);
  actionRow.appendChild(infoBtn);
  panel.appendChild(actionRow);

  const helpDiv = qfBuildHelpBox();
  panel.appendChild(helpDiv);

  // Behavior
  function setCollapsed(collapsed) {
    panel.style.display = collapsed ? "none" : "block";
  }

  // The panel can be relocated next to a cell's "not configured" error (see
  // qfOpenSettingsNear below); the header gear reclaims it back here rather
  // than blindly toggling whatever display state it was left in there.
  toggleBtn.onclick = () => {
    if (panel.parentElement !== qfUi.homeParent) {
      qfUi.homeParent.appendChild(panel);
      setCollapsed(false);
    } else {
      setCollapsed(panel.style.display !== "none");
    }
  };
  infoBtn.onclick = () => {
    helpDiv.style.display = (helpDiv.style.display === "none") ? "block" : "none";
  };

  saveBtn.onclick = () => {
    const newCfg = {
      baseUrl: baseUrlInput.value.trim(),
      apiKey: apiKeyInput.value.trim(),
      model: modelInput.value.trim(),
      mode: modeSelect.value,
      storage: "local"
    };
    qfSaveConfig(newCfg);
    statusSpan.textContent = QP_L.saveDone;
    setTimeout(() => { statusSpan.textContent = ""; }, 3000);
    // Auto-collapse after saving
    setCollapsed(true);
  };

  // Always start collapsed – the panel only opens via the gear icon.
  setCollapsed(true);

  qfUi.panel = panel;
  qfUi.setCollapsed = setCollapsed;

  // Line up the toggle button and status span to the right of the status row
  const rightArea = document.getElementById("qpyodide-status-right");
  if (rightArea) {
    rightArea.appendChild(toggleBtn);
    rightArea.appendChild(statusSpan);
  } else {
    // Fallback: before the first Pyodide cell
    const firstCell = document.querySelector('[id^="qpyodide-insertion-location-"]');
    const wrap = document.createElement("div");
    wrap.appendChild(toggleBtn);
    wrap.appendChild(statusSpan);
    firstCell
      ? firstCell.parentNode.insertBefore(wrap, firstCell)
      : document.body.prepend(wrap);
  }

  // Attach the settings panel below the status row. Its parent here is
  // also the panel's "home": qfOpenSettingsNear() can relocate the panel
  // next to a cell's error, and the header gear (above) moves it back here.
  const panelsArea = document.getElementById("qpyodide-status-panels");
  const statusArea = document.getElementById("qpyodide-status-message-area");
  qfUi.homeParent = panelsArea ?? statusArea ?? document.body;
  qfUi.homeParent.appendChild(panel);
}

// Moves the (single, shared) settings panel right next to `container` and
// opens it there - called from the "not configured yet" error box so the
// reader can fix it on the spot instead of hunting for the gear icon at
// the top of the page. The header gear (qfBuildSettingsUI above) moves the
// panel back to its home position when clicked.
function qfOpenSettingsNear(container) {
  if (!qfUi.panel || !container) return;
  container.appendChild(qfUi.panel);
  if (qfUi.setCollapsed) qfUi.setCollapsed(false);
}

// ---------------------------------------------------------------------------
// Click handler (wired up by the cell classes via attach())
// ---------------------------------------------------------------------------

// Click counter per editor unit for progressive hints
const qfClickCounts = new Map();

async function qfGiveFeedback(unit) {
  const button = unit.feedbackButton;
  const targetDiv = unit.feedbackDiv;
  if (!button || !targetDiv || button.dataset.qfBusy === "1") return;

  const cfg = qfLoadConfig();

  // Determine hint level (0 = feature disabled)
  let hintLevel = 0;
  if (qfOptions.hints) {
    hintLevel = Math.min((qfClickCounts.get(unit.uid) || 0) + 1, 3);
    qfClickCounts.set(unit.uid, hintLevel);
  }

  const originalLabel = button.innerHTML;
  button.dataset.qfBusy = "1";
  button.disabled = true;
  button.innerHTML = QP_L.feedbackBusy;

  try {
    // Run the code to give the model the interpreter output too
    const code = unit.getCode();
    const output = await unit.runForOutput();

    if (cfg.mode === "copy") {
      const fullPrompt = QF_SYSTEM_PROMPT + "\n\n" + qfBuildUserPrompt(code, output, hintLevel);
      qfRenderCopyPrompt(targetDiv, fullPrompt);
      return;
    }

    // Direct API: check configuration (key is optional, e.g. for Ollama)
    if (!cfg.baseUrl || !cfg.model) {
      // The error's own ⚙ button (qfOpenSettingsNear) moves the settings
      // panel right here on demand - nothing to pre-open before that.
      qfRenderError(targetDiv, QP_L.errConfigMissing, { showSettingsLink: true });
      return;
    }

    const messages = [
      { role: "system", content: QF_SYSTEM_PROMPT },
      { role: "user", content: qfBuildUserPrompt(code, output, hintLevel) }
    ];

    const feedback = await qfRequestFeedback(cfg, messages);
    qfRenderFeedback(targetDiv, feedback, hintLevel);

  } catch (error) {
    qfRenderError(targetDiv, error.message || String(error));
  } finally {
    button.dataset.qfBusy = "0";
    button.disabled = false;
    button.innerHTML = originalLabel;
  }
}

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

globalThis.qpyodideFeedback = {
  enabled: !!qfOptions.enabled,

  /** Wires up the feedback button of an editor unit. */
  attach(unit) {
    if (!this.enabled || !unit.feedbackButton) return;
    unit.feedbackButton.onclick = () => qfGiveFeedback(unit);
  },

  /** Opens and scrolls to the settings panel. */
  openSettings: qfOpenSettingsNear
};

// Build the settings panel (modules are deferred, so the DOM is ready)
if (qfOptions.enabled) {
  qfBuildSettingsUI();
}
