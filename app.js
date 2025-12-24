const MODEL_ID = "gemini-3-pro-image-preview";
const DEFAULT_HOST = "https://generativelanguage.googleapis.com";
const API_PATH = `/v1beta/models/${MODEL_ID}:generateContent`;
const KEEP_ORIGINAL_PROMPT =
  "在基于输入图片生成或编辑时，优先匹配输入图片的宽高比，若模型无法生成完全一致的比例，则请将超出输入画幅的区域用纯黑填充，不要生成画幅之外的任何新内容。生成后请确保可以裁切为与输入图片相同的画幅比例。";

// ----- utils -----
const $ = (id) => document.getElementById(id);

function stripTrailingSlash(s) { return s.replace(/\/+$/, ""); }

function safeNumberOrEmpty(v) {
  const t = String(v ?? "").trim();
  if (!t) return "";
  const n = Number(t);
  return Number.isFinite(n) ? n : "";
}

function humanBytes(bytes) {
  const units = ["B", "KB", "MB", "GB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function base64FromArrayBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function nowISO() { return new Date().toISOString(); }

function isLikelyNetworkError(err) {
  // Safari/Chromium: fetch network errors often surface as TypeError
  const name = String(err?.name || "");
  const msg = String(err?.message || "");
  if (name === "TypeError") return true;
  if (/network/i.test(msg)) return true;
  if (/load failed/i.test(msg)) return true; // Safari
  return false;
}

// ----- DOM -----
const els = {
  form: $("form"),

  // fixed
  apiHost: $("apiHost"),
  apiKey: $("apiKey"),
  rememberKey: $("rememberKey"),
  useHeaderKey: $("useHeaderKey"),

  // mode switch
  modeForm: $("modeForm"),
  modeJson: $("modeJson"),
  formModeWrap: $("formModeWrap"),
  jsonModeWrap: $("jsonModeWrap"),

  // form fields
  systemPrompt: $("systemPrompt"),
  prompt: $("prompt"),
  imageFile: $("imageFile"),
  dropZone: $("dropZone"),
  imagePreview: $("imagePreview"),
  imagePreviewImg: $("imagePreviewImg"),
  imageMeta: $("imageMeta"),
  clearImage: $("clearImage"),
  keepOriginalAspect: $("keepOriginalAspect"),
  aspectRatio: $("aspectRatio"),
  imageSize: $("imageSize"),
  temperature: $("temperature"),
  topP: $("topP"),

  // json editor
  requestBodyJson: $("requestBodyJson"),
  jsonFormat: $("jsonFormat"),
  jsonFromForm: $("jsonFromForm"),
  jsonToForm: $("jsonToForm"),

  // presets
  presetSelect: $("presetSelect"),
  presetSave: $("presetSave"),
  presetUpdate: $("presetUpdate"),
  presetDelete: $("presetDelete"),
  presetExport: $("presetExport"),
  presetImport: $("presetImport"),

  // actions
  runBtn: $("runBtn"),
  resetBtn: $("resetBtn"),
  status: $("status"),

  // result
  resultEmpty: $("resultEmpty"),
  result: $("result"),
  modelName: $("modelName"),
  latency: $("latency"),
  copyCurl: $("copyCurl"),
  copyJson: $("copyJson"),
  textOutWrap: $("textOutWrap"),
  textOut: $("textOut"),
  imagesOutWrap: $("imagesOutWrap"),
  imagesOut: $("imagesOut"),
  rawJson: $("rawJson"),
};

// ----- storage keys -----
const storageKeys = {
  host: "g3_host",
  rememberKey: "g3_remember_key",
  apiKey: "g3_api_key",
  useHeaderKey: "g3_use_header_key",

  // last UI state
  uiMode: "g3_ui_mode",
  requestBodyJson: "g3_request_body_json",

  // form values
  systemPrompt: "g3_system_prompt",
  keepOriginalAspect: "g3_keep_original_aspect",
  aspectRatio: "g3_aspect_ratio",
  imageSize: "g3_image_size",
  temperature: "g3_temperature",
  topP: "g3_topP",

  // presets storage
  presets: "g3_presets_v1",
  activePreset: "g3_active_preset_name",
};

// ----- state -----
let uiMode = "form"; // "form" | "json"
let selectedImage = null; // { mimeType, base64, size, name, dataUrl, width, height }
let lastRequest = null;   // { url, headers, body }
let objectUrls = [];      // blob URLs for output images

// iOS background mitigation
let requestInFlight = false;
let hiddenDuringRequest = false;
let wakeLock = null;

// ----- status -----
function setStatus(msg, visible = true) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("hidden", !visible);
}

// ----- image helpers -----
function loadImageDimensions(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth || img.width, height: img.naturalHeight || img.height });
    };
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function readImageFile(file) {
  const mimeType = file.type || "application/octet-stream";
  const size = file.size;
  const name = file.name || "image";
  const dataUrl = URL.createObjectURL(file); // preview only

  let width = null;
  let height = null;
  try {
    ({ width, height } = await loadImageDimensions(dataUrl));
  } catch {}

  const arrayBuf = await file.arrayBuffer();
  const base64 = base64FromArrayBuffer(arrayBuf);
  return { mimeType, size, name, base64, dataUrl, width, height };
}

