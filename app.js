(function () {
  var MODEL_ID = "gemini-3-pro-image-preview";
  var DEFAULT_HOST = "https://generativelanguage.googleapis.com";
  var API_PATH = "/v1beta/models/" + MODEL_ID + ":generateContent";

  function $(id) { return document.getElementById(id); }

  function stripTrailingSlash(s) { return String(s || "").replace(/\/+$/, ""); }

  function safeNumberOrEmpty(v) {
    var t = String(v == null ? "" : v).trim();
    if (!t) return "";
    var n = Number(t);
    return isFinite(n) ? n : "";
  }

  function humanBytes(bytes) {
    var units = ["B", "KB", "MB", "GB"];
    var v = bytes;
    var i = 0;
    while (v >= 1024 && i < units.length - 1) { v = v / 1024; i++; }
    var fixed = (v >= 10 || i === 0) ? 0 : 1;
    return v.toFixed(fixed) + " " + units[i];
  }

  function base64FromArrayBuffer(buf) {
    var bytes = new Uint8Array(buf);
    var binary = "";
    var chunkSize = 0x8000;
    for (var i = 0; i < bytes.length; i += chunkSize) {
      var chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function parseBase64FromDataUrl(dataUrl) {
    // data:[mime];base64,xxxxx
    var comma = dataUrl.indexOf(",");
    if (comma < 0) return "";
    return dataUrl.slice(comma + 1);
  }

  function parseMimeFromDataUrl(dataUrl) {
    // data:image/png;base64,....
    var m = /^data:([^;]+);base64,/.exec(dataUrl);
    return m && m[1] ? m[1] : "application/octet-stream";
  }

  function nowISO() { return (new Date()).toISOString(); }

  function isLikelyNetworkError(err) {
    var name = err && err.name ? String(err.name) : "";
    var msg = err && err.message ? String(err.message) : "";
    if (name === "TypeError") return true;
    if (/network/i.test(msg)) return true;
    if (/load failed/i.test(msg)) return true;
    return false;
  }

  function timestampTag() {
    var d = new Date();
    function pad(n) { n = String(n); return n.length >= 2 ? n : ("0" + n); }
    return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) +
      "_" + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function copyTextToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text);
    }

    return new Promise(function (resolve, reject) {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.top = "-9999px";
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        var ok = document.execCommand("copy");
        ta.remove();
        ok ? resolve() : reject(new Error("copy failed"));
      } catch (e) {
        reject(e);
      }
    });
  }

  var els = {
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
    imageMeta: $("imageMeta"),
    imagePreviewGrid: $("imagePreviewGrid"),
    clearImage: $("clearImage"),

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
    rawJson: $("rawJson")
  };

  if (!els.form || !els.runBtn) {
    alert("页面元素未找到：请确认 index.html 与 app.js 为同一版本，且已放在同一目录。");
    return;
  }

  var storageKeys = {
    host: "g3_host",
    rememberKey: "g3_remember_key",
    apiKey: "g3_api_key",
    useHeaderKey: "g3_use_header_key",

    uiMode: "g3_ui_mode",
    requestBodyJson: "g3_request_body_json",

    systemPrompt: "g3_system_prompt",
    prompt: "g3_prompt",
    aspectRatio: "g3_aspect_ratio",
    imageSize: "g3_image_size",
    temperature: "g3_temperature",
    topP: "g3_topP",

    presets: "g3_presets_v1",
    activePreset: "g3_active_preset_name"
  };

  var uiMode = "form";
  var selectedImages = []; // {mimeType,size,name,base64,dataUrl,previewKind}
  var lastRequest = null;
  var objectUrls = [];

  var requestInFlight = false;
  var hiddenDuringRequest = false;
  var wakeLock = null;

  function setStatus(msg, visible) {
    if (visible === undefined) visible = true;
    els.status.textContent = msg || "";
    if (visible) els.status.classList.remove("hidden");
    else els.status.classList.add("hidden");
  }

  function requestWakeLock() {
    return new Promise(function (resolve) {
      try {
        if (!navigator.wakeLock || !navigator.wakeLock.request) return resolve();
        if (wakeLock) return resolve();
        navigator.wakeLock.request("screen").then(function (wl) {
          wakeLock = wl;
          try {
            wakeLock.addEventListener("release", function () { wakeLock = null; });
          } catch (_) {}
          resolve();
        }).catch(function () { resolve(); });
      } catch (_) { resolve(); }
    });
  }

  function releaseWakeLock() {
    try { if (wakeLock && wakeLock.release) wakeLock.release(); } catch (_) {}
    wakeLock = null;
  }

  function revokeInputPreview(url, kind) {
    // Only revoke blob: URLs
    try {
      if (kind === "blob" && url) URL.revokeObjectURL(url);
    } catch (_) {}
  }

  function readImageFile(file) {
    // Return: { mimeType, size, name, base64, dataUrl, previewKind }
    var mimeType0 = file && file.type ? file.type : "application/octet-stream";
    var size0 = file && file.size ? file.size : 0;
    var name0 = file && file.name ? file.name : "image";

    // Prefer object URL for preview if possible
    var previewUrl = "";
    var previewKind = "";

    try {
      if (URL && URL.createObjectURL) {
        previewUrl = URL.createObjectURL(file);
        previewKind = "blob";
      }
    } catch (_) {
      previewUrl = "";
      previewKind = "";
    }

    // 1) Try arrayBuffer (modern)
    if (file && typeof file.arrayBuffer === "function") {
      return file.arrayBuffer().then(function (buf) {
        var base64 = base64FromArrayBuffer(buf);
        return {
          mimeType: mimeType0,
          size: size0,
          name: name0,
          base64: base64,
          dataUrl: previewUrl,
          previewKind: previewKind
        };
      }).catch(function () {
        // fallthrough to FileReader
        return readImageFileByFileReader(file, mimeType0, size0, name0, previewUrl, previewKind);
      });
    }

    // 2) Fallback
    return readImageFileByFileReader(file, mimeType0, size0, name0, previewUrl, previewKind);
  }

  function readImageFileByFileReader(file, mimeType0, size0, name0, previewUrl, previewKind) {
    return new Promise(function (resolve, reject) {
      try {
        if (!window.FileReader) {
          reject(new Error("当前浏览器不支持 FileReader，无法读取图片。"));
          return;
        }

        var fr = new FileReader();
        fr.onerror = function () {
          reject(new Error("FileReader 读取失败"));
        };
        fr.onload = function () {
          try {
            var dataUrl = String(fr.result || "");
            var base64 = parseBase64FromDataUrl(dataUrl);
            var mimeType = mimeType0;
            if (!mimeType || mimeType === "application/octet-stream") {
              mimeType = parseMimeFromDataUrl(dataUrl) || mimeType0;
            }

            // If we failed to create a blob preview URL, use data URL as preview.
            var outPreviewUrl = previewUrl;
            var outPreviewKind = previewKind;
            if (!outPreviewUrl) {
              outPreviewUrl = dataUrl;
              outPreviewKind = "data";
            }

            resolve({
              mimeType: mimeType,
              size: size0,
              name: name0,
              base64: base64,
              dataUrl: outPreviewUrl,
              previewKind: outPreviewKind
            });
          } catch (e) {
            reject(e);
          }
        };

        fr.readAsDataURL(file);
      } catch (e) {
        reject(e);
      }
    });
  }

  function clearAllImages() {
    for (var i = 0; i < selectedImages.length; i++) {
      revokeInputPreview(selectedImages[i].dataUrl, selectedImages[i].previewKind);
    }
    selectedImages = [];
    if (els.imageFile) els.imageFile.value = "";
    renderInputGallery();
  }

  function removeImageAt(idx) {
    var img = selectedImages[idx];
    if (!img) return;
    revokeInputPreview(img.dataUrl, img.previewKind);
    selectedImages.splice(idx, 1);
    renderInputGallery();
  }

  function renderInputGallery() {
    var n = selectedImages.length;
    els.imageMeta.textContent = n ? ("已选择 " + n + " 张图片") : "";
    els.imagePreviewGrid.innerHTML = "";

    if (!n) {
      els.imagePreview.classList.add("hidden");
      persistBase();
      return;
    }

    els.imagePreview.classList.remove("hidden");

    selectedImages.forEach(function (img, idx) {
      var item = document.createElement("div");
      item.className = "inpitem";

      var im = document.createElement("img");
      im.src = img.dataUrl;
      im.alt = "输入图片 " + (idx + 1);

      var bar = document.createElement("div");
      bar.className = "inpbar";

      var label = document.createElement("div");
      label.className = "inplabel";
      label.title = (img.name || "") + " · " + humanBytes(img.size) + " · " + img.mimeType;
      label.textContent = img.name || ("image_" + (idx + 1));

      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "inprm";
      rm.textContent = "移除";
      rm.addEventListener("click", function () { removeImageAt(idx); });

      bar.appendChild(label);
      bar.appendChild(rm);

      item.appendChild(im);
      item.appendChild(bar);

      els.imagePreviewGrid.appendChild(item);
    });

    persistBase();
  }

  function addImagesFromFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []).filter(function (f) { return !!f; });
    if (!files.length) return Promise.resolve();

    // Sequential append for stability + better error attribution.
    var p = Promise.resolve();

    files.forEach(function (f, idx) {
      p = p.then(function () {
        setStatus("正在读取图片：" + (f.name || ("image_" + (idx + 1))) + " …", true);

        return readImageFile(f).then(function (info) {
          if (!info || !info.base64) {
            throw new Error("读取图片成功但未获得 base64 数据。");
          }
          selectedImages.push(info);
        }).catch(function (e) {
          // Do not fail the whole batch; report per-file error.
          setStatus("图片读取失败：" + (f.name || "(unknown)") + "\n原因：" + (e && e.message ? e.message : e) + "\n\n建议：若为 HEIC，可先在相册共享为 JPEG/PNG 再上传。", true);
        });
      });
    });

    return p.then(function () {
      setStatus("", false);
      renderInputGallery();

      // iOS 兼容：允许再次选择同一张图片
      try { els.imageFile.value = ""; } catch (_) {}
    });
  }

  function b64ToBlobUrl(b64, mimeType) {
    var binary = atob(b64);
    var len = binary.length;
    var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    var blob = new Blob([bytes], { type: mimeType || "application/octet-stream" });
    var url = URL.createObjectURL(blob);
    objectUrls.push(url);
    return { url: url, blob: blob };
  }

  function cleanupObjectUrls() {
    for (var i = 0; i < objectUrls.length; i++) {
      try { URL.revokeObjectURL(objectUrls[i]); } catch (_) {}
    }
    objectUrls = [];
  }

  function buildBodyFromForm() {
    var systemPrompt = (els.systemPrompt.value || "").trim();
    var prompt = els.prompt.value || ""; // allow empty
    var aspectRatio = els.aspectRatio.value || "";
    var imageSize = els.imageSize.value || "";

    var temperature = safeNumberOrEmpty(els.temperature.value);
    var topP = safeNumberOrEmpty(els.topP.value);

    // prompt may be empty: still send an empty text part
    var parts = [{ text: String(prompt) }];

    for (var i = 0; i < selectedImages.length; i++) {
      var img = selectedImages[i];
      parts.push({
        inline_data: {
          mime_type: img.mimeType,
          data: img.base64
        }
      });
    }

    var body = {
      contents: [{ role: "user", parts: parts }],
      generationConfig: { responseModalities: ["Image"] }
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
    var host = stripTrailingSlash((els.apiHost.value || "").trim() || DEFAULT_HOST);
    var apiKey = (els.apiKey.value || "").trim();
    var useHeaderKey = !!els.useHeaderKey.checked;

    if (!apiKey) throw new Error("请填写 API Key。");

    var url = useHeaderKey
      ? (host + API_PATH)
      : (host + API_PATH + "?key=" + encodeURIComponent(apiKey));

    var body;
    if (uiMode === "json") {
      var raw = (els.requestBodyJson.value || "").trim();
      if (!raw) throw new Error("JSON 模式下请求体不能为空。");
      try {
        body = JSON.parse(raw);
      } catch (e) {
        throw new Error("JSON 解析失败：" + (e && e.message ? e.message : e));
      }
    } else {
      body = buildBodyFromForm();
    }

    var headers = { "Content-Type": "application/json" };
    if (useHeaderKey) headers["x-goog-api-key"] = apiKey;

    return { url: url, headers: headers, body: body };
  }

  function makeCurl(req) {
    var headers = req.headers || {};
    var body = req.body;

    var parts = [];
    Object.keys(headers).forEach(function (k) {
      parts.push("-H " + JSON.stringify(k + ": " + headers[k]));
    });

    return [
      "curl -s -X POST \\",
      "  " + JSON.stringify(req.url) + " \\",
      "  " + parts.join(" \\\n  ") + " \\",
      "  -d " + JSON.stringify(JSON.stringify(body)),
      ""
    ].join("\n");
  }

  function renderResult(data, ms) {
    els.resultEmpty.classList.add("hidden");
    els.result.classList.remove("hidden");

    els.modelName.textContent = MODEL_ID;
    els.latency.textContent = String(Math.round(ms)) + " ms";

    els.rawJson.textContent = JSON.stringify(data, null, 2);

    var candidates = data && data.candidates ? data.candidates : [];
    var firstParts = [];
    if (candidates[0] && candidates[0].content && candidates[0].content.parts) {
      firstParts = candidates[0].content.parts;
    }

    var texts = [];
    var images = [];

    for (var i = 0; i < firstParts.length; i++) {
      var p = firstParts[i];
      if (p && typeof p.text === "string" && p.text.trim()) {
        texts.push(p.text);
        continue;
      }
      var inline = (p && (p.inlineData || p.inline_data)) ? (p.inlineData || p.inline_data) : null;
      if (inline && inline.data) {
        var mimeType = inline.mimeType || inline.mime_type || "image/png";
        images.push({ b64: inline.data, mimeType: mimeType });
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
      var tag = timestampTag();

      images.forEach(function (img, idx) {
        var r = b64ToBlobUrl(img.b64, img.mimeType);
        var url = r.url;

        var ext = "bin";
        if (img.mimeType.indexOf("png") >= 0) ext = "png";
        else if (img.mimeType.indexOf("jpeg") >= 0) ext = "jpg";
        else if (img.mimeType.indexOf("webp") >= 0) ext = "webp";

        var filename = "gemini3_image_" + tag + "_" + String(idx + 1).padStart(2, "0") + "." + ext;

        var card = document.createElement("div");
        card.className = "imgcard";

        var imageEl = document.createElement("img");
        imageEl.src = url;
        imageEl.alt = "生成图片 " + (idx + 1);

        var bar = document.createElement("div");
        bar.className = "bar";

        var left = document.createElement("div");
        left.textContent = (img.mimeType || "image") + " · " + filename;
        left.style.color = "rgba(233,237,245,0.85)";
        left.style.fontSize = "12px";

        var right = document.createElement("div");
        right.style.display = "flex";
        right.style.gap = "12px";
        right.style.flexWrap = "wrap";
        right.style.alignItems = "center";

        var openA = document.createElement("a");
        openA.className = "link";
        openA.href = url;
        openA.target = "_blank";
        openA.rel = "noopener";
        openA.textContent = "打开原图";

        var dlA = document.createElement("a");
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

  function persistBase() {
    localStorage.setItem(storageKeys.host, (els.apiHost.value || "").trim());
    localStorage.setItem(storageKeys.rememberKey, String(!!els.rememberKey.checked));
    localStorage.setItem(storageKeys.useHeaderKey, String(!!els.useHeaderKey.checked));

    localStorage.setItem(storageKeys.uiMode, uiMode);
    localStorage.setItem(storageKeys.requestBodyJson, els.requestBodyJson.value || "");

    localStorage.setItem(storageKeys.systemPrompt, els.systemPrompt.value || "");
    localStorage.setItem(storageKeys.prompt, els.prompt.value || "");
    localStorage.setItem(storageKeys.aspectRatio, els.aspectRatio.value || "");
    localStorage.setItem(storageKeys.imageSize, els.imageSize.value || "");
    localStorage.setItem(storageKeys.temperature, els.temperature.value || "");
    localStorage.setItem(storageKeys.topP, els.topP.value || "");

    if (els.rememberKey.checked) {
      localStorage.setItem(storageKeys.apiKey, els.apiKey.value || "");
    } else {
      localStorage.removeItem(storageKeys.apiKey);
    }
  }

  function restoreBase() {
    els.apiHost.value = localStorage.getItem(storageKeys.host) || "";
    els.rememberKey.checked = (localStorage.getItem(storageKeys.rememberKey) || "false") === "true";
    els.useHeaderKey.checked = (localStorage.getItem(storageKeys.useHeaderKey) || "false") === "true";

    uiMode = localStorage.getItem(storageKeys.uiMode) || "form";
    els.requestBodyJson.value = localStorage.getItem(storageKeys.requestBodyJson) || "";

    els.systemPrompt.value = localStorage.getItem(storageKeys.systemPrompt) || "";
    els.prompt.value = localStorage.getItem(storageKeys.prompt) || "";
    els.aspectRatio.value = localStorage.getItem(storageKeys.aspectRatio) || "";
    els.imageSize.value = localStorage.getItem(storageKeys.imageSize) || "";
    els.temperature.value = localStorage.getItem(storageKeys.temperature) || "";
    els.topP.value = localStorage.getItem(storageKeys.topP) || "";

    var savedKey = localStorage.getItem(storageKeys.apiKey) || "";
    if (els.rememberKey.checked && savedKey) els.apiKey.value = savedKey;
  }

  function setMode(mode) {
    uiMode = mode;

    if (mode === "form") {
      els.modeForm.classList.add("active");
      els.modeJson.classList.remove("active");
      els.formModeWrap.classList.remove("hidden");
      els.jsonModeWrap.classList.add("hidden");
      els.modeForm.setAttribute("aria-selected", "true");
      els.modeJson.setAttribute("aria-selected", "false");
    } else {
      els.modeForm.classList.remove("active");
      els.modeJson.classList.add("active");
      els.formModeWrap.classList.add("hidden");
      els.jsonModeWrap.classList.remove("hidden");
      els.modeForm.setAttribute("aria-selected", "false");
      els.modeJson.setAttribute("aria-selected", "true");

      try {
        els.requestBodyJson.value = JSON.stringify(buildBodyFromForm(), null, 2);
      } catch (e) {
        setStatus("切换到 JSON 模式：无法从表单生成默认 JSON（" + (e && e.message ? e.message : e) + "）。", true);
      }
    }

    persistBase();
  }

  function formatJsonEditor() {
    var raw = (els.requestBodyJson.value || "").trim();
    if (!raw) { setStatus("JSON 为空。", true); return; }
    try {
      var obj = JSON.parse(raw);
      els.requestBodyJson.value = JSON.stringify(obj, null, 2);
      setStatus("已格式化 JSON。", true);
      setTimeout(function () { setStatus("", false); }, 1000);
    } catch (e) {
      setStatus("JSON 解析失败：" + (e && e.message ? e.message : e), true);
    }
  }

  function syncJsonFromForm() {
    try {
      els.requestBodyJson.value = JSON.stringify(buildBodyFromForm(), null, 2);
      setStatus("已从表单同步生成 JSON。", true);
      setTimeout(function () { setStatus("", false); }, 1000);
      persistBase();
    } catch (e) {
      setStatus(e && e.message ? e.message : String(e), true);
    }
  }

  function applyJsonToFormBestEffort() {
    var raw = (els.requestBodyJson.value || "").trim();
    if (!raw) { setStatus("JSON 为空，无法回填。", true); return; }

    var obj;
    try { obj = JSON.parse(raw); }
    catch (e) { setStatus("JSON 解析失败：" + (e && e.message ? e.message : e), true); return; }

    try {
      if (obj.systemInstruction && obj.systemInstruction.parts && obj.systemInstruction.parts[0] && typeof obj.systemInstruction.parts[0].text === "string") {
        els.systemPrompt.value = obj.systemInstruction.parts[0].text;
      }
    } catch (_) {}

    try {
      var parts = (obj.contents && obj.contents[0] && obj.contents[0].parts) ? obj.contents[0].parts : [];
      var text = null;
      var inlines = [];
      parts.forEach(function (p) {
        if (text === null && p && typeof p.text === "string") text = p.text;
        var cand = p && (p.inline_data || p.inlineData) ? (p.inline_data || p.inlineData) : null;
        if (cand && cand.data) inlines.push(cand);
      });

      if (text !== null) els.prompt.value = text;

      // Replace current images with those in JSON
      clearAllImages();

      inlines.forEach(function (inline) {
        var mimeType = inline.mime_type || inline.mimeType || "application/octet-stream";
        var base64 = inline.data;

        // Preview via blob URL
        var r = b64ToBlobUrl(base64, mimeType);
        var dataUrl = r.url;

        selectedImages.push({
          mimeType: mimeType,
          base64: base64,
          size: r.blob && r.blob.size ? r.blob.size : base64.length,
          name: "json_image",
          dataUrl: dataUrl,
          previewKind: "blob"
        });
      });

      renderInputGallery();
    } catch (_) {}

    try {
      var gc = obj.generationConfig || {};
      if (typeof gc.temperature === "number") els.temperature.value = String(gc.temperature);
      if (typeof gc.topP === "number") els.topP.value = String(gc.topP);
      var ic = gc.imageConfig || {};
      if (typeof ic.aspectRatio === "string") els.aspectRatio.value = ic.aspectRatio;
      if (typeof ic.imageSize === "string") els.imageSize.value = ic.imageSize;
    } catch (_) {}

    setStatus("已尽力将 JSON 回填到表单（图片会按 JSON 覆盖当前选择）。", true);
    setTimeout(function () { setStatus("", false); }, 1400);
    persistBase();
  }

  // presets (NO images)
  function loadPresets() {
    try {
      var raw = localStorage.getItem(storageKeys.presets);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      return Array.isArray(arr) ? arr : [];
    } catch (_) { return []; }
  }

  function savePresets(arr) {
    localStorage.setItem(storageKeys.presets, JSON.stringify(arr));
  }

  function refreshPresetUI() {
    var presets = loadPresets();
    var activeName = localStorage.getItem(storageKeys.activePreset) || "";

    els.presetSelect.innerHTML = "";

    var empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "（无预设）";
    els.presetSelect.appendChild(empty);

    presets.forEach(function (p) {
      var opt = document.createElement("option");
      opt.value = p.name;
      opt.textContent = p.name;
      if (p.name === activeName) opt.selected = true;
      els.presetSelect.appendChild(opt);
    });

    var hasActive = !!activeName && presets.some(function (p) { return p.name === activeName; });
    els.presetUpdate.disabled = !hasActive;
    els.presetDelete.disabled = !hasActive;
  }

  function getCurrentPresetName() {
    return els.presetSelect.value || (localStorage.getItem(storageKeys.activePreset) || "");
  }

  function makePresetFromCurrentState() {
    return {
      name: "",
      createdAt: nowISO(),
      updatedAt: nowISO(),
      mode: uiMode,
      fields: {
        systemPrompt: els.systemPrompt.value || "",
        prompt: els.prompt.value || "",
        aspectRatio: els.aspectRatio.value || "",
        imageSize: els.imageSize.value || "",
        temperature: els.temperature.value || "",
        topP: els.topP.value || ""
      },
      requestBodyJson: els.requestBodyJson.value || ""
    };
  }

  function applyPreset(preset) {
    setMode(preset && preset.mode === "json" ? "json" : "form");

    var f = (preset && preset.fields) ? preset.fields : {};
    els.systemPrompt.value = (f.systemPrompt != null) ? f.systemPrompt : "";
    els.prompt.value = (f.prompt != null) ? f.prompt : "";
    els.aspectRatio.value = (f.aspectRatio != null) ? f.aspectRatio : "";
    els.imageSize.value = (f.imageSize != null) ? f.imageSize : "";
    els.temperature.value = (f.temperature != null) ? f.temperature : "";
    els.topP.value = (f.topP != null) ? f.topP : "";

    if (preset && typeof preset.requestBodyJson === "string") {
      els.requestBodyJson.value = preset.requestBodyJson;
    }

    persistBase();
    setStatus("已应用预设：" + preset.name + "\n（Host / Key 未改变；图片未随预设变化）", true);
    setTimeout(function () { setStatus("", false); }, 1400);
  }

  function saveAsPreset() {
    var name = (prompt("请输入预设名称（预设不保存图片；Host/Key 也不保存）：") || "").trim();
    if (!name) return;

    var presets = loadPresets();
    var existing = presets.find(function (p) { return p.name === name; });

    if (existing) {
      var ok = confirm("预设“" + name + "”已存在，是否覆盖？");
      if (!ok) return;
      var next = makePresetFromCurrentState();
      next.name = name;
      next.createdAt = existing.createdAt || nowISO();
      next.updatedAt = nowISO();
      presets[presets.findIndex(function (p) { return p.name === name; })] = next;
    } else {
      var p2 = makePresetFromCurrentState();
      p2.name = name;
      presets.push(p2);
    }

    savePresets(presets);
    localStorage.setItem(storageKeys.activePreset, name);
    refreshPresetUI();
    setStatus("已保存预设：" + name, true);
    setTimeout(function () { setStatus("", false); }, 1200);
  }

  function updateActivePreset() {
    var name = getCurrentPresetName();
    if (!name) return;

    var presets = loadPresets();
    var idx = presets.findIndex(function (p) { return p.name === name; });
    if (idx < 0) return;

    var ok = confirm("确认更新预设“" + name + "”？（不会保存图片）");
    if (!ok) return;

    var existing = presets[idx];
    var next = makePresetFromCurrentState();
    next.name = name;
    next.createdAt = existing.createdAt || nowISO();
    next.updatedAt = nowISO();
    presets[idx] = next;

    savePresets(presets);
    localStorage.setItem(storageKeys.activePreset, name);
    refreshPresetUI();
    setStatus("已更新预设：" + name, true);
    setTimeout(function () { setStatus("", false); }, 1200);
  }

  function deleteActivePreset() {
    var name = getCurrentPresetName();
    if (!name) return;

    var ok = confirm("确认删除预设“" + name + "”？该操作不可撤销。");
    if (!ok) return;

    var presets = loadPresets().filter(function (p) { return p.name !== name; });
    savePresets(presets);

    localStorage.removeItem(storageKeys.activePreset);
    refreshPresetUI();
    setStatus("已删除预设：" + name, true);
    setTimeout(function () { setStatus("", false); }, 1200);
  }

  function exportPresets() {
    var presets = loadPresets();
    var payload = { version: 1, exportedAt: nowISO(), presets: presets };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    var url = URL.createObjectURL(blob);

    var a = document.createElement("a");
    a.href = url;
    a.download = "gemini3_presets_" + timestampTag() + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();

    setTimeout(function () { try { URL.revokeObjectURL(url); } catch (_) {} }, 5000);
    setStatus("已导出预设：" + presets.length + " 个", true);
    setTimeout(function () { setStatus("", false); }, 1200);
  }

  function importPresetsFromFile(file) {
    if (!file) return Promise.resolve();

    return file.text().then(function (text) {
      var obj;
      try { obj = JSON.parse(text); }
      catch (e) { setStatus("导入失败：JSON 解析错误：" + (e && e.message ? e.message : e), true); return; }

      var incoming = Array.isArray(obj && obj.presets) ? obj.presets : (Array.isArray(obj) ? obj : []);
      if (!incoming.length) { setStatus("导入失败：未发现 presets 数组。", true); return; }

      var existing = loadPresets();
      var nameSet = new Set(existing.map(function (p) { return p.name; }));

      var merged = existing.slice();
      var added = 0;

      incoming.forEach(function (p) {
        if (!p || !p.name) return;
        var name = String(p.name).trim();
        if (!name) return;

        if (nameSet.has(name)) {
          var i = 1;
          while (nameSet.has(name + "（导入" + i + "）")) i++;
          name = name + "（导入" + i + "）";
        }

        var safePreset = {
          name: name,
          createdAt: p.createdAt || nowISO(),
          updatedAt: nowISO(),
          mode: (p.mode === "json") ? "json" : "form",
          fields: {
            systemPrompt: p.fields && p.fields.systemPrompt != null ? p.fields.systemPrompt : "",
            prompt: p.fields && p.fields.prompt != null ? p.fields.prompt : "",
            aspectRatio: p.fields && p.fields.aspectRatio != null ? p.fields.aspectRatio : "",
            imageSize: p.fields && p.fields.imageSize != null ? p.fields.imageSize : "",
            temperature: p.fields && p.fields.temperature != null ? p.fields.temperature : "",
            topP: p.fields && p.fields.topP != null ? p.fields.topP : ""
          },
          requestBodyJson: (typeof p.requestBodyJson === "string") ? p.requestBodyJson : ""
        };

        merged.push(safePreset);
        nameSet.add(name);
        added++;
      });

      if (!added) { setStatus("导入完成：未新增任何有效预设。", true); return; }

      savePresets(merged);
      refreshPresetUI();
      setStatus("导入完成：新增 " + added + " 个预设。", true);
      setTimeout(function () { setStatus("", false); }, 1400);
    }).catch(function (e) {
      setStatus("读取导入文件失败：" + (e && e.message ? e.message : e), true);
    });
  }

  function doFetchOnce(req) {
    var t0 = performance.now();
    return fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: JSON.stringify(req.body)
    }).then(function (resp) {
      return resp.json().catch(function () { return {}; }).then(function (data) {
        var t1 = performance.now();
        return { resp: resp, data: data, ms: (t1 - t0) };
      });
    });
  }

  function run() {
    persistBase();
    setStatus("正在请求模型生成……", true);

    els.resultEmpty.classList.add("hidden");
    els.result.classList.add("hidden");
    els.textOutWrap.classList.add("hidden");
    els.imagesOutWrap.classList.add("hidden");
    els.rawJson.textContent = "";
    cleanupObjectUrls();

    var req;
    try { req = buildRequest(); }
    catch (e) { setStatus(e && e.message ? e.message : String(e), true); return Promise.resolve(); }

    lastRequest = req;

    requestInFlight = true;
    hiddenDuringRequest = false;

    var didAutoRetry = false;

    return requestWakeLock().then(function () {
      function loopOnce() {
        return doFetchOnce(req).then(function (r) {
          if (!r.resp.ok) {
            var msg = (r.data && r.data.error && r.data.error.message) ? r.data.error.message : ("HTTP " + r.resp.status + " " + r.resp.statusText);
            setStatus("请求失败：" + msg + "\n\n（提示：若你使用自定义 Host，请确认它支持该路径与鉴权方式。）", true);
            els.resultEmpty.classList.remove("hidden");
            return;
          }

          setStatus("", false);
          renderResult(r.data, r.ms);
        }).catch(function (e) {
          if (!didAutoRetry && hiddenDuringRequest && isLikelyNetworkError(e)) {
            didAutoRetry = true;
            setStatus("检测到请求过程中页面进入后台导致网络中断，正在自动重试一次……", true);
            return requestWakeLock().then(loopOnce);
          }
          setStatus(
            "网络或浏览器限制导致请求失败：" + (e && e.message ? e.message : e) +
              "\n\n（提示：若 iOS Safari 经常后台失败，建议尽量保持前台完成一次请求；或使用自定义 Host/反代提升可用性。）",
            true
          );
          els.resultEmpty.classList.remove("hidden");
        });
      }

      return loopOnce();
    }).finally(function () {
      requestInFlight = false;
      hiddenDuringRequest = false;
      releaseWakeLock();
    });
  }

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

  function wireEvents() {
    ["input", "change"].forEach(function (evt) {
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

    els.rememberKey.addEventListener("change", function () {
      if (!els.rememberKey.checked) localStorage.removeItem(storageKeys.apiKey);
      else localStorage.setItem(storageKeys.apiKey, els.apiKey.value || "");
    });

    els.apiKey.addEventListener("input", function () {
      if (els.rememberKey.checked) localStorage.setItem(storageKeys.apiKey, els.apiKey.value || "");
    });

    els.modeForm.addEventListener("click", function () { setMode("form"); });
    els.modeJson.addEventListener("click", function () { setMode("json"); });

    els.jsonFormat.addEventListener("click", formatJsonEditor);
    els.jsonFromForm.addEventListener("click", syncJsonFromForm);
    els.jsonToForm.addEventListener("click", applyJsonToFormBestEffort);

    // Stronger file picker trigger
    els.dropZone.addEventListener("click", function () {
      try { els.imageFile.click(); } catch (_) {}
    });

    els.dropZone.addEventListener("keydown", function (e) {
      var key = e.key || e.keyCode;
      if (key === "Enter" || key === " " || key === 13 || key === 32) {
        e.preventDefault();
        try { els.imageFile.click(); } catch (_) {}
      }
    });

    // Drag & drop
    function onDrag(e) {
      e.preventDefault();
      e.stopPropagation();
      try { els.dropZone.style.borderColor = "rgba(140, 160, 255, 0.45)"; } catch (_) {}
    }
    function onLeave(e) {
      e.preventDefault();
      e.stopPropagation();
      try { els.dropZone.style.borderColor = "rgba(255,255,255,0.2)"; } catch (_) {}
    }

    els.dropZone.addEventListener("dragenter", onDrag);
    els.dropZone.addEventListener("dragover", onDrag);
    els.dropZone.addEventListener("dragleave", onLeave);
    els.dropZone.addEventListener("drop", function (e) {
      onLeave(e);
      var files = e.dataTransfer ? e.dataTransfer.files : null;
      addImagesFromFiles(files);
    });

    // File picker (append)
    els.imageFile.addEventListener("change", function () {
      var files = els.imageFile.files;
      if (!files || !files.length) {
        setStatus("未选择任何文件。", true);
        setTimeout(function () { setStatus("", false); }, 800);
        return;
      }
      addImagesFromFiles(files);
    });

    els.clearImage.addEventListener("click", clearAllImages);

    els.form.addEventListener("submit", function (e) {
      e.preventDefault();
      els.runBtn.disabled = true;
      run().finally(function () {
        els.runBtn.disabled = false;
      });
    });

    els.resetBtn.addEventListener("click", resetNonFixedFields);

    els.copyCurl.addEventListener("click", function () {
      if (!lastRequest) return;
      copyTextToClipboard(makeCurl(lastRequest)).then(function () {
        setStatus("已复制 cURL 到剪贴板。", true);
        setTimeout(function () { setStatus("", false); }, 1200);
      }).catch(function () {
        setStatus("复制失败：当前浏览器限制剪贴板写入。", true);
      });
    });

    els.copyJson.addEventListener("click", function () {
      if (!lastRequest) return;
      var json = JSON.stringify(lastRequest.body, null, 2);
      copyTextToClipboard(json).then(function () {
        setStatus("已复制请求 JSON 到剪贴板。", true);
        setTimeout(function () { setStatus("", false); }, 1200);
      }).catch(function () {
        setStatus("复制失败：当前浏览器限制剪贴板写入。", true);
      });
    });

    // presets
    els.presetSelect.addEventListener("change", function () {
      var name = els.presetSelect.value || "";
      if (!name) {
        localStorage.removeItem(storageKeys.activePreset);
        refreshPresetUI();
        return;
      }
      localStorage.setItem(storageKeys.activePreset, name);
      var presets = loadPresets();
      var p = presets.find(function (x) { return x.name === name; });
      if (p) applyPreset(p);
      refreshPresetUI();
    });

    els.presetSave.addEventListener("click", saveAsPreset);
    els.presetUpdate.addEventListener("click", updateActivePreset);
    els.presetDelete.addEventListener("click", deleteActivePreset);
    els.presetExport.addEventListener("click", exportPresets);

    els.presetImport.addEventListener("change", function () {
      var f = els.presetImport.files && els.presetImport.files[0];
      els.presetImport.value = "";
      importPresetsFromFile(f);
    });

    document.addEventListener("visibilitychange", function () {
      if (requestInFlight && document.visibilityState === "hidden") hiddenDuringRequest = true;
      if (requestInFlight && document.visibilityState === "visible") requestWakeLock();
    });
  }

  function init() {
    restoreBase();
    wireEvents();

    setMode(uiMode === "json" ? "json" : "form");

    refreshPresetUI();
    var activeName = localStorage.getItem(storageKeys.activePreset) || "";
    if (activeName) {
      var presets = loadPresets();
      var p = presets.find(function (x) { return x.name === activeName; });
      if (p) applyPreset(p);
    }

    renderInputGallery();
  }

  init();
})();