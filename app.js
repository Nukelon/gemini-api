const MODEL_ID = "gemini-3-pro-image-preview";
const DEFAULT_HOST = "https://generativelanguage.googleapis.com";
const API_PATH = `/v1beta/models/${MODEL_ID}:generateContent`;

const $ = (id) => document.getElementById(id);

// ---------- safe localStorage ----------
function safeSetItem(k, v) {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}
function safeGetItem(k, fallback = "") {
  try {
    const v = localStorage.getItem(k);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}
function safeRemoveItem(k) {
  try { localStorage.removeItem(k); } catch { /* ignore */ }
}

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
  const name = String(err?.name || "");
  const msg = String(err?.message || "");
  if (name === "TypeError") return true;
  if (/network/i.test(msg)) return true;
  if (/load failed/i.test(msg)) return true; // Safari
  return false;
}

// ---------- DOM ----------
const els = {
  form: $("form"),

  apiHost: $("apiHost"),
  apiKey: $("apiKey"),
  rememberKey: $("rememberKey"),
  useHeaderKey: $("useHeaderKey"),

  modeForm: $("modeForm"),
  modeJson: $("modeJson"),
  formModeWrap: $("formModeWrap"),
  jsonModeWrap: $("jsonModeWrap"),

  systemPrompt: $("systemPrompt"),
  prompt: $("prompt"),
  imageFile: $("imageFile"),
  dropZone: $("dropZone"),
  imagePreview: $("imagePreview"),
  imagePreviewList: $("imagePreviewList"),
  imageMeta: $("imageMeta"),
  clearImages: $("clearImages"),
  aspectRatio: $("aspectRatio"),
  imageSize: $("imageSize"),
  temperature: $("temperature"),
  topP: $("topP"),

  requestBodyJson: $("requestBodyJson"),
  jsonFormat: $("jsonFormat"),
  jsonFromForm: $("jsonFromForm"),
  jsonToForm: $("jsonToForm"),

  presetSelect: $("presetSelect"),
  presetSave: $("presetSave"),
  presetUpdate: $("presetUpdate"),
  presetDelete: $("presetDelete"),
  presetExport: $("presetExport"),
  presetImport: $("presetImport"),

  runBtn: $("runBtn"),
  resetBtn: $("resetBtn"),
  status: $("status"),

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

const storageKeys = {
  host: "g3_host",
  rememberKey: "g3_remember_key",
  apiKey: "g3_api_key",
  useHeaderKey: "g3_use_header_key",

  uiMode: "g3_ui_mode",

  // last used values (non-preset)
  systemPrompt: "g3_system_prompt",
  prompt: "g3_prompt",
  aspectRatio: "g3_aspect_ratio",
  imageSize: "g3_image_size",
  temperature: "g3_temperature",
  topP: "g3_topP",

  // IMPORTANT: do NOT persist huge JSON; store only if small
  requestBodyJsonSmall: "g3_request_body_json_small",

  // presets (no images)
  presets: "g3_presets_v1",
  activePreset: "g3_active_preset_name",
};

// ---------- state ----------
let uiMode = "form"; // "form" | "json"
let selectedImages = []; // [{id, mimeType, base64, size, name, dataUrl}]
let lastRequest = null;
let objectUrls = [];

let requestInFlight = false;
let hiddenDuringRequest = false;
let wakeLock = null;

// ---------- status ----------
function setStatus(msg, visible = true) {
  els.status.textContent = msg || "";
  els.status.classList.toggle("hidden", !visible);
}

// ---------- wake lock ----------
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

// ---------- image handling (multi) ----------
function resetFileInputValue() {
  // iOS Safari 对同一文件再次选择可能不触发 change；重置 value 更稳
  try { els.imageFile.value = ""; } catch {}
}

async function readImageFile(file) {
  const mimeType = file.type || "application/octet-stream";
  const size = file.size;
  const name = file.name || "image";
  const arrayBuf = await file.arrayBuffer();
  const base64 = base64FromArrayBuffer(arrayBuf);
  const dataUrl = URL.createObjectURL(file); // preview only
  return { mimeType, size, name, base64, dataUrl };
}

function clearAllImages() {
  for (const img of selectedImages) {
    try { URL.revokeObjectURL(img.dataUrl); } catch {}
  }
  selectedImages = [];
  renderImagePreview();
  resetFileInputValue();
}

function removeImageById(id) {
  const idx = selectedImages.findIndex(x => x.id === id);
  if (idx < 0) return;
  const [img] = selectedImages.splice(idx, 1);
  try { URL.revokeObjectURL(img.dataUrl); } catch {}
  renderImagePreview();
}

function renderImagePreview() {
  const count = selectedImages.length;
  if (!count) {
    els.imagePreview.classList.add("hidden");
    els.imagePreviewList.innerHTML = "";
    els.imageMeta.textContent = "";
    return;
  }

  const total = selectedImages.reduce((s, x) => s + (x.size || 0), 0);
  els.imagePreview.classList.remove("hidden");
  els.imageMeta.textContent = `已选 ${count} 张 · 合计约 ${humanBytes(total)}（仅当前页面内存，不会写入预设/本地存储）`;

  els.imagePreviewList.innerHTML = "";
  for (const img of selectedImages) {
    const card = document.createElement("div");
    card.className = "thumb";

    const im = document.createElement("img");
    im.src = img.dataUrl;
    im.alt = img.name;

    const bar = document.createElement("div");
    bar.className = "tbar";

    const name = document.createElement("div");
    name.className = "tname";
    name.textContent = img.name;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tbtn";
    btn.textContent = "移除";
    btn.addEventListener("click", () => removeImageById(img.id));

    bar.appendChild(name);
    bar.appendChild(btn);

    card.appendChild(im);
    card.appendChild(bar);

    els.imagePreviewList.appendChild(card);
  }
}

async function addImagesFromFileList(fileList) {
  const files = Array.from(fileList || []).filter(Boolean);
  if (!files.length) return;

  // 简单防抖：避免一次性塞太多导致移动端卡顿
  if (files.length > 12) {
    setStatus("一次选择图片过多（>12）。建议分批添加。", true);
  }

  for (const f of files) {
    // 可按需限制大小
    const info = await readImageFile(f);
    selectedImages.push({
      id: `${Date.now()}_${Math.random().toString(16).slice(2)}`,
      ...info,
    });
  }

  // 只在内存中维护，不写 localStorage
  renderImagePreview();
  resetFileInputValue();
}

// ---------- build body ----------
function buildBodyFromForm() {
  const systemPrompt = els.systemPrompt.value.trim();
  const promptText = (els.prompt.value ?? "").trim(); // 可空
  const aspectRatio = els.aspectRatio.value;
  const imageSize = els.imageSize.value;

  const temperature = safeNumberOrEmpty(els.temperature.value);
  const topP = safeNumberOrEmpty(els.topP.value);

  // 关键：提示词不填也要传一个空文本 part
  const parts = [{ text: promptText || "" }];

  // 多图：依次追加 inline_data parts
  for (const img of selectedImages) {
    parts.push({
      inline_data: {
        mime_type: img.mimeType,
        data: img.base64,
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

  if (systemPrompt) {
    body.systemInstruction = { parts: [{ text: systemPrompt }] };
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

function buildRequest() {
  const host = stripTrailingSlash(els.apiHost.value.trim() || DEFAULT_HOST);
  const apiKey = els.apiKey.value.trim();
  const useHeaderKey = els.useHeaderKey.checked;

  if (!apiKey) throw new Error("请填写 API Key。");

  const url = useHeaderKey
    ? `${host}${API_PATH}`
    : `${host}${API_PATH}?key=${encodeURIComponent(apiKey)}`;

  let body;
  if (uiMode === "json") {
    const raw = (els.requestBodyJson.value || "").trim();
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

// ---------- render output ----------
function cleanupObjectUrls() {
  for (const u of objectUrls) URL.revokeObjectURL(u);
  objectUrls = [];
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
function timestampTag() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function renderResult({ data, ms }) {
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

    images.forEach((img, idx) => {
      const { url } = b64ToBlobUrl(img.b64, img.mimeType);
      const ext =
        img.mimeType.includes("png") ? "png" :
        img.mimeType.includes("jpeg") ? "jpg" :
        img.mimeType.includes("webp") ? "webp" : "bin";

      const filename = `gemini3_image_${tag}_${String(idx + 1).padStart(2, "0")}.${ext}`;

      const card = document.createElement("div");
      card.className = "imgcard";

      const imageEl = document.createElement("img");
      imageEl.src = url;
      imageEl.alt = `生成图片 ${idx + 1}`;

      const bar = document.createElement("div");
      bar.className = "bar";

      const left = document.createElement("div");
      left.textContent = `${img.mimeType || "image"} · ${filename}`;
      left.style.color = "rgba(233,237,245,0.85)";
      left.style.fontSize = "12px";

      const right = document.createElement("div");
      right.style.display = "flex";
      right.style.gap = "12px";
      right.style.flexWrap = "wrap";
      right.style.alignItems = "center";

      const openA = document.createElement("a");
      openA.className = "link";
      openA.href = url;
      openA.target = "_blank";
      openA.rel = "noopener";
      openA.textContent = "打开原图";

      const dlA = document.createElement("a");
      dlA.className = "link";
      dlA.href = url;
      dlA.download = filename;
      dlA.textContent = "下载";

      right.appendChild(openA);
      right.appendChild(dlA);

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

// ---------- persistence (NO images) ----------
function persistBase() {
  safeSetItem(storageKeys.host, els.apiHost.value.trim());
  safeSetItem(storageKeys.rememberKey, String(els.rememberKey.checked));
  safeSetItem(storageKeys.useHeaderKey, String(els.useHeaderKey.checked));
  safeSetItem(storageKeys.uiMode, uiMode);

  // last used form values
  safeSetItem(storageKeys.systemPrompt, els.systemPrompt.value);
  safeSetItem(storageKeys.prompt, els.prompt.value);
  safeSetItem(storageKeys.aspectRatio, els.aspectRatio.value);
  safeSetItem(storageKeys.imageSize, els.imageSize.value);
  safeSetItem(storageKeys.temperature, els.temperature.value);
  safeSetItem(storageKeys.topP, els.topP.value);

  // request body: only store if small (avoid quota + “参数丢失”连锁)
  const raw = (els.requestBodyJson.value || "");
  if (raw.length <= 20000) {
    safeSetItem(storageKeys.requestBodyJsonSmall, raw);
  } else {
    // 太大就不存
    safeRemoveItem(storageKeys.requestBodyJsonSmall);
  }

  if (els.rememberKey.checked) {
    safeSetItem(storageKeys.apiKey, els.apiKey.value);
  } else {
    safeRemoveItem(storageKeys.apiKey);
  }
}

function restoreBase() {
  els.apiHost.value = safeGetItem(storageKeys.host, "");
  els.rememberKey.checked = safeGetItem(storageKeys.rememberKey, "false") === "true";
  els.useHeaderKey.checked = safeGetItem(storageKeys.useHeaderKey, "false") === "true";
  uiMode = safeGetItem(storageKeys.uiMode, "form");

  els.systemPrompt.value = safeGetItem(storageKeys.systemPrompt, "");
  els.prompt.value = safeGetItem(storageKeys.prompt, "");
  els.aspectRatio.value = safeGetItem(storageKeys.aspectRatio, "");
  els.imageSize.value = safeGetItem(storageKeys.imageSize, "");
  els.temperature.value = safeGetItem(storageKeys.temperature, "");
  els.topP.value = safeGetItem(storageKeys.topP, "");

  els.requestBodyJson.value = safeGetItem(storageKeys.requestBodyJsonSmall, "");

  const savedKey = safeGetItem(storageKeys.apiKey, "");
  if (els.rememberKey.checked && savedKey) {
    els.apiKey.value = savedKey;
  }
}

// ---------- mode switching ----------
function setMode(mode) {
  uiMode = mode;
  els.modeForm.classList.toggle("active", mode === "form");
  els.modeJson.classList.toggle("active", mode === "json");
  els.modeForm.setAttribute("aria-selected", String(mode === "form"));
  els.modeJson.setAttribute("aria-selected", String(mode === "json"));

  els.formModeWrap.classList.toggle("hidden", mode !== "form");
  els.jsonModeWrap.classList.toggle("hidden", mode !== "json");

  if (mode === "json") {
    // 默认从表单生成（包含多图）到 JSON 编辑器，但不强制（表单再空也能生成，因为 prompt 可空）
    try {
      const body = buildBodyFromForm();
      els.requestBodyJson.value = JSON.stringify(body, null, 2);
      setStatus("", false);
    } catch (e) {
      setStatus(`切换到 JSON 模式：${e?.message || e}`, true);
    }
  }

  persistBase();
}

function formatJsonEditor() {
  const raw = (els.requestBodyJson.value || "").trim();
  if (!raw) { setStatus("JSON 为空。", true); return; }
  try {
    const obj = JSON.parse(raw);
    els.requestBodyJson.value = JSON.stringify(obj, null, 2);
    setStatus("已格式化 JSON。", true);
    setTimeout(() => setStatus("", false), 900);
  } catch (e) {
    setStatus(`JSON 解析失败：${e?.message || e}`, true);
  }
}

function syncJsonFromForm() {
  try {
    const body = buildBodyFromForm();
    els.requestBodyJson.value = JSON.stringify(body, null, 2);
    setStatus("已从表单同步生成 JSON（包含当前已上传图片）。", true);
    setTimeout(() => setStatus("", false), 1100);
    persistBase();
  } catch (e) {
    setStatus(e?.message || String(e), true);
  }
}

function applyJsonToFormBestEffort() {
  const raw = (els.requestBodyJson.value || "").trim();
  if (!raw) { setStatus("JSON 为空，无法回填。", true); return; }

  let obj;
  try { obj = JSON.parse(raw); }
  catch (e) { setStatus(`JSON 解析失败：${e?.message || e}`, true); return; }

  // system prompt
  const sp = obj?.systemInstruction?.parts?.[0]?.text;
  if (typeof sp === "string") els.systemPrompt.value = sp;

  // prompt (first text part if exists)
  const parts = obj?.contents?.[0]?.parts || [];
  const firstText = parts.find(p => typeof p?.text === "string")?.text;
  if (typeof firstText === "string") els.prompt.value = firstText;

  // NOTE: 不从 JSON 回填图片（避免把大 base64 再引入状态/存储；也符合“预设不存图片”的方向）
  setStatus("已回填文本/参数到表单；图片不会从 JSON 回填，请用上传区重新添加。", true);
  setTimeout(() => setStatus("", false), 1400);
  persistBase();
}

// ---------- presets (NO images) ----------
function loadPresets() {
  try {
    const raw = safeGetItem(storageKeys.presets, "");
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
function savePresets(arr) {
  safeSetItem(storageKeys.presets, JSON.stringify(arr));
}

function refreshPresetUI() {
  const presets = loadPresets();
  const activeName = safeGetItem(storageKeys.activePreset, "");

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

function sanitizeRequestBodyJsonNoImages(raw) {
  // 预设不保存图片：若 JSON 可解析，则删除 inline_data/inlineData parts
  // 这样预设在 JSON 模式下仍可用（无图版本）
  if (!raw || raw.length > 200000) return ""; // 太大就不存
  try {
    const obj = JSON.parse(raw);
    const contents = obj?.contents;
    if (Array.isArray(contents)) {
      for (const c of contents) {
        if (!Array.isArray(c?.parts)) continue;
        c.parts = c.parts.filter(p => {
          const inline = p?.inline_data || p?.inlineData;
          return !(inline && inline.data);
        });
      }
    }
    return JSON.stringify(obj, null, 2);
  } catch {
    return ""; // 解析不了就不存
  }
}

function makePresetFromCurrentState() {
  return {
    name: "",
    createdAt: nowISO(),
    updatedAt: nowISO(),
    mode: uiMode,
    fields: {
      systemPrompt: els.systemPrompt.value,
      prompt: els.prompt.value,
      aspectRatio: els.aspectRatio.value,
      imageSize: els.imageSize.value,
      temperature: els.temperature.value,
      topP: els.topP.value,
    },
    // 不保存图片
    requestBodyJson: sanitizeRequestBodyJsonNoImages(els.requestBodyJson.value),
  };
}

function applyPreset(preset) {
  // 不触碰 host/key；也不触碰当前已上传图片
  setMode(preset.mode === "json" ? "json" : "form");

  const f = preset.fields || {};
  els.systemPrompt.value = f.systemPrompt ?? "";
  els.prompt.value = f.prompt ?? "";
  els.aspectRatio.value = f.aspectRatio ?? "";
  els.imageSize.value = f.imageSize ?? "";
  els.temperature.value = f.temperature ?? "";
  els.topP.value = f.topP ?? "";

  if (typeof preset.requestBodyJson === "string" && preset.requestBodyJson.trim()) {
    els.requestBodyJson.value = preset.requestBodyJson;
  }

  persistBase();
  setStatus(`已应用预设：${preset.name}\n（Host / Key 不变；图片不会随预设变化）`, true);
  setTimeout(() => setStatus("", false), 1400);
}

function saveAsPreset() {
  const name = (prompt("请输入预设名称（预设不保存图片；Host/Key 也不保存）：") || "").trim();
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
    presets[presets.findIndex(p => p.name === name)] = next;
  } else {
    const next = makePresetFromCurrentState();
    next.name = name;
    presets.push(next);
  }

  savePresets(presets);
  safeSetItem(storageKeys.activePreset, name);
  refreshPresetUI();
  setStatus(`已保存预设：${name}\n（未保存图片）`, true);
  setTimeout(() => setStatus("", false), 1200);
}

function updateActivePreset() {
  const name = els.presetSelect.value || safeGetItem(storageKeys.activePreset, "");
  if (!name) return;

  const presets = loadPresets();
  const idx = presets.findIndex(p => p.name === name);
  if (idx < 0) return;

  const ok = confirm(`确认更新预设“${name}”？（不会保存图片）`);
  if (!ok) return;

  const existing = presets[idx];
  const next = makePresetFromCurrentState();
  next.name = name;
  next.createdAt = existing.createdAt || nowISO();
  next.updatedAt = nowISO();
  presets[idx] = next;

  savePresets(presets);
  safeSetItem(storageKeys.activePreset, name);
  refreshPresetUI();
  setStatus(`已更新预设：${name}`, true);
  setTimeout(() => setStatus("", false), 1200);
}

function deleteActivePreset() {
  const name = els.presetSelect.value || safeGetItem(storageKeys.activePreset, "");
  if (!name) return;

  const ok = confirm(`确认删除预设“${name}”？该操作不可撤销。`);
  if (!ok) return;

  const presets = loadPresets().filter(p => p.name !== name);
  savePresets(presets);
  safeRemoveItem(storageKeys.activePreset);
  refreshPresetUI();
  setStatus(`已删除预设：${name}`, true);
  setTimeout(() => setStatus("", false), 1200);
}

function exportPresets() {
  const presets = loadPresets();
  const payload = { version: 1, exportedAt: nowISO(), presets };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `gemini3_presets_${timestampTag()}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();

  setTimeout(() => URL.revokeObjectURL(url), 5000);
  setStatus(`已导出预设：${presets.length} 个（不含图片）`, true);
  setTimeout(() => setStatus("", false), 1200);
}

async function importPresetsFromFile(file) {
  if (!file) return;
  let text = "";
  try { text = await file.text(); }
  catch (e) { setStatus(`读取导入文件失败：${e?.message || e}`, true); return; }

  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { setStatus(`导入失败：JSON 解析错误：${e?.message || e}`, true); return; }

  const incoming = Array.isArray(obj?.presets) ? obj.presets : (Array.isArray(obj) ? obj : []);
  if (!incoming.length) { setStatus("导入失败：未发现 presets 数组。", true); return; }

  const existing = loadPresets();
  const nameSet = new Set(existing.map(p => p.name));
  const merged = [...existing];
  let added = 0;

  for (const p of incoming) {
    if (!p?.name) continue;
    let name = String(p.name).trim();
    if (!name) continue;

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
        aspectRatio: p?.fields?.aspectRatio ?? "",
        imageSize: p?.fields?.imageSize ?? "",
        temperature: p?.fields?.temperature ?? "",
        topP: p?.fields?.topP ?? "",
      },
      requestBodyJson: sanitizeRequestBodyJsonNoImages(p?.requestBodyJson || ""),
    };

    merged.push(safePreset);
    nameSet.add(name);
    added++;
  }

  savePresets(merged);
  refreshPresetUI();
  setStatus(`导入完成：新增 ${added} 个预设（不含图片）。`, true);
  setTimeout(() => setStatus("", false), 1400);
}

// ---------- run ----------
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

  // clear previous output
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
          setStatus(`请求失败：${msg}`, true);
          els.resultEmpty.classList.remove("hidden");
          return;
        }

        setStatus("", false);
        renderResult({ data, ms });
        return;
      } catch (e) {
        if (!didAutoRetry && hiddenDuringRequest && isLikelyNetworkError(e)) {
          didAutoRetry = true;
          setStatus("检测到请求过程中页面进入后台导致网络中断，正在自动重试一次……", true);
          if (document.visibilityState === "visible") await requestWakeLock();
          continue;
        }
        throw e;
      }
    }
  } catch (e) {
    setStatus(`网络或浏览器限制导致请求失败：${e?.message || e}`, true);
    els.resultEmpty.classList.remove("hidden");
  } finally {
    requestInFlight = false;
    hiddenDuringRequest = false;
    releaseWakeLock();
  }
}

// ---------- reset ----------
function resetNonFixedFields() {
  els.systemPrompt.value = "";
  els.prompt.value = "";
  els.aspectRatio.value = "";
  els.imageSize.value = "";
  els.temperature.value = "";
  els.topP.value = "";
  els.requestBodyJson.value = "";
  clearAllImages();

  setStatus("", false);
  els.result.classList.add("hidden");
  els.resultEmpty.classList.remove("hidden");
  persistBase();
}

// ---------- wiring ----------
function wireEvents() {
  // persist on change (non-image)
  ["input", "change"].forEach((evt) => {
    els.apiHost.addEventListener(evt, persistBase);
    els.apiKey.addEventListener(evt, persistBase);
    els.rememberKey.addEventListener(evt, persistBase);
    els.useHeaderKey.addEventListener(evt, persistBase);

    els.systemPrompt.addEventListener(evt, persistBase);
    els.prompt.addEventListener(evt, persistBase);
    els.aspectRatio.addEventListener(evt, persistBase);
    els.imageSize.addEventListener(evt, persistBase);
    els.temperature.addEventListener(evt, persistBase);
    els.topP.addEventListener(evt, persistBase);

    els.requestBodyJson.addEventListener(evt, persistBase);
  });

  els.rememberKey.addEventListener("change", () => {
    if (!els.rememberKey.checked) safeRemoveItem(storageKeys.apiKey);
    else safeSetItem(storageKeys.apiKey, els.apiKey.value);
  });

  els.apiKey.addEventListener("input", () => {
    if (els.rememberKey.checked) safeSetItem(storageKeys.apiKey, els.apiKey.value);
  });

  // mode switch
  els.modeForm.addEventListener("click", () => setMode("form"));
  els.modeJson.addEventListener("click", () => setMode("json"));

  // json tools
  els.jsonFormat.addEventListener("click", formatJsonEditor);
  els.jsonFromForm.addEventListener("click", syncJsonFromForm);
  els.jsonToForm.addEventListener("click", applyJsonToFormBestEffort);

  // image input
  els.imageFile.addEventListener("change", async () => {
    const files = els.imageFile.files;
    await addImagesFromFileList(files);
  });

  // drag & drop
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
    const files = e.dataTransfer?.files;
    await addImagesFromFileList(files);
  });

  els.clearImages.addEventListener("click", () => clearAllImages());

  // submit (avoid refresh)
  els.form.addEventListener("submit", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    els.runBtn.disabled = true;
    try {
      await run();
    } finally {
      els.runBtn.disabled = false;
    }
  });

  els.resetBtn.addEventListener("click", resetNonFixedFields);

  els.copyCurl.addEventListener("click", async () => {
    if (!lastRequest) return;
    await navigator.clipboard.writeText(makeCurl(lastRequest));
    setStatus("已复制 cURL 到剪贴板。", true);
    setTimeout(() => setStatus("", false), 1100);
  });

  els.copyJson.addEventListener("click", async () => {
    if (!lastRequest) return;
    await navigator.clipboard.writeText(JSON.stringify(lastRequest.body, null, 2));
    setStatus("已复制请求 JSON 到剪贴板。", true);
    setTimeout(() => setStatus("", false), 1100);
  });

  // presets
  els.presetSelect.addEventListener("change", () => {
    const name = els.presetSelect.value || "";
    if (!name) {
      safeRemoveItem(storageKeys.activePreset);
      refreshPresetUI();
      return;
    }
    safeSetItem(storageKeys.activePreset, name);
    const presets = loadPresets();
    const p = presets.find(x => x.name === name);
    if (p) applyPreset(p);
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
    if (requestInFlight && document.visibilityState === "hidden") hiddenDuringRequest = true;
    if (requestInFlight && document.visibilityState === "visible") await requestWakeLock();
  });
}

// ---------- init ----------
function init() {
  restoreBase();
  wireEvents();
  setMode(uiMode === "json" ? "json" : "form");
  refreshPresetUI();

  const activeName = safeGetItem(storageKeys.activePreset, "");
  if (activeName) {
    const presets = loadPresets();
    const p = presets.find(x => x.name === activeName);
    if (p) applyPreset(p);
  }

  renderImagePreview();
}
init();