function clearSelectedImage() {
  if (selectedImage?.dataUrl) URL.revokeObjectURL(selectedImage.dataUrl);
  selectedImage = null;
  els.imagePreview.classList.add("hidden");
  els.imagePreviewImg.src = "";
  els.imageMeta.textContent = "";
  if (els.imageFile) els.imageFile.value = "";

  // 保持原图比例选项仅在存在图片时可用
  if (els.keepOriginalAspect) {
    els.keepOriginalAspect.checked = false;
    updateKeepOriginalAspectState();
  }
}

function showSelectedImage(info) {
  els.imagePreviewImg.src = info.dataUrl;
  const dimStr = (info.width && info.height) ? ` · ${info.width}×${info.height}` : "";
  els.imageMeta.textContent = `${info.name} · ${humanBytes(info.size)} · ${info.mimeType}${dimStr}`;
  els.imagePreview.classList.remove("hidden");
}

function b64ToBlobUrl(b64, mimeType) {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  const blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  objectUrls.push(url);
  return { url, blob };
}

function cleanupObjectUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
}

function isKeepOriginalAspectEnabled() {
  return !!selectedImage && !!els.keepOriginalAspect?.checked;
}

function updateKeepOriginalAspectState() {
  const hasImage = !!selectedImage;
  if (!els.keepOriginalAspect) return;

  els.keepOriginalAspect.disabled = !hasImage;
  els.keepOriginalAspect.parentElement?.classList.toggle("disabled", !hasImage);

  if (!hasImage && els.keepOriginalAspect.checked) {
    els.keepOriginalAspect.checked = false;
  }

  const lockJson = isKeepOriginalAspectEnabled();
  els.modeJson.disabled = lockJson;
  els.modeJson.title = lockJson
    ? "已启用保持原图比例，暂不可使用自定义 JSON 模式"
    : "切换到 JSON 模式";
  [els.jsonFormat, els.jsonFromForm, els.jsonToForm].forEach((btn) => {
    if (!btn) return;
    btn.disabled = lockJson;
    btn.title = lockJson
      ? "保持原图比例开启时禁用 JSON 工具"
      : "";
  });

  // 强制停留在表单模式
  if (lockJson && uiMode === "json") {
    setMode("form");
    setStatus("保持原图比例开启时已切回表单模式，JSON 模式不可用。", true);
    setTimeout(() => setStatus("", false), 1400);
  }
}

// ----- wake lock (best-effort) -----
async function requestWakeLock() {
  try {
    if (!("wakeLock" in navigator)) return;
    if (wakeLock) return;
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => { wakeLock = null; });
  } catch {
    // ignore
  }
}

function releaseWakeLock() {
  try { wakeLock?.release?.(); } catch {}
  wakeLock = null;
}

// ----- build body (form mode) -----
function buildBodyFromForm() {
  const keepOriginalAspect = isKeepOriginalAspectEnabled();

  const systemPrompt = els.systemPrompt.value.trim();
  const prompt = els.prompt.value.trim();
  const aspectRatio = keepOriginalAspect ? "" : els.aspectRatio.value;
  const imageSize = els.imageSize.value;

  const temperature = safeNumberOrEmpty(els.temperature.value);
  const topP = safeNumberOrEmpty(els.topP.value);

  if (!prompt) throw new Error("请填写提示词（必填）。");

  const parts = [{ text: prompt }];
  if (selectedImage) {
    parts.push({
      inline_data: {
        mime_type: selectedImage.mimeType,
        data: selectedImage.base64,
      },
    });
  }

  const body = {
    contents: [{
      role: "user",
      parts,
    }],
    generationConfig: {
      responseModalities: ["Image"],
    },
  };

  const systemParts = [];
  if (keepOriginalAspect) {
    const dims = (selectedImage?.width && selectedImage?.height)
      ? ` 输入图片宽度：${selectedImage.width}，高度：${selectedImage.height}，宽高比（宽/高）：${(selectedImage.width / selectedImage.height).toFixed(4)}`
      : "";
    systemParts.push(`${KEEP_ORIGINAL_PROMPT}${dims}`.trim());
  }
  if (systemPrompt) systemParts.push(systemPrompt);

  if (systemParts.length) {
    body.systemInstruction = {
      parts: systemParts.map(text => ({ text })),
    };
  }

  if (temperature !== "") body.generationConfig.temperature = temperature;
  if (topP !== "") body.generationConfig.topP = topP;

  if (aspectRatio || imageSize) {
    body.generationConfig.imageConfig = {};
    if (aspectRatio) body.generationConfig.imageConfig.aspectRatio = aspectRatio;
    if (imageSize) body.generationConfig.imageConfig.imageSize = imageSize;
  }

  return body;
}

