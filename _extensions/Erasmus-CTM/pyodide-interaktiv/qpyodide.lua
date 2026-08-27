----
--- qpyodide.lua – Pandoc Lua filter of the `pyodide-interaktiv` extension
---
--- Clean rework of coatless-quarto/pyodide with integrated,
--- provider-neutral AI feedback (OpenAI-compatible APIs).
---
--- The filter collects all `{pyodide-python}` code blocks, replaces them with
--- insertion markers, and injects the extension's JS/CSS files exactly once
--- per document. Everything runs entirely client-side (Pyodide/WebAssembly).
---
--- Injected files (order matters):
---   in-header : qpyodide-styling.css
---               qpyodide-document-settings.js   (template, placeholders get replaced)
---               qpyodide-locales.js             (UI text per language; defines QP_L)
---               qpyodide-document-status.js
---               qpyodide-feedback.js
---               qpyodide-document-engine-initialization.js
---               qpyodide-canvas-plots.js        (interactive plots, second instance)
---   before-body: qpyodide-monaco-editor-init.html
---   after-body : qpyodide-cell-classes.js
---                qpyodide-cell-initialization.js
---
--- A cell/document can also opt into `*-autoexec` (e.g. `pdf-autoexec`,
--- `html-autoexec`): instead of the interactive editor or a highlighted
--- source-only fallback, the cell is actually run via a local `python3`/
--- `python` interpreter at render time and replaced with its real output.
--- See collectAndRunAutoexecCells() / cellWantsAutoexecHere() below and the
--- README's "Real, executed output" section.
----

----
--- Setup variables for default initialization

-- Define a variable to check if pyodide is present.
local missingPyodideCell = true

-- Define a variable to only include the initialization once
local hasDonePyodideSetup = false

--- Setup default initialization values
-- Default values taken from:
-- https://pyodide.org/en/stable/usage/api/js-api.html#globalThis.loadPyodide

-- Define a base compatibile version
local baseVersionPyodide = "0.27.2"

-- Define where Pyodide can be found. Default:
-- https://cdn.jsdelivr.net/pyodide/v0.z.y/full/
-- https://cdn.jsdelivr.net/pyodide/v0.z.y/debug/
local baseUrl = "https://cdn.jsdelivr.net/pyodide/v".. baseVersionPyodide .."/"
local buildVariant = "full/"
local indexURL = baseUrl .. buildVariant

-- Define user directory
local homeDir = "/home/pyodide"

-- Define whether a startup status message should be displayed
local showStartUpMessage = "true"

-- Define an empty string if no packages need to be installed.
local installPythonPackagesList = "''"

----
--- Setup variables for localization (i18n)

-- Active UI language. Resolved per render pass from `pyodide: lang:` or Quarto's
-- own `lang:`; see resolveLang(). Default: English.
local lang = "en"

-- Supported locales. Extend this set together with qpyodide-locales.js.
local supportedLangs = {
  ["en"] = true,
  ["de"] = true,
  ["sv"] = true,
  ["no"] = true,
  ["nb"] = true,
  ["da"] = true
}

-- Noscript message per locale
local noscriptMessages = {
  en = "Please enable JavaScript to experience the dynamic code cell content on this page.",
  de = "Bitte JavaScript aktivieren, um die interaktiven Code-Zellen dieser Seite zu nutzen.",
  sv = "Aktivera JavaScript för att kunna använda de interaktiva kodcellerna på den här sidan.",
  no = "Slå på JavaScript for å kunne bruke de interaktive kodecellene på denne siden.",
  nb = "Slå på JavaScript for å kunne bruke de interaktive kodecellene på denne siden.",
  da = "Slå JavaScript til for at kunne bruge de interaktive kodeceller på denne side."
}

----
--- Setup variables for the AI feedback feature

-- Whether the feedback button should be rendered at all
local feedbackEnabled = "true"

-- Default persistence for the feedback configuration: "local" or "session"
local feedbackStorage = "local"

-- Whether progressive hints (hint level rises with each click) are active
local feedbackHints = "true"

----
--- Setup variables for non-interactive output formats (PDF, docx, ...)

-- Whether `{pyodide-python}` cells fall back to plain, Python-highlighted
-- source in formats where the Pyodide/WASM runtime never runs. Off by
-- default -- opt in via `pyodide: pdf-fallback: true` document-wide, or
-- `#| pdf-fallback: true` on an individual cell.
local pdfFallback = "false"

----
--- Setup variables for real, executed output in any format (`*-autoexec`)

-- Recognized `<format>-autoexec` targets, in priority order. A render only
-- ever targets a single output format, so at most one of these ever
-- matches during one render pass; the first match becomes the active key
-- (e.g. "pdf-autoexec"). Add another Quarto format name here to support
-- e.g. `revealjs-autoexec` or `pptx-autoexec`.
local autoexecFormats = { "html", "pdf", "docx" }

-- Document-wide defaults, one per `<format>-autoexec` key found under the
-- `pyodide:` YAML block (e.g. `pyodide: { pdf-autoexec: true, html-autoexec:
-- true }`). Off by default; a cell's own `#| <format>-autoexec: ...`
-- overrides its document-wide default, the same way `pdf-fallback` does.
local autoexecDocDefaults = {}

-- Output of running every opted-in cell for this render pass, filled in by
-- collectAndRunAutoexecCells() -- a Pandoc-level pass that runs before
-- enablePyodideCodeCell ever sees a cell. Stays nil if nothing opted in, or
-- if no Python interpreter could be found.
local autoexecResults = nil
local autoexecIndex = 0

----
--- Setup variables for tracking number of code cells

-- Define a counter variable
local qPyodideCounter = 0

-- Initialize a table to store the CodeBlock elements
local qPyodideCapturedCodeBlocks = {}

-- Cells reserved via reservePendingCell() but not yet numbered -- see there
-- for why numbering can't happen at reservation time.
local pendingPyodideCells = {}

-- Initialize a table that contains the default cell-level options
local qPyodideDefaultCellOptions = {
  -- Left unset (rather than "interactive"): enablePyodideCodeCell() needs
  -- to tell "author wrote an explicit `#| context:`" apart from "nothing
  -- set, derive one from echo/include" -- qpyodideCreateCell()'s own
  -- switch already falls back to InteractiveCell for anything else
  -- (including ""), so leaving it unset here changes nothing observable.
  ["context"] = "",
  ["warning"] = "true",
  ["message"] = "true",
  ["results"] = "markup",
  ["read-only"] = "false",
  ["output"] = "true",
  ["comment"] = "",
  ["eval"] = "",
  ["echo"] = "",
  ["include"] = "",
  ["code-fold"] = "",
  ["pdf-fallback"] = "",
  ["label"] = "",
  ["autorun"] = "",
  ["classes"] = "",
  ["dpi"] = 72,
  ["fig-cap"] = "",
  ["fig-width"] = 7,
  ["fig-height"] = 5,
  ["out-width"] = "700px",
  ["out-height"] = ""
}

----
--- Process initialization

-- Check if variable missing or an empty string
local function isVariableEmpty(s)
  return s == nil or s == ''
end

-- Check if variable is present
local function isVariablePopulated(s)
  return not isVariableEmpty(s)
end

-- Check if a raw string/boolean option value (document YAML or `#|` cell
-- comment) should be interpreted as "on".
local function isTruthy(value)
  if isVariableEmpty(value) then
    return false
  end
  local normalized = tostring(value):lower()
  return normalized == "true" or normalized == "1"
end

-- Copy the top level value and its direct children
-- Details: http://lua-users.org/wiki/CopyTable
local function shallowcopy(original)
  -- Determine if its a table
  if type(original) == 'table' then
    -- Copy the top level to remove references
    local copy = {}
    for key, value in pairs(original) do
        copy[key] = value
    end
    -- Return the copy
    return copy
  else
    -- If original is not a table, return it directly since it's already a copy
    return original
  end
end

-- Custom method for cloning a table with a shallow copy.
function table.clone(original)
  return shallowcopy(original)
end

local function mergeCellOptions(localOptions)
  -- Copy default options to the mergedOptions table
  local mergedOptions = table.clone(qPyodideDefaultCellOptions)

  -- Override default options with local options
  for key, value in pairs(localOptions) do
    if type(value) == "string" then
      value = value:gsub("[\"']", "")
    end
    mergedOptions[key] = value
  end

  -- Return the customized options
  return mergedOptions