// ----- build request (host/key fixed; body depends on mode) -----
function buildRequest() {
  const host = stripTrailingSlash(els.apiHost.value.trim() || DEFAULT_HOST);
  const apiKey = els.apiKey.value.trim();
  const useHeaderKey = els.useHeaderKey.checked;

  if (!apiKey) throw new Error("请填写 API Key。");

  if (uiMode === "json" && isKeepOriginalAspectEnabled()) {
    throw new Error("已启用保持原图比例，暂不支持自定义 JSON 模式。请切换到表单模式。");
  }

  const url = useHeaderKey
    ? `${host}${API_PATH}`
    : `${host}${API_PATH}?key=${encodeURIComponent(apiKey)}`;

  let body;
  if (uiMode === "json") {
    const raw = els.requestBodyJson.value.trim();
    if (!raw) throw new Error("JSON 模式下请求体不能为空。");
    try {
      body = JSON.parse(raw);
    } catch (e) {
      throw new Error(`JSON 解析失败：${e?.message || e}`);
    }
  } else {
    body = buildBodyFromForm();
  }

  const headers = { "Content-Type": "application/json" };
  if (useHeaderKey) headers["x-goog-api-key"] = apiKey;

  return { url, headers, body };
}

function makeCurl({ url, headers, body }) {
  const h = Object.entries(headers)
    .map(([k, v]) => `-H ${JSON.stringify(`${k}: ${v}`)}`)
    .join(" \\\n  ");
  return [
    "curl -s -X POST \\",
    `  ${JSON.stringify(url)} \\`,
    `  ${h} \\`,
    `  -d ${JSON.stringify(JSON.stringify(body))}`,
    "",
  ].join("\n");
}

// ----- render -----
function timestampTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function loadImageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function cropImageToAspect(url, targetAspect) {
  if (!targetAspect || !Number.isFinite(targetAspect) || targetAspect <= 0) {
    return { url, cropped: false };
  }

  const img = await loadImageFromUrl(url);
  const originalAspect = img.naturalWidth / img.naturalHeight;
  if (!Number.isFinite(originalAspect) || Math.abs(originalAspect - targetAspect) < 0.0001) {
    return {
      url,
      cropped: false,
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  }

  let sx = 0;
  let sy = 0;
  let sw = img.naturalWidth;
  let sh = img.naturalHeight;

  if (originalAspect > targetAspect) {
    sw = img.naturalHeight * targetAspect;
    sx = (img.naturalWidth - sw) / 2;
  } else {
    sh = img.naturalWidth / targetAspect;
    sy = (img.naturalHeight - sh) / 2;
  }

  const canvas = document.createElement("canvas");
  canvas.width = sw;
  canvas.height = sh;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);

  const blob = await new Promise((resolve, reject) => {
    canvas.toBlob((b) => b ? resolve(b) : reject(new Error("裁切失败")), "image/png");
  });
  const croppedUrl = URL.createObjectURL(blob);
  objectUrls.push(croppedUrl);

  return { url: croppedUrl, cropped: true, width: sw, height: sh, rawWidth: img.naturalWidth, rawHeight: img.naturalHeight };
}

async function renderResult({ data, ms }) {
  els.resultEmpty.classList.add("hidden");
  els.result.classList.remove("hidden");

  els.modelName.textContent = MODEL_ID;
  els.latency.textContent = `${ms.toFixed(0)} ms`;

  els.rawJson.textContent = JSON.stringify(data, null, 2);

  const candidates = data?.candidates || [];
  const first = candidates[0]?.content?.parts || [];
  const texts = [];
  const images = [];

  for (const p of first) {
    if (typeof p?.text === "string" && p.text.trim()) {
      texts.push(p.text);
      continue;
    }
    const inline = p.inlineData || p.inline_data;
    if (inline?.data) {
      const mimeType = inline.mimeType || inline.mime_type || "image/png";
      images.push({ b64: inline.data, mimeType });
    }
  }

  if (texts.length) {
    els.textOutWrap.classList.remove("hidden");
    els.textOut.textContent = texts.join("\n\n---\n\n");
  } else {
    els.textOutWrap.classList.add("hidden");
    els.textOut.textContent = "";
  }

  els.imagesOut.innerHTML = "";
  cleanupObjectUrls();

  if (images.length) {
    els.imagesOutWrap.classList.remove("hidden");
    const tag = timestampTag();

    for (const [idx, img] of images.entries()) {
      const { url } = b64ToBlobUrl(img.b64, img.mimeType);
      const ext =
        img.mimeType.includes("png") ? "png" :
        img.mimeType.includes("jpeg") ? "jpg" :
        img.mimeType.includes("webp") ? "webp" : "bin";

      const filename = `gemini3_image_${tag}_${String(idx + 1).padStart(2, "0")}.${ext}`;

      const targetAspect = isKeepOriginalAspectEnabled() && selectedImage?.width && selectedImage?.height
        ? (selectedImage.width / selectedImage.height)
        : null;
      let cropResult = { url, cropped: false };
      if (targetAspect) {
        try {
          cropResult = await cropImageToAspect(url, targetAspect);
        } catch (e) {
          console.warn("裁切到原图比例失败，已回退原始输出", e);
          cropResult = { url, cropped: false };
        }
      }
      const { url: displayUrl, cropped, rawWidth, rawHeight, width, height } = cropResult;

      const card = document.createElement("div");
      card.className = "imgcard";

      const imageEl = document.createElement("img");
      imageEl.src = displayUrl;
      imageEl.alt = `生成图片 ${idx + 1}`;

      const bar = document.createElement("div");
      bar.className = "bar";

      const left = document.createElement("div");
      const cropInfo = cropped && rawWidth && rawHeight
        ? ` · 已裁切到 ${Math.round(width)}×${Math.round(height)}（原始 ${rawWidth}×${rawHeight}）`
        : "";
      left.textContent = `${img.mimeType || "image"} · ${filename}${cropInfo}`;
      left.style.color = "rgba(233,237,245,0.85)";
      left.style.fontSize = "12px";

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = "12px";
      right.style.flexWrap = "wrap";
      right.style.alignItems = "center";

      const openProcessed = document.createElement("a");
      openProcessed.className = "link";
      openProcessed.href = displayUrl;
      openProcessed.target = "_blank";
      openProcessed.rel = "noopener";
      openProcessed.textContent = cropped ? "打开裁切后" : "打开";

      const dlProcessed = document.createElement("a");
      dlProcessed.className = "link";
      dlProcessed.href = displayUrl;
      dlProcessed.download = filename;
      dlProcessed.textContent = cropped ? "下载裁切后" : "下载";

      const openRaw = document.createElement("a");
      openRaw.className = "link";
      openRaw.href = url;
      openRaw.target = "_blank";
      openRaw.rel = "noopener";
      openRaw.textContent = "查看原始输出";

      right.appendChild(openProcessed);
      right.appendChild(dlProcessed);
      right.appendChild(openRaw);

      bar.appendChild(left);
      bar.appendChild(right);

      card.appendChild(imageEl);
      card.appendChild(bar);

      els.imagesOut.appendChild(card);
    });
  } else {
    els.imagesOutWrap.classList.add("hidden");
  }
}