end

-- Parse the different Pyodide options set in the YAML frontmatter, e.g.
--
-- ```yaml
-- ----
-- pyodide:
--   base-url: https://cdn.jsdelivr.net/pyodide/[version]
--   build-variant: full
--   packages: ['matplotlib', 'pandas']
--   feedback: true
--   feedback-storage: local
--   feedback-hints: true
-- ----
-- ```
--
-- Determine the UI language for this render pass.
--
-- Order of precedence:
--   1. `pyodide: lang: xx`  – explicit override
--   2. Quarto's own `lang:` – set per profile in a multilingual project
--   3. "en"                 – fallback
--
-- Region subtags are dropped ("de-DE" -> "de"); unsupported languages fall back
-- to English instead of failing the render.
local function resolveLang(meta)
  local raw = nil

  local pyodide = meta.pyodide
  if isVariablePopulated(pyodide) and isVariablePopulated(pyodide["lang"]) then
    raw = pandoc.utils.stringify(pyodide["lang"])
  elseif isVariablePopulated(meta["lang"]) then
    raw = pandoc.utils.stringify(meta["lang"])
  end

  if raw == nil or raw == "" then
    return "en"
  end

  local base = raw:lower():match("^(%a+)")
  if base and supportedLangs[base] then
    return base
  end

  return "en"
end

local function setPyodideInitializationOptions(meta)

  -- Resolve the language first: it must also work for documents that have no
  -- `pyodide:` block at all, so this happens before the early return below.
  lang = resolveLang(meta)

  -- Retrieve the pyodide options from meta
  local pyodide = meta.pyodide

  -- Does this exist? If not, just return meta as we'll just use the defaults.
  if isVariableEmpty(pyodide) then
    return meta
  end

  -- The base URL used for downloading Python WebAssembly binaries
  if isVariablePopulated(pyodide["base-url"]) then
    baseUrl = pandoc.utils.stringify(pyodide["base-url"])
  end

  -- The build variant for Python WebAssembly binaries. Default: 'full'
  if isVariablePopulated(pyodide["build-variant"]) then
    buildVariant = pandoc.utils.stringify(pyodide["build-variant"])
  end

  if isVariablePopulated(pyodide["build-variant"]) or isVariablePopulated(pyodide["base-url"]) then
    indexURL = baseUrl .. buildVariant
  end

  -- The WebAssembly user's home directory and initial working directory. Default: '/home/pyodide'
  if isVariablePopulated(pyodide['home-dir']) then
    homeDir = pandoc.utils.stringify(pyodide["home-dir"])
  end

  -- Display a startup message indicating the pyodide state at the top of the document.
  if isVariablePopulated(pyodide['show-startup-message']) then
    showStartUpMessage = pandoc.utils.stringify(pyodide["show-startup-message"])
  end

  -- Enable/disable the AI feedback button. Default: true
  if isVariablePopulated(pyodide['feedback']) then
    feedbackEnabled = pandoc.utils.stringify(pyodide["feedback"])
  end

  -- Default persistence for feedback credentials: "local" or "session"
  if isVariablePopulated(pyodide['feedback-storage']) then
    feedbackStorage = pandoc.utils.stringify(pyodide["feedback-storage"])
  end

  -- Enable/disable progressive hints. Default: true
  if isVariablePopulated(pyodide['feedback-hints']) then
    feedbackHints = pandoc.utils.stringify(pyodide["feedback-hints"])
  end

  -- Document-wide default for the PDF/non-interactive fallback. Default:
  -- false (unchanged legacy behavior). Overridable per cell via
  -- `#| pdf-fallback: ...`.
  if isVariablePopulated(pyodide['pdf-fallback']) then
    pdfFallback = pandoc.utils.stringify(pyodide["pdf-fallback"])
  end

  -- Document-wide defaults for real, executed output. Every `<name>-
  -- autoexec` key under `pyodide:` is captured here, whether or not "name"
  -- is a format this particular render matches -- only the one matching
  -- the currently active render (see autoexecFormats) is ever read back.
  for key, value in pairs(pyodide) do
    if type(key) == "string" and key:match("%-autoexec$") then
      autoexecDocDefaults[key] = pandoc.utils.stringify(value)
    end
  end

  -- Attempt to install different packages.
  if isVariablePopulated(pyodide["packages"]) then
    -- Create a custom list
    local package_list = {}

    -- Iterate through each list item and enclose it in quotes
    for _, package_name in pairs(pyodide["packages"]) do
      table.insert(package_list, "'" .. pandoc.utils.stringify(package_name) .. "'")
    end

    installPythonPackagesList = table.concat(package_list, ", ")
  end

  return meta
end