// ----- persistence (non-preset state) -----
function persistBase() {
  localStorage.setItem(storageKeys.host, els.apiHost.value.trim());
  localStorage.setItem(storageKeys.rememberKey, String(els.rememberKey.checked));
  localStorage.setItem(storageKeys.useHeaderKey, String(els.useHeaderKey.checked));

  localStorage.setItem(storageKeys.uiMode, uiMode);
  localStorage.setItem(storageKeys.requestBodyJson, els.requestBodyJson.value);

  // Keep some last used form values for convenience (not presets)
  localStorage.setItem(storageKeys.systemPrompt, els.systemPrompt.value);
  localStorage.setItem(storageKeys.keepOriginalAspect, String(isKeepOriginalAspectEnabled()));
  localStorage.setItem(storageKeys.aspectRatio, els.aspectRatio.value);
  localStorage.setItem(storageKeys.imageSize, els.imageSize.value);
  localStorage.setItem(storageKeys.temperature, els.temperature.value);
  localStorage.setItem(storageKeys.topP, els.topP.value);

  if (els.rememberKey.checked) {
    localStorage.setItem(storageKeys.apiKey, els.apiKey.value);
  } else {
    localStorage.removeItem(storageKeys.apiKey);
  }
}

function restoreBase() {
  els.apiHost.value = localStorage.getItem(storageKeys.host) || "";
  els.rememberKey.checked = (localStorage.getItem(storageKeys.rememberKey) || "false") === "true";
  els.useHeaderKey.checked = (localStorage.getItem(storageKeys.useHeaderKey) || "false") === "true";

  uiMode = (localStorage.getItem(storageKeys.uiMode) || "form");
  els.requestBodyJson.value = localStorage.getItem(storageKeys.requestBodyJson) || "";

  els.systemPrompt.value = localStorage.getItem(storageKeys.systemPrompt) || "";
  els.keepOriginalAspect.checked = (localStorage.getItem(storageKeys.keepOriginalAspect) || "false") === "true";
  els.aspectRatio.value = localStorage.getItem(storageKeys.aspectRatio) || "";
  els.imageSize.value = localStorage.getItem(storageKeys.imageSize) || "";
  els.temperature.value = localStorage.getItem(storageKeys.temperature) || "";
  els.topP.value = localStorage.getItem(storageKeys.topP) || "";

  const savedKey = localStorage.getItem(storageKeys.apiKey) || "";
  if (els.rememberKey.checked && savedKey) {
    els.apiKey.value = savedKey;
  }
}

// ----- mode switching -----
function setMode(mode) {
  if (mode === "json" && isKeepOriginalAspectEnabled()) {
    setStatus("保持原图比例开启时无法使用自定义 JSON 模式。", true);
    return;
  }

  uiMode = mode;
  els.modeForm.classList.toggle("active", mode === "form");
  els.modeJson.classList.toggle("active", mode === "json");
  els.modeForm.setAttribute("aria-selected", String(mode === "form"));
  els.modeJson.setAttribute("aria-selected", String(mode === "json"));

  els.formModeWrap.classList.toggle("hidden", mode !== "form");
  els.jsonModeWrap.classList.toggle("hidden", mode !== "json");

  // On entering JSON mode: sync from form to JSON by default (non-destructive)
  if (mode === "json") {
    try {
      const body = buildBodyFromForm();
      els.requestBodyJson.value = JSON.stringify(body, null, 2);
      setStatus("", false);
    } catch (e) {
      // If form incomplete, keep existing JSON; show hint
      setStatus(`切换到 JSON 模式：无法从表单生成默认 JSON（${e?.message || e}）。你可以直接编辑 JSON。`, true);
    }
  }

  persistBase();
}