-- Read a file that lives next to this .lua filter (resolved via Quarto's path API).
local function readTemplateFile(template)
  local path = quarto.utils.resolve_path(template)
  local file = io.open(path, "r")
  if not file then
    error("\nWe were unable to read the template file `" .. template .. "` from the extension directory.\n\n" ..
          "Double check that the extension is fully available by comparing the \n" ..
          "`_extensions/Erasmus-CTM/pyodide-interaktiv` directory with the main repository:\n" ..
          "https://github.com/Erasmus-CTM/Pyodide-interaktiv/tree/main/_extensions/pyodide-interaktiv\n\n" ..
          "You may need to modify `.gitignore` to allow the extension files using:\n" ..
          "!_extensions/*/*/*\n")
    return nil
  end
  local content = file:read "*a"
  file:close()
  return content
end

-- Replace {{ KEYWORD }} placeholders in a template string.
local function substitute_in_file(contents, substitutions)
  contents = contents:gsub("{{%s*(.-)%s*}}", substitutions)
  return contents
end

local function initializationPyodide()

  -- Write cell code as JSON into an inline <script>: if the code contains
  -- the string "</script>", the HTML parser ends the script tag mid-way and
  -- the rest of the page shows up as text. "</" is therefore escaped to
  -- "<\/" (identical in JSON and JavaScript, but harmless in HTML).
  local cellDetails = quarto.json.encode(qPyodideCapturedCodeBlocks)
  cellDetails = cellDetails:gsub("</", "<\\/")

  -- Setup different Pyodide specific initialization variables
  local substitutions = {
    ["INDEXURL"] = indexURL,
    ["HOMEDIR"] = homeDir,
    ["SHOWSTARTUPMESSAGE"] = showStartUpMessage,
    ["INSTALLPYTHONPACKAGESLIST"] = installPythonPackagesList,
    ["QPYODIDECELLDETAILS"] = cellDetails,
    ["FEEDBACKENABLED"] = feedbackEnabled,
    ["FEEDBACKSTORAGE"] = feedbackStorage,
    ["FEEDBACKHINTS"] = feedbackHints,
    ["LANG"] = lang
  }

  -- Make sure we perform a copy
  local initializationTemplate = readTemplateFile("qpyodide-document-settings.js")

  -- Make the necessary substitutions
  local initializedPyodideConfiguration = substitute_in_file(initializationTemplate, substitutions)

  return initializedPyodideConfiguration
end

local function generateHTMLElement(tag)
  -- Store a map containing opening and closing tabs
  local tagMappings = {
      module = { opening = "<script type=\"module\">\n", closing = "\n</script>" },
      js = { opening = "<script type=\"text/javascript\">\n", closing = "\n</script>" },
      css = { opening = "<style type=\"text/css\">\n", closing = "\n</style>" }
  }

  -- Find the tag
  local tagMapping = tagMappings[tag]

  -- If present, extract tag and return
  if tagMapping then
      return tagMapping.opening, tagMapping.closing
  else
      quarto.log.error("Invalid tag specified")
  end
end

-- Custom functions to include values into Quarto
-- https://quarto.org/docs/extensions/lua-api.html#includes

local function includeTextInHTMLTag(location, text, tag)

  -- Obtain the HTML element opening and closing tag
  local openingTag, closingTag = generateHTMLElement(tag)

  -- Insert the file into the document using the correct opening and closing tags
  quarto.doc.include_text(location, openingTag .. text .. closingTag)

end

local function includeFileInHTMLTag(location, file, tag)

  -- Obtain the HTML element opening and closing tag
  local openingTag, closingTag = generateHTMLElement(tag)

  -- Retrieve the file contents
  local fileContents = readTemplateFile(file)

  -- Insert the file into the document using the correct opening and closing tags
  quarto.doc.include_text(location, openingTag .. fileContents .. closingTag)

end


-- Setup Pyodide's pre-requisites once per document.
local function ensurePyodideSetup()

  -- If we've included the initialization, then bail.
  if hasDonePyodideSetup then
    return
  end

  -- Otherwise, let's include the initialization script _once_
  hasDonePyodideSetup = true

  -- COI service worker: copy the file into the site root and register it in
  -- the browser. Enables SharedArrayBuffer (and thus real input()) on HTTPS
  -- hosts like GitHub Pages, without server-side COOP/COEP header config.
  --
  -- Important: io.open() with a relative path writes relative to the
  -- directory of the document CURRENTLY being rendered, not to the project
  -- root. In website projects with subfolders (e.g. Chapter_1/, Chapter_2/,
  -- ...), the file would otherwise end up scattered across the source tree
  -- (e.g. Qmd-Files/Chapter_1/coi-serviceworker.js) instead of in the actual
  -- output directory. quarto.project.output_directory points to the active
  -- profile's actual output directory (e.g. docs/de); writing there fixes
  -- this. For standalone documents without a project (quarto.project is
  -- then nil), the previous document-relative path remains as a fallback.
  --
  -- The `<script src="...">` reference must be relative, not root-absolute
  -- (`/coi-serviceworker.js`): a root-absolute path resolves against the
  -- filesystem root for a standalone document opened directly as a local
  -- `file://`, which 404s every time. But a *plain* relative path (just
  -- "coi-serviceworker.js") breaks the opposite way in a project with
  -- chapters in subfolders: the file is written once, at the project output
  -- root, while a nested chapter's own page resolves that same relative
  -- reference against ITS OWN directory instead. Quarto's own
  -- `quarto.project.offset` is exactly the relative path back from the
  -- current page to the project root (measured: "." at the root, ".." one
  -- level down, etc. -- always populated, even for a standalone document
  -- with no project at all, where it is also "."). Prepending it makes the
  -- reference correct at every nesting depth AND for a standalone document.
  --
  -- Measured exception that no path can fix: under `embed-resources: true`
  -- Quarto inlines this script's whole content into the page, so the tag
  -- has no `src` left at all. coi-serviceworker.js registers itself via
  -- `document.currentScript.src`, which is "" for an inline script -- the
  -- registration then resolves against the page itself and is rejected
  -- (MIME `text/html`). Whatever this filter writes here is irrelevant in
  -- that combination, and a service worker cannot be inlined or loaded
  -- from a `data:` URI either way: browsers require a real, separate
  -- same-origin script URL. So COI silently does not come up there; the
  -- extension degrades gracefully without it (Stop still works, as a hard
  -- worker restart -- see Known limitations).
  local coiContent = readTemplateFile("coi-serviceworker.js")
  if coiContent then
    local coiPath = "coi-serviceworker.js"
    if quarto.project and quarto.project.output_directory then
      coiPath = quarto.project.output_directory .. "/coi-serviceworker.js"
    end
    local coiOut = io.open(coiPath, "w")
    if coiOut then
      coiOut:write(coiContent)
      coiOut:close()
    end
  end
  local coiOffset = "."
  if quarto.project and isVariablePopulated(quarto.project.offset) then
    coiOffset = quarto.project.offset
  end
  quarto.doc.include_text("in-header", '<script src="' .. coiOffset .. '/coi-serviceworker.js"></script>')

  local initializedConfigurationPyodide = initializationPyodide()

  -- Insert different partial files to create a monolithic document.
  -- https://quarto.org/docs/extensions/lua-api.html#includes

  -- Embed Support Files to Avoid Resource Registration Issues
  -- Note: We're not able to use embed-resources due to the web assembly binary
  -- and the potential for additional service worker files.
  --
  -- Font Awesome via its JS (SVG) kit, not the CSS/webfont one: the CSS kit
  -- needs its `@font-face` files, which `embed-resources: true` does not
  -- reliably inline -- every fa-* icon (gear, spinner, copy, ...) silently
  -- goes blank in a self-contained export. The JS kit replaces each
  -- `<i class="fa-...">` with an inline `<svg>` instead, so nothing depends
  -- on a separate font file surviving the bundling; markup elsewhere in
  -- this extension is unchanged either way.
  quarto.doc.include_text("in-header", [[
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/monaco-editor@0.46.0/min/vs/editor/editor.main.css" />
  <script src="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/js/all.min.js" defer crossorigin="anonymous"></script>
  ]])

  -- Insert CSS styling and external style sheets
  includeFileInHTMLTag("in-header", "qpyodide-styling.css", "css")

  -- Insert the Pyodide initialization routine
  includeTextInHTMLTag("in-header", initializedConfigurationPyodide, "module")

  -- Insert the UI translations. Must come directly after the settings module
  -- (which defines globalThis.qpyodideLang) and before every module that reads
  -- globalThis.QP_L at load time.
  includeFileInHTMLTag("in-header", "qpyodide-locales.js", "module")

  -- Insert JS routine to add document status header
  includeFileInHTMLTag("in-header", "qpyodide-document-status.js", "module")

  -- Insert the AI feedback module (settings UI + API client); it deactivates
  -- itself when `pyodide: feedback: false` is set in the document metadata.
  includeFileInHTMLTag("in-header", "qpyodide-feedback.js", "module")

  -- Insert JS routine to bring Pyodide online
  includeFileInHTMLTag("in-header", "qpyodide-document-engine-initialization.js", "module")

  -- Insert the interactive-plot module (second Pyodide instance on the main
  -- thread, loaded on demand when the first plot appears)
  includeFileInHTMLTag("in-header", "qpyodide-canvas-plots.js", "module")

  -- Insert the Monaco Editor initialization
  quarto.doc.include_file("before-body", "qpyodide-monaco-editor-init.html")

  -- Insert the cell data at the end of the document
  includeFileInHTMLTag("after-body", "qpyodide-cell-classes.js", "module")

  includeFileInHTMLTag("after-body", "qpyodide-cell-initialization.js", "module")

end

local function qPyodideJSCellInsertionCode(counter)
  local insertionLocation = '<div id="qpyodide-insertion-location-' .. counter ..'"></div>\n'
  local noscriptWarning = '<noscript>' .. (noscriptMessages[lang] or noscriptMessages.en) .. '</noscript>'
  return insertionLocation .. noscriptWarning
end

-- Bridge to Quarto's own resolved document/project/profile-level options
-- (`code-fold:` today; the same primitive works for any other key Quarto
-- resolves the same way, e.g. `echo`, `eval`, `warning`, `code-summary`).
--
-- Quarto resolves these (project + profile + document, with format-level
-- defaulting) into a `param()` lookup that its own *core* filters (bundled
-- in main.lua) call as a bare global -- but that global is only injected
-- into main.lua's Lua state, not into the separate sandbox extension
-- filters run in (confirmed empirically: `param` is undefined here, while
-- `_G.param` still resolves to the same function via the shared top-level
-- `_G` table). There is no documented public replacement for this in the
-- extension Lua API as of Quarto 1.8 (`quarto.metadata.get` exists but
-- does not return format params such as `code-fold`). Reached defensively
-- so a future Quarto release that removes this can only make resolved
-- values fall back to "not set", never error out.
local function readDocumentQuartoParam(name)
  local paramFn = rawget(_G, "param")
  if type(paramFn) ~= "function" then
    return nil
  end
  local ok, value = pcall(paramFn, name)
  if not ok then
    return nil
  end
  return value
end

local function stringifyQuartoParam(value)
  if value == nil then
    return nil
  elseif type(value) == "boolean" or type(value) == "number" then
    return tostring(value)
  elseif type(value) == "string" then
    return value
  end
  local ok, result = pcall(pandoc.utils.stringify, value)
  if ok then
    return result
  end
  return nil
end

-- Resolve one Quarto-native option for a cell: the cell's own `#| <name>:`
-- override takes precedence over Quarto's document/project/profile-level
-- default for the same key; `fallback` applies when neither is set.
-- Returns the resolved value lowercased (raw strings/booleans/numbers
-- only -- callers interpret the result themselves, same as Quarto's own
-- `foldAttribute()`/`attribute()` helpers do for their respective option).
local function resolveQuartoParam(name, cellOverride, fallback)
  local raw

  if isVariablePopulated(cellOverride) then
    raw = cellOverride
  else
    raw = stringifyQuartoParam(readDocumentQuartoParam(name))
  end

  if raw == nil or raw == "" then
    return fallback
  end

  return raw:lower()
end

-- Resolve the initial fold state ("hide" = start collapsed, "show" = start
-- expanded) for one pyodide cell, mirroring Quarto's own `foldAttribute()`
-- (see share/filters/main.lua -> foldcode.lua) so that this extension picks
-- up the exact same `code-fold` setting Quarto's native code-fold uses.
--
-- Precedence:
--   1. `#| code-fold: ...` set directly on the cell
--   2. Quarto's own `code-fold:` -- document YAML, a profile, or the
--      project's `_quarto.yml`.
--   3. Neither set -> "show" (previous, unconditional default is preserved)
local function resolveFoldState(cellOverride)
  local resolved = resolveQuartoParam("code-fold", cellOverride, "show")

  if resolved == "true" or resolved == "1" or resolved == "hide" then
    return "hide"
  else
    -- Covers "false", "0", "show", "none", and anything unrecognized.
    return "show"
  end
end

-- Resolve whether a `{pyodide-python}` cell is allowed to ever actually
-- execute -- real subprocess execution via `*-autoexec`, or being handed to
-- the interactive Pyodide editor at all -- mirroring a real `{python}`
-- cell's `eval` option (and resolved the same cascading way
-- resolveFoldState() resolves `code-fold`).
--
-- Precedence:
--   1. `#| eval: ...` set directly on the cell
--   2. Quarto's own `eval:` -- document YAML, a profile, or the project's
--      `_quarto.yml`
--   3. Neither set -> true (Quarto's own default: cells execute)
local function resolveEvalEnabled(cellOverride)
  return isTruthy(resolveQuartoParam("eval", cellOverride, "true"))
end

-- `echo`/`include`, resolved the same cascading way as `eval` above (both
-- default to true, matching Quarto's own defaults).
local function resolveEchoEnabled(cellOverride)
  return isTruthy(resolveQuartoParam("echo", cellOverride, "true"))
end

local function resolveIncludeEnabled(cellOverride)
  return isTruthy(resolveQuartoParam("include", cellOverride, "true"))
end

-- Whether a CodeBlock is one of this extension's `{pyodide-python}` cells.
local function isPyodideCell(el)
  return el.attr and el.attr.classes:includes("{pyodide-python}")
end

-- Extract Quarto code cell options from the block's text
local function extractCodeBlockOptions(block)

  -- Access the text aspect of the code block
  local code = block.text

  -- Define two local tables:
  --  the block's attributes
  --  the block's code lines
  local cellOptions = {}
  local newCodeLines = {}

  -- Iterate over each line in the code block
  for line in code:gmatch("([^\r\n]*)[\r\n]?") do
    -- Check if the line starts with "#|" and extract the key-value pairing
    -- e.g. #| key: value goes to cellOptions[key] -> value
    local key, value = line:match("^#|%s*(.-):%s*(.-)%s*$")

    -- If a special comment is found, then add the key-value pairing to the cellOptions table
    if key and value then
      cellOptions[key] = value
    else
      -- Otherwise, it's not a special comment, keep the code line
      table.insert(newCodeLines, line)
    end
  end

  -- Merge cell options with default options
  cellOptions = mergeCellOptions(cellOptions)

  -- Set the codeblock text to exclude the special comments.
  cellCode = table.concat(newCodeLines, '\n')

  -- Return the code alongside options
  return cellCode, cellOptions
end

-- Interpret a `pdf-fallback` value (document- or cell-level, always a raw
-- string coming out of YAML/`#|` parsing) as on/off.
local function isPdfFallbackEnabled(value)
  if isVariableEmpty(value) then
    return false
  end
  local normalized = tostring(value):lower()
  return normalized == "true" or normalized == "python" or normalized == "1"
end

-- Which `<format>-autoexec` key applies to the format currently being
-- rendered, or nil if none of autoexecFormats matches (autoexec then simply
-- doesn't apply for this render -- existing pdf-fallback/interactive
-- handling is unaffected).
local function resolveAutoexecOptionKeyForCurrentFormat()
  for _, format in ipairs(autoexecFormats) do
    if quarto.doc.is_format(format) then
      return format .. "-autoexec"
    end
  end
  return nil
end

-- Whether one cell wants real, executed output for the format currently
-- being rendered: the cell's own `#| <format>-autoexec: ...` overrides the
-- document-wide default for that same key.
local function cellWantsAutoexecHere(cellOptions)
  local key = resolveAutoexecOptionKeyForCurrentFormat()
  if key == nil then
    return false
  end

  local override = cellOptions[key]
  if isVariablePopulated(override) then
    return isTruthy(override)
  end

  return isTruthy(autoexecDocDefaults[key])
end

----
--- Temp-file helpers for autoexec. Deliberately not os.tmpname(): on
--- Windows it can hand back a root-directory path that io.open() then
--- fails to create.

local autoexecTmpCounter = 0
math.randomseed(os.time())

local function autoexecTmpDir()
  return os.getenv("TMPDIR") or os.getenv("TEMP") or os.getenv("TMP") or "/tmp"
end

local function makeAutoexecTmpPath(suffix)
  autoexecTmpCounter = autoexecTmpCounter + 1
  local sep = package.config:sub(1, 1)
  return autoexecTmpDir() .. sep .. "qpyautoexec_" .. tostring(os.time()) .. "_" ..
      tostring(math.random(100000, 999999)) .. "_" .. autoexecTmpCounter .. suffix
end

-- Where a captured matplotlib figure ends up, for the format currently
-- being rendered.
--
-- LaTeX-based output (`pdf`) needs a real file on disk: Quarto hands the
-- generated `.tex` to a separate LaTeX run, so `\includegraphics` has to
-- name a path that still exists and still resolves at that point. The
-- files are therefore written into this directory, relative to the
-- render's working directory -- the same directory the `.tex` itself is
-- written to and compiled in, so the path that lands in the document is
-- relative and portable, exactly like Quarto's own `<doc>_files/figure-pdf`
-- output. (An absolute path into the system temp directory would "work"
-- only on the machine that rendered it, leaks the local username into the
-- document, and breaks the moment the temp directory is cleaned.)
--
-- Everything else (`html`, `docx`) is written by pandoc itself, which
-- resolves a `data:` URI through its media bag -- so the PNG is embedded
-- straight into the document and no files are left behind in the source
-- tree at all. That also sidesteps HTML resource copying entirely: a
-- relative path would otherwise have to survive Quarto's per-page URL
-- rewriting (chapter pages live one directory down from the render root).
local autoexecFigureDirName = "qpyodide-figures"

local function autoexecFigureDir()
  if quarto.doc.is_format("pdf") then
    return autoexecFigureDirName
  end
  return ""
end

-- A trailing bare expression's value is printed too (if not None), mirroring
-- how the interactive Pyodide runtime auto-displays a cell's last
-- expression. Everything else only ever prints what the code itself prints.
--
-- `__QPY_FIG_DIR__` is substituted by autoexecDriverPrelude() below.
local autoexecDriverPreludeTemplate = [==[
import ast, sys, traceback

# Whatever this prints is read back by the Lua side as UTF-8 (pandoc's own
# encoding). Python only defaults to UTF-8 for a pipe on some platforms --
# on Windows it defaults to the ANSI code page, where a single non-encodable
# character in a cell's output raises UnicodeEncodeError and takes down the
# whole driver, losing every remaining cell's output. Pin it.
try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass

_ns = {}

# Directory for captured figures, relative to this process's working
# directory (inherited from pandoc). Empty means "embed the PNG as a
# data: URI instead of writing a file" -- see autoexecFigureDir().
_qpy_fig_dir = "__QPY_FIG_DIR__"
_qpy_cell_index = 0
_qpy_fig_index = 0

# Real Python has no display protocol of its own, so plt.show() by default
# tries to pop up an interactive window using whatever GUI backend happens
# to be installed -- disruptive during an unattended render, and the figure
# would never end up in the rendered document anyway. Mirror what the
# browser-side Pyodide worker does (see PY_SETUP in
# qpyodide-document-engine-initialization.js): force the non-interactive
# Agg backend, and make plt.show() / fig.show() the trigger that releases a
# figure as a PNG. Each released figure is announced on a marker line; the
# Lua side (see splitAutoexecOutput()) pulls those back out of the captured
# stdout and turns them into real images, in the order they were printed.
# Wrapped in try/except so cells that never touch matplotlib still work on
# an interpreter that does not have matplotlib installed.
try:
    import matplotlib
    matplotlib.use("Agg")
    from matplotlib import pyplot as _qpy_plt
    import matplotlib.figure as _qpy_figmod

    def _qpy_release_figure(fig):
        global _qpy_fig_index
        import base64, io, os
        _qpy_fig_index = _qpy_fig_index + 1
        buf = io.BytesIO()
        fig.savefig(buf, format="png", bbox_inches="tight")
        # Closing mirrors a local script: the shown window is gone, and a
        # following plt.plot() starts a new figure instead of drawing into
        # the old one.
        _qpy_plt.close(fig)
        data = buf.getvalue()
        if _qpy_fig_dir:
            os.makedirs(_qpy_fig_dir, exist_ok=True)
            # Deterministic name: re-rendering overwrites the previous
            # run's figure instead of piling up a new file every time.
            name = "cell-%d-figure-%d.png" % (_qpy_cell_index, _qpy_fig_index)
            path = os.path.join(_qpy_fig_dir, name)
            with open(path, "wb") as fh:
                fh.write(data)
            ref = path.replace(os.sep, "/")
        else:
            ref = "data:image/png;base64," + base64.b64encode(data).decode("ascii")
        print("<<<QPYAUTOEXEC_FIG:%s>>>" % ref)

    def _qpy_show(*args, **kwargs):
        # get_fignums() returns a copy, so closing inside the loop is fine.
        for num in _qpy_plt.get_fignums():
            _qpy_release_figure(_qpy_plt.figure(num))

    def _qpy_figure_show(self, *args, **kwargs):
        _qpy_release_figure(self)

    _qpy_plt.show = _qpy_show
    _qpy_figmod.Figure.show = _qpy_figure_show
except Exception:
    _qpy_plt = None

def _run(i, path, label):
    global _qpy_cell_index, _qpy_fig_index
    _qpy_cell_index = i
    _qpy_fig_index = 0
    try:
        with open(path, "r", encoding="utf-8") as f:
            src = f.read()
        # Compiled under a short synthetic filename (not the real temp
        # path): keeps tracebacks short enough to fit the page and avoids
        # leaking local temp-directory/username paths into the document.
        tree = ast.parse(src, filename=label, mode="exec")
        last_expr = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            last_expr = tree.body.pop()
        exec(compile(tree, label, "exec"), _ns)
        if last_expr is not None:
            value = eval(compile(ast.Expression(last_expr.value), label, "eval"), _ns)
            if value is not None:
                print(str(value))
    except BaseException:
        # BaseException, not Exception: a bare sys.exit() in one cell raises
        # SystemExit, which would otherwise tear down the whole driver --
        # every following cell then silently renders with no output at all,
        # and (on a non-zero exit code) the Lua side sees the pipe fail and
        # degrades the entire document. Report it as that one cell's error
        # and carry on, the way IPython treats SystemExit in a notebook.
        # Printed to stdout on purpose: only stdout is captured by the Lua
        # side (pandoc.pipe), so an error must land there to end up in the
        # cell's own output slot instead of vanishing into the render log.
        # Frames are filtered down to the cell's own code (filename ==
        # label): without this, every traceback would also show this
        # driver's own exec/eval call sites and their real temp-file paths
        # (leaking the local username/temp dir into the rendered document),
        # the same way Jupyter/IPython hide their own execution machinery
        # from a cell's traceback.
        exc_type, exc_value, exc_tb = sys.exc_info()
        frames = [f for f in traceback.extract_tb(exc_tb) if f.filename == label]
        print("Traceback (most recent call last):")
        sys.stdout.writelines(traceback.format_list(frames))
        sys.stdout.writelines(traceback.format_exception_only(exc_type, exc_value))
    # Discard figures the cell never showed, exactly like the browser-side
    # runtime does after every cell run: one cell corresponds to one script
    # run, so leftover open figures must not spill into the next cell's
    # plt.show() (which would output them all at once, attached to the
    # wrong cell).
    if _qpy_plt is not None:
        try:
            _qpy_plt.close("all")
        except Exception:
            pass
    sys.stdout.flush()
    print("<<<QPYAUTOEXEC_END_%d>>>" % i)

]==]

-- The driver prelude with this render's figure directory baked in.
local function autoexecDriverPrelude()
  local dir = autoexecFigureDir():gsub("\\", "/")
  return (autoexecDriverPreludeTemplate:gsub("__QPY_FIG_DIR__", dir))
end

-- Extract the top-level module names referenced via `import X` / `from X
-- import Y` across every opted-in cell's source (e.g. `scipy.linalg` ->
-- `scipy`; a submodule import says nothing extra about whether the
-- top-level package is installed). Used to test candidate interpreters
-- below for whether they actually have what the cells need, not just
-- whether they exist.
local function extractImportedModules(cellSources)
  local seen = {}
  local modules = {}

  local function addModule(name)
    local top = name:match("^([%w_]+)")
    if top and not seen[top] then
      seen[top] = true
      table.insert(modules, top)
    end
  end

  for _, src in ipairs(cellSources) do
    for line in src:gmatch("([^\r\n]+)") do
      local fromModule = line:match("^%s*from%s+([%w_%.]+)%s+import")
      if fromModule then
        addModule(fromModule)
      else
        local importList = line:match("^%s*import%s+(.+)$")
        if importList then
          importList = importList:gsub("#.*$", "")
          for entry in importList:gmatch("[^,]+") do
            local name = entry:match("^%s*([%w_%.]+)")
            if name then
              addModule(name)
            end
          end
        end
      end
    end
  end

  return modules
end

-- Whether interpreter `cmd` exists on PATH AND can import every module in
-- `modules` (an empty list only proves existence). Never throws.
local function candidateSatisfiesImports(cmd, modules)
  if #modules == 0 then
    local ok = pcall(pandoc.pipe, cmd, { "--version" }, "")
    return ok
  end
  local checkScript = "import " .. table.concat(modules, ", ")
  local ok = pcall(pandoc.pipe, cmd, { "-c", checkScript }, "")
  return ok
end

-- Split one cell's raw captured stdout into an ordered list of segments:
--   { kind = "text",  value = <printed text> }
--   { kind = "image", value = <path or data: URI> }
-- The "<<<QPYAUTOEXEC_FIG:...>>>" marker lines are written by
-- _qpy_release_figure() in the driver prelude, at the moment the figure is
-- shown. Keeping the split ordered (rather than "all text, then all
-- images") preserves the real interleaving of a cell that prints, plots,
-- and then prints again -- the same order a reader sees in the browser.
local function splitAutoexecOutput(text)
  local segments = {}
  local pendingLines = {}

  local function flushText()
    -- Trailing blank lines around a figure are an artifact of the marker
    -- line sitting on its own line, not something the cell printed.
    local block = table.concat(pendingLines, "\n"):gsub("^%s+", ""):gsub("%s+$", "")
    pendingLines = {}
    if block ~= "" then
      table.insert(segments, { kind = "text", value = block })
    end
  end

  for line in (text .. "\n"):gmatch("(.-)\n") do
    local ref = line:match("^<<<QPYAUTOEXEC_FIG:(.-)>>>$")
    if ref then
      flushText()
      table.insert(segments, { kind = "image", value = ref })
    else
      table.insert(pendingLines, line)
    end
  end
  flushText()

  return segments
end

-- Strip one layer of surrounding quotes from a raw `#|` option value
-- (`#| fig-cap: "..."` keeps its quotes through extractCodeBlockOptions).
local function stripOptionQuotes(value)
  local text = tostring(value)
  return text:match('^"(.*)"$') or text:match("^'(.*)'$") or text
end

-- Parse a caption written as Markdown (`#| fig-cap:` routinely contains
-- inline math and emphasis) into inlines. Falls back to plain text if it
-- somehow does not parse.
local function captionInlines(text)
  local ok, parsed = pcall(pandoc.read, text, "markdown")
  if ok and parsed.blocks and #parsed.blocks > 0 and parsed.blocks[1].content then
    return parsed.blocks[1].content
  end
  return { pandoc.Str(text) }
end

-- One captured figure as a block. A caption turns it into a real Figure,
-- so the document shows it captioned and numbered like any other figure
-- instead of as a bare, floating image.
--
-- The identifier from `#| label:` is set as well, but it does NOT make
-- `@fig-...` resolve: Quarto builds its cross-reference index while
-- normalizing the freshly parsed document, which happens before any
-- extension filter runs, so a figure this filter creates is never in that
-- index and the reference stays `?@fig-...`. Setting it anyway costs
-- nothing and keeps the anchor in the output.
local function autoexecImageBlock(ref, identifier, capText)
  local image = pandoc.Image({}, ref)
  if capText == nil or capText == "" then
    if identifier == nil or identifier == "" then
      return pandoc.Para({ image })
    end
    return pandoc.Para({ pandoc.Image({}, ref, "", pandoc.Attr(identifier, {}, {})) })
  end
  return pandoc.Figure(
    { pandoc.Plain({ image }) },
    { long = { pandoc.Plain(captionInlines(capText)) } },
    pandoc.Attr(identifier or "", {}, {})
  )
end

-- Run every opted-in cell's cleaned source in ONE Python subprocess, in
-- document order, sharing one namespace -- mirroring how the interactive
-- Pyodide runtime in the browser keeps state across cells. Returns a list
-- of per-cell segment lists (see splitAutoexecOutput()), or nil if no
-- interpreter could be found.
local function runAutoexecCellsForReal(cellSources)
  if #cellSources == 0 then
    return {}
  end

  local tmpFiles = {}
  local driverLines = { autoexecDriverPrelude() }
  for i, src in ipairs(cellSources) do
    local path = makeAutoexecTmpPath(".py")
    local f = io.open(path, "w")
    if not f then
      io.stderr:write("qpyodide.lua: could not write temp file '" .. path .. "' for autoexec.\n")
      return nil
    end
    table.insert(tmpFiles, path)
    f:write(src)
    f:close()
    local escapedPath = path:gsub("\\", "\\\\")
    table.insert(driverLines, string.format('_run(%d, "%s", "<cell %d>")', i, escapedPath, i))
  end

  local driverPath = makeAutoexecTmpPath("_driver.py")
  local df = io.open(driverPath, "w")
  if not df then
    io.stderr:write("qpyodide.lua: could not write temp driver file '" .. driverPath .. "' for autoexec.\n")
    return nil
  end
  table.insert(tmpFiles, driverPath)
  df:write(table.concat(driverLines, "\n"))
  df:close()

  -- Multiple Python installs on the same machine are common (venvs, conda
  -- envs, Windows Store stubs, ...), and merely existing on PATH says
  -- nothing about which one actually has the packages the cells import
  -- (e.g. a venv with numpy installed shadows only "python.exe" on
  -- Windows, not "python3.exe", so an existence-only check can silently
  -- pick a different, unrelated interpreter). Prefer whichever candidate
  -- can resolve every import the opted-in cells need; only fall back to
  -- "first one that merely exists" if none of them fully qualify, so cells
  -- still run and surface a real traceback naming the actual missing
  -- module instead of doing nothing.
  local candidates = { "python3", "python" }
  local requiredModules = extractImportedModules(cellSources)

  local chosenCmd = nil
  for _, cmd in ipairs(candidates) do
    if candidateSatisfiesImports(cmd, requiredModules) then
      chosenCmd = cmd
      break
    end
  end
  if chosenCmd == nil then
    for _, cmd in ipairs(candidates) do
      if candidateSatisfiesImports(cmd, {}) then
        chosenCmd = cmd
        break
      end
    end
  end

  local combinedOutput = nil
  local driverFailed = false
  if chosenCmd ~= nil then
    local ok, result = pcall(pandoc.pipe, chosenCmd, { driverPath }, "")
    if ok then
      combinedOutput = result
    else
      driverFailed = true
    end
  end

  for _, path in ipairs(tmpFiles) do
    os.remove(path)
  end

  if combinedOutput == nil then
    -- Two very different causes, and saying the wrong one costs hours:
    -- either no interpreter exists at all, or one was found and its run
    -- aborted (a cell killed the process, e.g. os._exit(), or the
    -- interpreter itself crashed).
    if driverFailed then
      io.stderr:write(
        "qpyodide.lua: autoexec ran '" .. tostring(chosenCmd) .. "' but it exited abnormally -- " ..
        "one of the opted-in {pyodide-python} cells most likely terminated the interpreter. " ..
        "No cell gets executed output this render; they fall back to plain highlighted source " ..
        "in non-interactive formats, and to the interactive editor in HTML.\n"
      )
    else
      io.stderr:write(
        "qpyodide.lua: no Python interpreter found for autoexec (tried python3, python) -- " ..
        "opted-in {pyodide-python} cells fall back to plain highlighted source in " ..
        "non-interactive formats, and to the interactive editor in HTML.\n"
      )
    end
    return nil
  end

  -- Python's print() on Windows writes CRLF (text-mode stdout); normalize
  -- to LF so the marker search below matches regardless of platform.
  combinedOutput = combinedOutput:gsub("\r\n", "\n")

  local outputs = {}
  local rest = combinedOutput
  local truncatedReported = false
  for i = 1, #cellSources do
    local marker = "<<<QPYAUTOEXEC_END_" .. i .. ">>>\n"
    local startPos, endPos = rest:find(marker, 1, true)
    local rawText
    if startPos then
      rawText = rest:sub(1, startPos - 1)
      rest = rest:sub(endPos + 1)
    else
      -- The driver never reported this cell as finished, so it stopped
      -- somewhere inside it. Everything after it has no output either.
      -- Without this warning that looks exactly like "the cell printed
      -- nothing" -- silently, in the rendered document and in the log.
      if not truncatedReported then
        truncatedReported = true
        io.stderr:write(
          "qpyodide.lua: autoexec output stops inside cell " .. i .. " of " .. #cellSources ..
          " -- the Python process ended early, so that cell and every one after it " ..
          "have no executed output in this render.\n"
        )
      end
      rawText = rest
      rest = ""
    end
    outputs[i] = splitAutoexecOutput(rawText)
  end

  return outputs
end

-- Pandoc-level pass that runs before enablePyodideCodeCell ever sees a
-- cell: collect every opted-in {pyodide-python} cell's cleaned source, in
-- document order, and run them all together, once -- so state shared
-- between cells (e.g. a variable from an earlier cell) works the same way
-- it does in the interactive, browser-side Pyodide runtime.
local function collectAndRunAutoexecCells(doc)
  if resolveAutoexecOptionKeyForCurrentFormat() == nil then
    return doc
  end

  local cellSources = {}
  doc:walk({
    CodeBlock = function(el)
      if isPyodideCell(el) then
        local code, cellOptions = extractCodeBlockOptions(el)
        if resolveEvalEnabled(cellOptions["eval"]) and cellWantsAutoexecHere(cellOptions) then
          table.insert(cellSources, code)
        end
      end
      return el
    end
  })

  autoexecResults = runAutoexecCellsForReal(cellSources)
  autoexecIndex = 0

  return doc
end

----
--- Real `{python}` cells opted in via a `# pyodide: ...` marker comment,
--- run for real by Quarto's own engine instead of `*-autoexec` -- the only
--- way to get a genuine, cross-referenceable Quarto figure out of a cell
--- that also becomes interactive in HTML. See handleMarkedCellDiv() below
--- for the (much more common) case where the engine ran and wrapped the
--- cell in a `.cell` Div; this part only handles what is left once that
--- pass is done -- i.e. a marker that survived because no engine ever ran
--- (`execute: enabled: false`), so the cell reaches here as a bare
--- CodeBlock with no `.cell` wrapper at all.

-- A marker line looks like `# pyodide: autorun, read-only=false` -- a plain
-- `#` comment, not `#|`: it is the only per-cell channel that survives a
-- real `{python}` cell's trip through Quarto's engine (see README/handoff
-- for why `#|` itself does not). Returns the code with that one line
-- removed, plus the parsed options table -- or `nil, nil` if the block
-- carries no marker at all.
local function extractPyodideMarker(code)
  local options = nil
  local keptLines = {}

  for line in (code .. "\n"):gmatch("(.-)\n") do
    local body = line:match("^%s*#%s*[Pp][Yy][Oo][Dd][Ii][Dd][Ee]%s*:%s*(.-)%s*$")
    if body and options == nil then
      options = {}
      for entry in body:gmatch("[^,]+") do
        local key, value = entry:match("^%s*([%w%-_]+)%s*=%s*(.-)%s*$")
        if key == nil then
          key = entry:match("^%s*([%w%-_]+)%s*$")
          value = "true"
        end
        if key then
          options[key] = value
        end
      end
    else
      table.insert(keptLines, line)
    end
  end

  if options == nil then
    return nil, nil
  end
  return table.concat(keptLines, "\n"):gsub("^%s*\n", ""):gsub("%s+$", ""), options
end

-- Reserve a spot for one interactive cell without numbering it yet, and
-- hand back a placeholder to insert in its place. Numbering (and the
-- qPyodideCapturedCodeBlocks push real cells share with the JS runtime)
-- has to wait for resolvePendingCells() below: a marked cell's own
-- position in qPyodideCounter order is decided by TWO separate, sequential
-- filter passes (handleMarkedCellDiv() for an engine-ran cell,
-- enablePyodideCodeCell() for everything else -- see the filter list at
-- the end of this file), which only ever see the whole document in their
-- own pass's document order, not interleaved with the other pass's cells.
-- Numbering here directly would put every marked cell before every
-- `{pyodide-python}` cell regardless of which actually comes first on the
-- page -- harmless if the two never share state, but a real, silent
-- NameError risk (wrong execution order in the browser's shared
-- namespace) the moment a page mixes both and one depends on the other's
-- variables. Deferring the count to a single later Span pass (Span is an
-- Inline, so pandoc visits every one of these placeholders, regardless of
-- which pass created it, in one true top-to-bottom sweep) fixes that.
local function reservePendingCell(cellCode, cellOptions)
  local idx = #pendingPyodideCells + 1
  pendingPyodideCells[idx] = { code = cellCode, options = cellOptions }
  return pandoc.Span({}, pandoc.Attr("", { "qpyodide-pending-cell" }, { ["data-qpyodide-pending"] = tostring(idx) }))
end

-- Give the final, resolved RawInline insertion point for one already-
-- reserved cell, in true document order -- see resolvePendingCells() below,
-- which is the only caller.
local function finalizePendingCell(entry)
  missingPyodideCell = false
  qPyodideCounter = qPyodideCounter + 1
  table.insert(qPyodideCapturedCodeBlocks, {
    id = qPyodideCounter,
    code = entry.code,
    options = entry.options
  })
  return pandoc.RawInline("html", qPyodideJSCellInsertionCode(qPyodideCounter))
end

-- Runs as its own pass, after both handleMarkedCellDiv() and
-- enablePyodideCodeCell() have replaced every interactive cell (marked or
-- `{pyodide-python}`) with a pending placeholder: assigns the real,
-- reading-order-correct qPyodideCounter id to each one it finds, in the
-- order this single pass encounters them.
local function resolvePendingCells(span)
  if not span.classes:includes("qpyodide-pending-cell") then
    return nil
  end
  local idx = tonumber(span.attributes["data-qpyodide-pending"])
  return finalizePendingCell(pendingPyodideCells[idx])
end

-- Register one marked cell as an interactive Pyodide cell and hand back a
-- placeholder for its insertion point -- see reservePendingCell() above.
local function buildInteractiveCell(cellCode, markerOptions)
  local cellOptions = mergeCellOptions(markerOptions)
  cellOptions["code-fold"] = resolveFoldState(cellOptions["code-fold"])
  return reservePendingCell(cellCode, cellOptions)
end

-- Handle a marked `{python}` CodeBlock that reaches the CodeBlock filter
-- still carrying its marker -- meaning no wrapping `.cell` Div consumed it
-- first (handleMarkedCellDiv() runs as its own pass before this one), so
-- Quarto's engine never actually ran this cell and there is no real,
-- executed output to preserve either way. Returns nil for anything that
-- isn't a marked `{python}` cell, so the caller can fall through to its own
-- handling.
local function enableMarkedPythonCodeCell(el)
  if not el.attr.classes:includes("python") then
    return nil
  end

  local cellCode, markerOptions = extractPyodideMarker(el.text)
  if markerOptions == nil then
    return nil
  end

  if not (quarto.doc.is_format("html") or quarto.doc.is_format("markdown")) then
    return pandoc.CodeBlock(cellCode, el.attr)
  end

  return buildInteractiveCell(cellCode, markerOptions)
end

-- Transform a {pyodide-python} code block into its real, executed output
-- (`*-autoexec`), a Pyodide interactive editor, or plain highlighted source
-- (`pdf-fallback`) -- depending on the current format and the cell's options.
local function enablePyodideCodeCell(el)

  local markedResult = enableMarkedPythonCodeCell(el)
  if markedResult ~= nil then
    return markedResult
  end

  -- Not a Pyodide cell: leave untouched regardless of output format.
  if not isPyodideCell(el) then
    return el
  end

  local cellCode, cellOptions = extractCodeBlockOptions(el)

  -- `eval: false` (cell-level `#|` override, cascading through Quarto's own
  -- document/project default the same way `code-fold` does): a real
  -- `{python}` cell with `eval: false` never executes and only shows its
  -- source -- often on purpose, for a syntax snippet that references
  -- variables that don't actually exist (e.g. `A[i,:]` to illustrate
  -- indexing). `{pyodide-python}` has no such restraint by default: the
  -- interactive editor lets a reader click "Run" regardless, and
  -- `*-autoexec` actually executes the cell for real at render time --
  -- both would otherwise ignore `eval` entirely and, for a snippet like
  -- that, surface a real NameError. Honor it the same way in every format,
  -- ahead of autoexec and the interactive editor alike: render as plain,
  -- highlighted-but-never-executed Python source, identical to the
  -- `pdf-fallback` block below.
  if not resolveEvalEnabled(cellOptions["eval"]) then
    return pandoc.CodeBlock(cellCode, pandoc.Attr(el.attr.identifier, {"python"}, {}))
  end

  local echoEnabled = resolveEchoEnabled(cellOptions["echo"])
  local includeEnabled = resolveIncludeEnabled(cellOptions["include"])

  -- Map `echo`/`include` onto this extension's own interactive/output/setup
  -- cell kinds (see qpyodide-cell-classes.js) for the interactive HTML/
  -- markdown path below, the same way real Quarto's `echo`/`include`
  -- decide what a real, executed cell shows: `include: false` -> "setup"
  -- (runs invisibly at startup, output discarded -- nothing shown at all),
  -- `echo: false` -> "output" (runs automatically at startup, shows only
  -- the output, never the source). An author's own explicit `#| context:`
  -- always wins over both.
  if not isVariablePopulated(cellOptions["context"]) then
    if not includeEnabled then
      cellOptions["context"] = "setup"
    elseif not echoEnabled then
      cellOptions["context"] = "output"
    end
  end

  -- Real, executed output takes priority over both the interactive HTML
  -- editor and the PDF/docx `pdf-fallback` static-highlight path below.
  -- collectAndRunAutoexecCells() already ran every opted-in cell (this one
  -- included) before this function ever sees them, in the same document
  -- order used here, so autoexecIndex lines up with autoexecResults.
  if cellWantsAutoexecHere(cellOptions) then
    autoexecIndex = autoexecIndex + 1

    if autoexecResults ~= nil then
      -- `include: false`: the code still ran for real (it's still in
      -- collectAndRunAutoexecCells()'s cellSources, sharing state with
      -- every other cell exactly like a real `include: false` chunk would),
      -- but neither its source nor its output ever appear in the document.
      if not includeEnabled then
        return {}
      end

      local segments = autoexecResults[autoexecIndex] or {}
      local blocks = {}
      if echoEnabled then
        table.insert(blocks, pandoc.CodeBlock(cellCode, pandoc.Attr(el.attr.identifier, { "python" }, {})))
      end

      -- `#| label:` / `#| fig-cap:` are carried onto the cell's figure the
      -- same way a real Quarto `{python}` cell carries them (see
      -- autoexecImageBlock() for what the label can and cannot do here).
      -- A cell has one label, so only the first figure can claim it; any
      -- further figure from the same cell stays plain.
      local figureLabel = stripOptionQuotes(cellOptions["label"] or "")
      local figureCaption = stripOptionQuotes(cellOptions["fig-cap"] or "")
      local labelUsed = false

      for _, segment in ipairs(segments) do
        if segment.kind == "image" then
          if labelUsed then
            table.insert(blocks, autoexecImageBlock(segment.value, "", ""))
          else
            labelUsed = true
            table.insert(blocks, autoexecImageBlock(segment.value, figureLabel, figureCaption))
          end
        else
          table.insert(blocks, pandoc.CodeBlock(segment.value,
            pandoc.Attr("", { "cell-output", "cell-output-stdout" }, {})))
        end
      end

      return pandoc.Div(blocks, pandoc.Attr("", { "cell" }, {}))
    end

    -- No Python interpreter was found on this machine (see
    -- runAutoexecCellsForReal(), which already reported it on stderr).
    -- Degrade to plain, highlighted-but-never-executed Python source
    -- rather than falling through: a cell that opted into `*-autoexec`
    -- has said what it wants, and that intent must not depend on whether
    -- `pdf-fallback` also happens to be switched on. Without this, the
    -- same cell would render as a raw, unstyled `{pyodide-python}` block
    -- with its `#|` comment lines still visible.
    --
    -- Interactive formats keep their normal handling: there the Pyodide
    -- editor below is the better degraded state, not static source.
    if not (quarto.doc.is_format("html") or quarto.doc.is_format("markdown")) then
      -- Nothing ran, so there is no output left to show once the source
      -- is hidden -- `echo: false` ends up the same as `include: false`.
      if not includeEnabled or not echoEnabled then
        return {}
      end
      return pandoc.CodeBlock(cellCode, pandoc.Attr(el.attr.identifier, { "python" }, {}))
    end
  end

  -- Non-interactive output formats (PDF, docx, ...): the client-side
  -- Pyodide/WASM runtime never runs here, and Quarto's own execution
  -- engines already skipped this block during the compute phase (that's
  -- the whole point of the non-standard "pyodide-python" language tag) --
  -- so there is no computed output to show. Opt-in via
  -- `pyodide: pdf-fallback: true` (document-wide) or `#| pdf-fallback:
  -- true` (per cell, overrides the document default) to present the
  -- source as normal, properly highlighted Python instead of the raw,
  -- unstyled `{pyodide-python}` block; the `#|` cell-option comments that
  -- a real Python engine would otherwise have hidden are stripped either
  -- way. Off by default: the block passes through unchanged.
  if not (quarto.doc.is_format("html") or quarto.doc.is_format("markdown")) then
    local fallback = pdfFallback
    if isVariablePopulated(cellOptions["pdf-fallback"]) then
      fallback = cellOptions["pdf-fallback"]
    end

    if isPdfFallbackEnabled(fallback) then
      -- This path never actually executes the cell (no autoexec here), so
      -- there is no separate output to fall back to once the source is
      -- hidden -- `echo: false` therefore has nothing left to show either,
      -- same end result as `include: false`.
      if not includeEnabled or not echoEnabled then
        return {}
      end
      return pandoc.CodeBlock(cellCode, pandoc.Attr(el.attr.identifier, {"python"}, {}))
    end

    return el
  end

  -- Resolve the initial fold state against Quarto's own `code-fold`
  -- (document/project/profile), with the cell's own `#| code-fold:` taking
  -- precedence. Overwrites the raw option with the resolved "hide"/"show".
  cellOptions["code-fold"] = resolveFoldState(cellOptions["code-fold"])

  -- Reserve a spot rather than numbering immediately -- see
  -- reservePendingCell()'s own comment for why: this pass runs separately
  -- from handleMarkedCellDiv()'s, so numbering here would put every
  -- `{pyodide-python}` cell after every marked cell regardless of which
  -- actually comes first on the page.
  return reservePendingCell(cellCode, cellOptions)
end

-- The far more common case: Quarto's engine actually ran the marked cell,
-- so it reaches this filter already wrapped as
--   Div .cell
--     CodeBlock python cell-code      <- source, marker line still in it
--     Div .cell-output-display
--       FloatRefTarget                <- real figure + caption
-- with real output, a real caption and a real crossref anchor already
-- built in -- none of which `*-autoexec` can ever produce (Quarto builds
-- its crossref index before any extension filter runs, see README). Runs
-- as its own pass, before the CodeBlock pass above, so that a marked
-- CodeBlock found here is always removed/replaced before
-- enableMarkedPythonCodeCell() ever gets a chance to see it -- that
-- ordering is what tells the two cases apart, since a bare marked
-- CodeBlock with no `.cell` wrapper (`execute: enabled: false`) never runs
-- through here at all.
local function handleMarkedCellDiv(el)
  if not (el.attr and el.attr.classes:includes("cell")) then
    return nil
  end

  local markerOptions, cellCode, codeIndex
  for i, blk in ipairs(el.content) do
    if blk.t == "CodeBlock" and blk.attr.classes:includes("python") then
      local code, opts = extractPyodideMarker(blk.text)
      if opts ~= nil then
        markerOptions, cellCode, codeIndex = opts, code, i
        break
      end
    end
  end
  if markerOptions == nil then
    return nil
  end

  -- Non-interactive formats (PDF, docx, ...): the engine already produced
  -- the real output, crossrefs and all -- only the marker line itself has
  -- to disappear from the displayed source.
  if not (quarto.doc.is_format("html") or quarto.doc.is_format("markdown")) then
    el.content[codeIndex] = pandoc.CodeBlock(cellCode, el.content[codeIndex].attr)
    return el
  end

  local insertion = buildInteractiveCell(cellCode, markerOptions)

  -- Keep Quarto's own figure float (and with it the caption and the
  -- crossref anchor another chapter's `@fig-...` resolves to) but swap the
  -- static image for the live interactive cell, and drop the
  -- now-duplicated source and stdout that the engine also produced.
  table.remove(el.content, codeIndex)

  local placed = false
  local rebuilt = el:walk({
    Div = function(d)
      if d.attr.classes:includes("cell-output-stdout") then
        return {}
      end
      return d
    end,
    Plain = function(pl)
      if not placed and #pl.content == 1 and pl.content[1].t == "Image" then
        placed = true
        return pandoc.Plain({ insertion })
      end
      return pl
    end
  })

  if not placed then
    table.insert(rebuilt.content, pandoc.Plain({ insertion }))
  end
  return rebuilt
end

local function stitchDocument(doc)

  -- Do not attach Pyodide as the page lacks any active Pyodide cells
  if missingPyodideCell then
    return doc
  end

  -- Release injections into the HTML document after each cell
  -- is visited and we have collected all the content.
  ensurePyodideSetup()

  return doc
end

return {
  {
    Meta = setPyodideInitializationOptions
  },
  {
    Pandoc = collectAndRunAutoexecCells
  },
  {
    -- Runs as its own pass, strictly before the CodeBlock pass below: see
    -- handleMarkedCellDiv()'s own comment for why the ordering (not just
    -- the presence) of these two passes is what tells apart a marked cell
    -- the engine actually ran from one it never did.
    Div = handleMarkedCellDiv
  },
  {
    CodeBlock = enablePyodideCodeCell
  },
  {
    -- Single pass, after both cell-producing passes above: assigns the
    -- final, reading-order-correct id to every reserved cell regardless of
    -- which pass reserved it. See reservePendingCell()'s comment.
    Span = resolvePendingCells
  },
  {
    Pandoc = stitchDocument
  }
}