function formatJsonEditor() {
  const raw = els.requestBodyJson.value.trim();
  if (!raw) { setStatus("JSON 为空。", true); return; }
  try {
    const obj = JSON.parse(raw);
    els.requestBodyJson.value = JSON.stringify(obj, null, 2);
    setStatus("已格式化 JSON。", true);
    setTimeout(() => setStatus("", false), 1000);
  } catch (e) {
    setStatus(`JSON 解析失败：${e?.message || e}`, true);
  }
}

function syncJsonFromForm() {
  try {
    const body = buildBodyFromForm();
    els.requestBodyJson.value = JSON.stringify(body, null, 2);
    setStatus("已从表单同步生成 JSON。", true);
    setTimeout(() => setStatus("", false), 1000);
    persistBase();
  } catch (e) {
    setStatus(e?.message || String(e), true);
  }
}

async function applyJsonToFormBestEffort() {
  const raw = els.requestBodyJson.value.trim();
  if (!raw) { setStatus("JSON 为空，无法回填。", true); return; }

  let obj;
  try {
    obj = JSON.parse(raw);
  } catch (e) {
    setStatus(`JSON 解析失败：${e?.message || e}`, true);
    return;
  }

  // system prompt
  try {
    const sp = obj?.systemInstruction?.parts?.[0]?.text;
    if (typeof sp === "string") els.systemPrompt.value = sp;
  } catch {}

  // prompt + image from first user parts
  try {
    const parts = obj?.contents?.[0]?.parts || [];
    let text = "";
    let inline = null;

    for (const p of parts) {
      if (!text && typeof p?.text === "string") text = p.text;
      const cand = p?.inline_data || p?.inlineData;
      if (!inline && cand?.data) inline = cand;
    }
    if (text) els.prompt.value = text;

    if (inline?.data) {
      // replace selectedImage from base64
      clearSelectedImage();
      const mimeType = inline.mime_type || inline.mimeType || "application/octet-stream";
      const base64 = inline.data;
      const { url, blob } = b64ToBlobUrl(base64, mimeType); // reuse helper to make preview URL
      // NOTE: b64ToBlobUrl adds to objectUrls; but that's for output cleanup.
      // For input preview we need a persistent URL not cleaned by output cleanup,
      // so we create a dedicated one:
      URL.revokeObjectURL(url);
      const inputBlob = new Blob([blob], { type: mimeType });
      const dataUrl = URL.createObjectURL(inputBlob);

      let width = null;
      let height = null;
      try {
        ({ width, height } = await loadImageDimensions(dataUrl));
      } catch {}

      selectedImage = {
        mimeType,
        base64,
        size: inputBlob.size || base64.length,
        name: "preset_image",
        dataUrl,
        width,
        height,
      };
      showSelectedImage(selectedImage);
      updateKeepOriginalAspectState();
    }
  } catch {}

  // generation config
  try {
    const gc = obj?.generationConfig || {};
    if (typeof gc.temperature === "number") els.temperature.value = String(gc.temperature);
    if (typeof gc.topP === "number") els.topP.value = String(gc.topP);
    const ic = gc.imageConfig || {};
    if (typeof ic.aspectRatio === "string") els.aspectRatio.value = ic.aspectRatio;
    if (typeof ic.imageSize === "string") els.imageSize.value = ic.imageSize;
  } catch {}

  setStatus("已尽力将 JSON 回填到表单（可能存在字段不完全匹配）。", true);
  setTimeout(() => setStatus("", false), 1400);
  persistBase();
}

// ----- presets -----
function loadPresets() {
  try {
    const raw = localStorage.getItem(storageKeys.presets);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr;
  } catch {
    return [];
  }
}

function savePresets(arr) {
  localStorage.setItem(storageKeys.presets, JSON.stringify(arr));
}

function refreshPresetUI() {
  const presets = loadPresets();
  const activeName = localStorage.getItem(storageKeys.activePreset) || "";

  // Rebuild options
  els.presetSelect.innerHTML = "";
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "（无预设）";
  els.presetSelect.appendChild(empty);

  for (const p of presets) {
    const opt = document.createElement("option");
    opt.value = p.name;
    opt.textContent = p.name;
    if (p.name === activeName) opt.selected = true;
    els.presetSelect.appendChild(opt);
  }

  const hasActive = !!activeName && presets.some(p => p.name === activeName);
  els.presetUpdate.disabled = !hasActive;
  els.presetDelete.disabled = !hasActive;
}

function getCurrentPresetName() {
  return els.presetSelect.value || (localStorage.getItem(storageKeys.activePreset) || "");
}

function makePresetFromCurrentState() {
  const preset = {
    name: "",
    createdAt: nowISO(),
    updatedAt: nowISO(),
    mode: uiMode,
    fields: {
      systemPrompt: els.systemPrompt.value,
      prompt: els.prompt.value,
      keepOriginalAspect: isKeepOriginalAspectEnabled(),
      aspectRatio: els.aspectRatio.value,
      imageSize: els.imageSize.value,
      temperature: els.temperature.value,
      topP: els.topP.value,
    },
    image: selectedImage ? {
      mimeType: selectedImage.mimeType,
      base64: selectedImage.base64,
      name: selectedImage.name,
      size: selectedImage.size,
    } : null,
    requestBodyJson: els.requestBodyJson.value,
  };
  return preset;
}

async function applyPreset(preset) {
  // DO NOT touch host/key (as required)
  // Mode
  setMode(preset.mode === "json" ? "json" : "form");

  // Fields
  const f = preset.fields || {};
  els.systemPrompt.value = f.systemPrompt ?? "";
  els.prompt.value = f.prompt ?? "";
  els.keepOriginalAspect.checked = !!f.keepOriginalAspect;
  els.aspectRatio.value = f.aspectRatio ?? "";
  els.imageSize.value = f.imageSize ?? "";
  els.temperature.value = f.temperature ?? "";
  els.topP.value = f.topP ?? "";

  // JSON body
  if (typeof preset.requestBodyJson === "string") {
    els.requestBodyJson.value = preset.requestBodyJson;
  }

  // Image
  clearSelectedImage();
  if (preset.image?.base64) {
    const mimeType = preset.image.mimeType || "application/octet-stream";
    const base64 = preset.image.base64;
    const { blob } = b64ToBlobUrl(base64, mimeType);
    const inputBlob = new Blob([blob], { type: mimeType });
    const dataUrl = URL.createObjectURL(inputBlob);

    let width = null;
    let height = null;
    try {
      ({ width, height } = await loadImageDimensions(dataUrl));
    } catch {}

    selectedImage = {
      mimeType,
      base64,
      size: preset.image.size || inputBlob.size,
      name: preset.image.name || "preset_image",
      dataUrl,
      width,
      height,
    };
    showSelectedImage(selectedImage);
  }

  updateKeepOriginalAspectState();
  persistBase();
  setStatus(`已应用预设：${preset.name}\n（Host / Key 未改变）`, true);
  setTimeout(() => setStatus("", false), 1400);
}

function saveAsPreset() {
  const name = (prompt("请输入预设名称（Host / Key 不会保存到预设中）：") || "").trim();
  if (!name) return;

  const presets = loadPresets();
  const existing = presets.find(p => p.name === name);

  if (existing) {
    const ok = confirm(`预设“${name}”已存在，是否覆盖？`);
    if (!ok) return;
    const next = makePresetFromCurrentState();
    next.name = name;
    next.createdAt = existing.createdAt || nowISO();
    next.updatedAt = nowISO();

    const idx = presets.findIndex(p => p.name === name);
    presets[idx] = next;
  } else {
    const next = makePresetFromCurrentState();
    next.name = name;
    presets.push(next);
  }

  try {
    savePresets(presets);
  } catch (e) {
    setStatus(`保存失败：可能是本地存储空间不足（预设图片会占用较多空间）。\n${e?.message || e}`, true);
    return;
  }

  localStorage.setItem(storageKeys.activePreset, name);
  refreshPresetUI();
  setStatus(`已保存预设：${name}`, true);
  setTimeout(() => setStatus("", false), 1200);
}

function updateActivePreset() {
  const name = getCurrentPresetName();
  if (!name) return;

  const presets = loadPresets();
  const idx = presets.findIndex(p => p.name === name);
  if (idx < 0) return;

  const ok = confirm(`确认更新预设“${name}”？`);
  if (!ok) return;

  const existing = presets[idx];
  const next = makePresetFromCurrentState();
  next.name = name;
  next.createdAt = existing.createdAt || nowISO();
  next.updatedAt = nowISO();
  presets[idx] = next;

  try {
    savePresets(presets);
  } catch (e) {
    setStatus(`更新失败：可能是本地存储空间不足。\n${e?.message || e}`, true);
    return;
  }

  localStorage.setItem(storageKeys.activePreset, name);
  refreshPresetUI();
  setStatus(`已更新预设：${name}`, true);
  setTimeout(() => setStatus("", false), 1200);
}

function deleteActivePreset() {
  const name = getCurrentPresetName();
  if (!name) return;

  const ok = confirm(`确认删除预设“${name}”？该操作不可撤销。`);
  if (!ok) return;

  const presets = loadPresets().filter(p => p.name !== name);
  savePresets(presets);

  localStorage.removeItem(storageKeys.activePreset);
  refreshPresetUI();
  setStatus(`已删除预设：${name}`, true);
  setTimeout(() => setStatus("", false), 1200);
}

function exportPresets() {
  const presets = loadPresets();
  const payload = {
    version: 1,
    exportedAt: nowISO(),
    presets,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `gemini3_presets_${timestampTag()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setStatus(`已导出预设：${presets.length} 个`, true);
  setTimeout(() => setStatus("", false), 1200);
}

async function importPresetsFromFile(file) {
  if (!file) return;
  let text = "";
  try {
    text = await file.text();
  } catch (e) {
    setStatus(`读取导入文件失败：${e?.message || e}`, true);
    return;
  }

  let obj;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    setStatus(`导入失败：JSON 解析错误：${e?.message || e}`, true);
    return;
  }

  const incoming = Array.isArray(obj?.presets) ? obj.presets : (Array.isArray(obj) ? obj : []);
  if (!incoming.length) {
    setStatus("导入失败：未发现 presets 数组。", true);
    return;
  }

  const existing = loadPresets();
  const nameSet = new Set(existing.map(p => p.name));

  const merged = [...existing];
  let added = 0;

  for (const p of incoming) {
    if (!p?.name) continue;
    let name = String(p.name).trim();
    if (!name) continue;

    // Resolve conflicts: append suffix
    if (nameSet.has(name)) {
      let i = 1;
      while (nameSet.has(`${name}（导入${i}）`)) i++;
      name = `${name}（导入${i}）`;
    }

    const safePreset = {
      name,
      createdAt: p.createdAt || nowISO(),
      updatedAt: nowISO(),
      mode: (p.mode === "json") ? "json" : "form",
      fields: {
        systemPrompt: p?.fields?.systemPrompt ?? "",
        prompt: p?.fields?.prompt ?? "",
        keepOriginalAspect: !!p?.fields?.keepOriginalAspect,
        aspectRatio: p?.fields?.aspectRatio ?? "",
        imageSize: p?.fields?.imageSize ?? "",
        temperature: p?.fields?.temperature ?? "",
        topP: p?.fields?.topP ?? "",
      },
      image: p?.image?.base64 ? {
        mimeType: p.image.mimeType || "application/octet-stream",
        base64: p.image.base64,
        name: p.image.name || "preset_image",
        size: p.image.size || p.image.base64.length,
      } : null,
      requestBodyJson: typeof p.requestBodyJson === "string" ? p.requestBodyJson : "",
    };

    merged.push(safePreset);
    nameSet.add(name);
    added++;
  }

  if (!added) {
    setStatus("导入完成：未新增任何有效预设。", true);
    return;
  }

  try {
    savePresets(merged);
  } catch (e) {
    setStatus(`导入失败：可能是本地存储空间不足（预设图片会占用较多空间）。\n${e?.message || e}`, true);
    return;
  }

  refreshPresetUI();
  setStatus(`导入完成：新增 ${added} 个预设。`, true);
  setTimeout(() => setStatus("", false), 1400);
}

// ----- run -----
async function doFetchOnce(req) {
  const t0 = performance.now();
  const resp = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: JSON.stringify(req.body),
  });

  const data = await resp.json().catch(() => ({}));
  const t1 = performance.now();

  return { resp, data, ms: (t1 - t0) };
}

async function run() {
  persistBase();
  setStatus("正在请求模型生成……", true);

  // Clear prior output
  els.resultEmpty.classList.add("hidden");
  els.result.classList.add("hidden");
  els.textOutWrap.classList.add("hidden");
  els.imagesOutWrap.classList.add("hidden");
  els.rawJson.textContent = "";
  cleanupObjectUrls();

  let req;
  try {
    req = buildRequest();
  } catch (e) {
    setStatus(e.message || String(e), true);
    return;
  }

  lastRequest = req;

  // iOS后台优化：记录可见性 + WakeLock（best-effort）
  requestInFlight = true;
  hiddenDuringRequest = false;
  await requestWakeLock();

  let didAutoRetry = false;

  try {
    while (true) {
      try {
        const { resp, data, ms } = await doFetchOnce(req);

        if (!resp.ok) {
          const msg = data?.error?.message || `HTTP ${resp.status} ${resp.statusText}`;
          setStatus(`请求失败：${msg}\n\n（提示：若你使用自定义 Host，请确认它支持该路径与鉴权方式。）`, true);
          els.resultEmpty.classList.remove("hidden");
          return;
        }

        setStatus("", false);
        await renderResult({ data, ms });
        return;
      } catch (e) {
        // 仅在“后台期间发生 + 网络类错误 + 未重试过”的情况下自动重试一次
        if (!didAutoRetry && hiddenDuringRequest && isLikelyNetworkError(e)) {
          didAutoRetry = true;
          setStatus("检测到请求过程中页面进入后台导致网络中断，正在自动重试一次……", true);
          // 重新申请 wake lock（若可用）
          if (document.visibilityState === "visible") await requestWakeLock();
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    setStatus(
      `网络或浏览器限制导致请求失败：${e?.message || e}\n\n（提示：若 iOS Safari 经常后台失败，建议尽量保持前台完成一次请求；或使用自定义 Host/反代提升可用性。）`,
      true
    );
    els.resultEmpty.classList.remove("hidden");
  } finally {
    requestInFlight = false;
    hiddenDuringRequest = false;
    releaseWakeLock();
  }
}

// ----- reset -----
function resetNonFixedFields() {
  els.systemPrompt.value = "";
  els.prompt.value = "";
  els.keepOriginalAspect.checked = false;
  els.aspectRatio.value = "";
  els.imageSize.value = "";
  els.temperature.value = "";
  els.topP.value = "";
  els.requestBodyJson.value = "";
  clearSelectedImage();

  setStatus("", false);
  els.result.classList.add("hidden");
  els.resultEmpty.classList.remove("hidden");
  updateKeepOriginalAspectState();
  persistBase();
}

// ----- wiring -----
async function handleImageFile(file) {
  if (file.size > 12 * 1024 * 1024) {
    setStatus(`图片较大（${humanBytes(file.size)}）。建议压缩后再试；保存到预设时也更容易触发存储空间不足。`, true);
  } else {
    setStatus("", false);
  }

  clearSelectedImage();
  const info = await readImageFile(file);
  selectedImage = info;
  showSelectedImage(info);
  updateKeepOriginalAspectState();

  persistBase();
}

function wireEvents() {
  // Persist on change for fixed fields & general state
  ["input", "change"].forEach((evt) => {
    els.apiHost.addEventListener(evt, persistBase);
    els.apiKey.addEventListener(evt, persistBase);
    els.rememberKey.addEventListener(evt, persistBase);
    els.useHeaderKey.addEventListener(evt, persistBase);

    els.systemPrompt.addEventListener(evt, persistBase);
    els.prompt.addEventListener(evt, persistBase);
    els.keepOriginalAspect.addEventListener(evt, persistBase);
    els.aspectRatio.addEventListener(evt, persistBase);
    els.imageSize.addEventListener(evt, persistBase);
    els.temperature.addEventListener(evt, persistBase);
    els.topP.addEventListener(evt, persistBase);

    els.requestBodyJson.addEventListener(evt, persistBase);
  });

  els.rememberKey.addEventListener("change", () => {
    if (!els.rememberKey.checked) {
      localStorage.removeItem(storageKeys.apiKey);
    } else {
      localStorage.setItem(storageKeys.apiKey, els.apiKey.value);
    }
  });

  els.apiKey.addEventListener("input", () => {
    if (els.rememberKey.checked) localStorage.setItem(storageKeys.apiKey, els.apiKey.value);
  });

  els.keepOriginalAspect.addEventListener("change", () => {
    updateKeepOriginalAspectState();
    persistBase();
  });

  // mode switch
  els.modeForm.addEventListener("click", () => setMode("form"));
  els.modeJson.addEventListener("click", () => setMode("json"));

  // json tools
  els.jsonFormat.addEventListener("click", formatJsonEditor);
  els.jsonFromForm.addEventListener("click", syncJsonFromForm);
  els.jsonToForm.addEventListener("click", applyJsonToFormBestEffort);

  // Drag & drop
  const onDrag = (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.style.borderColor = "rgba(140, 160, 255, 0.45)";
  };
  const onLeave = (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.dropZone.style.borderColor = "rgba(255,255,255,0.2)";
  };
  els.dropZone.addEventListener("dragenter", onDrag);
  els.dropZone.addEventListener("dragover", onDrag);
  els.dropZone.addEventListener("dragleave", onLeave);
  els.dropZone.addEventListener("drop", async (e) => {
    onLeave(e);
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    await handleImageFile(f);
  });

  els.imageFile.addEventListener("change", async () => {
    const f = els.imageFile.files?.[0];
    if (!f) return;
    await handleImageFile(f);
  });

  els.clearImage.addEventListener("click", () => {
    clearSelectedImage();
    updateKeepOriginalAspectState();
    persistBase();
  });

  // run
  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    els.runBtn.disabled = true;
    try {
      await run();
    } finally {
      els.runBtn.disabled = false;
    }
  });

  // reset
  els.resetBtn.addEventListener("click", resetNonFixedFields);

  // copy
  els.copyCurl.addEventListener("click", async () => {
    if (!lastRequest) return;
    const curl = makeCurl(lastRequest);
    await navigator.clipboard.writeText(curl);
    setStatus("已复制 cURL 到剪贴板。", true);
    setTimeout(() => setStatus("", false), 1200);
  });

  els.copyJson.addEventListener("click", async () => {
    if (!lastRequest) return;
    const json = JSON.stringify(lastRequest.body, null, 2);
    await navigator.clipboard.writeText(json);
    setStatus("已复制请求 JSON 到剪贴板。", true);
    setTimeout(() => setStatus("", false), 1200);
  });

  // presets
  els.presetSelect.addEventListener("change", async () => {
    const name = els.presetSelect.value || "";
    if (!name) {
      localStorage.removeItem(storageKeys.activePreset);
      refreshPresetUI();
      return;
    }
    localStorage.setItem(storageKeys.activePreset, name);
    const presets = loadPresets();
    const p = presets.find(x => x.name === name);
    if (p) await applyPreset(p);
    refreshPresetUI();
  });

  els.presetSave.addEventListener("click", saveAsPreset);
  els.presetUpdate.addEventListener("click", updateActivePreset);
  els.presetDelete.addEventListener("click", deleteActivePreset);
  els.presetExport.addEventListener("click", exportPresets);

  els.presetImport.addEventListener("change", async () => {
    const f = els.presetImport.files?.[0];
    els.presetImport.value = "";
    await importPresetsFromFile(f);
  });

  // iOS background detection
  document.addEventListener("visibilitychange", async () => {
    if (requestInFlight && document.visibilityState === "hidden") {
      hiddenDuringRequest = true;
    }
    if (requestInFlight && document.visibilityState === "visible") {
      // reacquire wake lock best-effort
      await requestWakeLock();
    }
  });
}

// ----- init -----
async function init() {
  restoreBase();
  wireEvents();

  updateKeepOriginalAspectState();

  // ensure mode is applied
  setMode(uiMode === "json" ? "json" : "form");

  // presets ui
  refreshPresetUI();
  const activeName = localStorage.getItem(storageKeys.activePreset) || "";
  if (activeName) {
    const presets = loadPresets();
    const p = presets.find(x => x.name === activeName);
    if (p) await applyPreset(p);
  }
}

init();
