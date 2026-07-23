/** Mobile capture page served by the desktop bridge. */
export function buildMobilePageHtml(opts: {
	token: string;
	notebookName: string;
	defaultNotebookId?: string | null;
	notebooks?: Array<{ id: string; name: string }>;
}): string {
	const title = escapeHtml(opts.notebookName || "AI Notebook");
	const tokenJson = JSON.stringify(opts.token || "");
	const defaultIdJson = JSON.stringify(opts.defaultNotebookId || "");
	const notebooksJson = JSON.stringify(opts.notebooks || []);
	return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"/>
<meta name="apple-mobile-web-app-capable" content="yes"/>
<title>AI 速记 · ${title}</title>
<style>
:root{--bg:#0f1115;--card:#1a1d24;--text:#e8eaed;--muted:#9aa0a6;--accent:#7c9cff;--ok:#3dd68c;--danger:#ff6b6b;--border:#2a2f3a;--warn:#ffcc80}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--text);min-height:100vh;padding:16px;padding-bottom:48px}
h1{font-size:1.25rem;margin:0 0 4px}
.sub{color:var(--muted);font-size:.85rem;margin-bottom:12px;line-height:1.4}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:14px;margin-bottom:14px}
label{display:block;font-size:.8rem;color:var(--muted);margin-bottom:6px}
textarea,input[type=text],select,input[type=file]{width:100%;background:#0c0e12;color:var(--text);border:1px solid var(--border);border-radius:10px;padding:12px;font-size:16px}
textarea{min-height:120px;resize:vertical}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
button{flex:1;min-width:110px;border:0;border-radius:10px;padding:12px 14px;font-size:.92rem;font-weight:600;background:var(--accent);color:#0b1020;cursor:pointer}
button.secondary{background:#2a3142;color:var(--text)}
button.danger{background:#3a1f24;color:#ffb4b4}
button:disabled{opacity:.45}
#status{min-height:1.2em;font-size:.85rem;color:var(--muted);margin-top:8px;white-space:pre-wrap}
#status.ok{color:var(--ok)}#status.err{color:var(--danger)}
.timer{font-size:1.4rem;font-variant-numeric:tabular-nums;margin:8px 0}
.recent,.queue{list-style:none;padding:0;margin:8px 0 0}
.recent li,.queue li{margin-bottom:8px;border-bottom:1px solid var(--border);padding-bottom:8px;font-size:.85rem}
.badge{display:inline-block;font-size:.7rem;padding:2px 6px;border-radius:6px;background:#243049;color:var(--accent);margin-left:6px}
.warn{font-size:.8rem;color:var(--warn);margin-top:8px;line-height:1.4}
.tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.tabs button{flex:0 1 auto;min-width:auto;padding:8px 12px;font-size:.85rem}
.tabs button.active{outline:2px solid var(--accent)}
.hidden{display:none}
.item-row{display:flex;gap:8px;align-items:flex-start}
.item-row input{width:auto;margin-top:4px}
.meta{color:var(--muted);font-size:.75rem}
.lan-pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:.75rem;margin-left:6px}
.lan-on{background:#1e3a2f;color:var(--ok)}.lan-off{background:#3a2a1e;color:var(--warn)}
.progress-wrap{display:none;margin-top:12px}
.progress-wrap.show{display:block}
.progress-label{font-size:.85rem;color:var(--muted);margin-bottom:6px;line-height:1.4}
.progress-track{height:10px;background:#0c0e12;border:1px solid var(--border);border-radius:999px;overflow:hidden}
.progress-bar{height:100%;width:0%;background:linear-gradient(90deg,var(--accent),#a8c0ff);border-radius:999px;transition:width .25s ease}
.progress-bar.indeterminate{width:40%;animation:indet 1.1s ease-in-out infinite}
@keyframes indet{0%{transform:translateX(-100%)}100%{transform:translateX(280%)}}
.progress-bar.done{background:var(--ok)}
.progress-bar.fail{background:var(--danger)}
.item-row.sending{opacity:.75}
.item-row.sending input{pointer-events:none}
.badge-send{background:#3a2a1e;color:var(--warn)}
.badge-wait{background:#243049;color:var(--accent)}
.badge-cancel{background:#3a1f24;color:#ffb4b4}
</style>
</head>
<body>
  <h1>AI 速记</h1>
  <div class="sub">
    目标记录本可选 · 内容先存手机本地，同 Wi‑Fi 再发送
    <span id="lanPill" class="lan-pill lan-off">检测网络…</span>
  </div>

  <div class="card">
    <label for="nb">发送到哪个记录本</label>
    <select id="nb"></select>
    <div class="meta" style="margin-top:6px">在电脑命令面板也可「新建记录本」。此处选择后，发送会进入对应本。</div>
  </div>

  <div class="tabs">
    <button type="button" class="secondary active" data-tab="compose">录入</button>
    <button type="button" class="secondary" data-tab="queue">待发送</button>
    <button type="button" class="secondary" data-tab="trash">垃圾箱(30天)</button>
    <button type="button" class="secondary" data-tab="recent">最近写入</button>
  </div>

  <div id="tab-compose">
    <div class="card">
      <label for="text">文字 / 杂乱信息</label>
      <textarea id="text" placeholder="随便写、粘贴链接、待办、聊天摘录…"></textarea>
      <div class="row">
        <button id="btnCache" type="button">加入待发送</button>
        <button id="btnSendNow" type="button">立即发送并整理</button>
        <button id="btnInbox" class="secondary" type="button">仅收件箱</button>
      </div>
      <div id="status"></div>
    </div>

    <div class="card">
      <label>语音（需 HTTPS 公网链接时手机才常允许麦克风）</label>
      <div class="timer" id="timer">00:00</div>
      <div class="row">
        <button id="btnRec" type="button">开始录音</button>
        <button id="btnStop" class="danger" type="button" disabled>停止录音</button>
      </div>
      <div class="row">
        <button id="btnVoiceCache" type="button" disabled>加入待发送</button>
        <button id="btnVoiceSend" type="button" disabled>立即发送并整理</button>
        <button id="btnVoiceInbox" class="secondary" type="button" disabled>仅收件箱</button>
      </div>
      <div class="warn" id="micWarn"></div>
      <div class="meta" id="voiceReady"></div>
    </div>

    <div class="card">
      <label for="file">文件上传（文档/图片/音视频）</label>
      <input id="file" type="file" multiple />
      <div class="row">
        <button id="btnFileCache" type="button">加入待发送</button>
        <button id="btnFileSend" type="button">立即发送并整理</button>
        <button id="btnFileInbox" class="secondary" type="button">仅收件箱</button>
      </div>
      <div class="meta">图片/视频写入电脑附件并在笔记中嵌入预览。大文件建议同 Wi‑Fi 发送。</div>
    </div>
  </div>

  <div id="tab-queue" class="hidden">
    <div class="card">
      <label>待发送缓存（IndexedDB，离线可继续录入）</label>
      <div class="row">
        <button id="btnSelAll" class="secondary" type="button">全选</button>
        <button id="btnSelNone" class="secondary" type="button">取消全选</button>
        <button id="btnSendSel" type="button">发送勾选</button>
        <button id="btnSendAll" type="button">全部发送</button>
        <button id="btnCancelSel" class="danger" type="button">取消勾选的发送</button>
        <button id="btnDelSel" class="danger" type="button">删除勾选→垃圾箱</button>
      </div>
      <div class="warn" id="queueWarn"></div>
      <div class="progress-wrap" id="sendProgress">
        <div class="progress-label" id="sendProgressLabel">准备发送…</div>
        <div class="progress-track"><div class="progress-bar" id="sendProgressBar"></div></div>
      </div>
      <ul class="queue" id="queue"></ul>
    </div>
  </div>

  <div id="tab-trash" class="hidden">
    <div class="card">
      <label>缓存垃圾箱（移入后保留 30 天）</label>
      <div class="row">
        <button id="btnTrashSelAll" class="secondary" type="button">全选</button>
        <button id="btnTrashSelNone" class="secondary" type="button">取消全选</button>
        <button id="btnRestore" type="button">恢复勾选</button>
        <button id="btnPurge" class="danger" type="button">永久删除勾选</button>
        <button id="btnEmpty" class="danger" type="button">清空垃圾箱</button>
      </div>
      <ul class="queue" id="trash"></ul>
    </div>
  </div>

  <div id="tab-recent" class="hidden">
    <div class="card">
      <label>最近写入（电脑端）</label>
      <div class="row"><button id="btnRefresh" class="secondary" type="button">刷新列表</button></div>
      <ul class="recent" id="recent"></ul>
    </div>
  </div>

<script>
// Token: prefer embedded from server; fallback to ?t= in current URL (same link phone opened)
var TOKEN = ${tokenJson};
try {
  if (!TOKEN) {
    TOKEN = new URLSearchParams(location.search).get("t") || "";
  }
} catch (e) { TOKEN = TOKEN || ""; }
const DEFAULT_NB = ${defaultIdJson};
const NOTEBOOKS = ${notebooksJson};
const DB_NAME = "ai-notebook-mobile-v1";
const TRASH_MS = 30 * 24 * 60 * 60 * 1000;
let lanOk = false;
let selectedNb = DEFAULT_NB || (NOTEBOOKS[0] && NOTEBOOKS[0].id) || "";

function qs(path) {
  try {
    const u = new URL(path, location.href);
    // always re-apply token from TOKEN or page URL
    var tok = TOKEN || "";
    try {
      if (!tok) tok = new URLSearchParams(location.search).get("t") || "";
    } catch (e2) {}
    if (tok) u.searchParams.set("t", tok);
    return u.toString();
  } catch (e) {
    var q = (TOKEN ? ("?t=" + encodeURIComponent(TOKEN)) : "");
    if (path.indexOf("?") >= 0) {
      return path + (TOKEN ? ("&t=" + encodeURIComponent(TOKEN)) : "");
    }
    return path + q;
  }
}
function setStatus(msg, kind) {
  const el = document.getElementById("status");
  el.textContent = msg || "";
  el.className = kind || "";
}
function setMicWarn(msg) {
  document.getElementById("micWarn").textContent = msg || "";
}
function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function uid() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}
function openDb() {
  return new Promise(function(resolve, reject) {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = function() {
      const db = req.result;
      if (!db.objectStoreNames.contains("queue")) db.createObjectStore("queue", { keyPath: "id" });
      if (!db.objectStoreNames.contains("trash")) db.createObjectStore("trash", { keyPath: "id" });
    };
    req.onsuccess = function() { resolve(req.result); };
    req.onerror = function() { reject(req.error); };
  });
}
function txDone(tx) {
  return new Promise(function(resolve, reject) {
    tx.oncomplete = function() { resolve(); };
    tx.onerror = function() { reject(tx.error); };
  });
}
async function storeAll(name) {
  const db = await openDb();
  return new Promise(function(resolve, reject) {
    const tx = db.transaction(name, "readonly");
    const req = tx.objectStore(name).getAll();
    req.onsuccess = function() { resolve(req.result || []); };
    req.onerror = function() { reject(req.error); };
  });
}
async function storePut(name, item) {
  const db = await openDb();
  const tx = db.transaction(name, "readwrite");
  tx.objectStore(name).put(item);
  await txDone(tx);
}
async function storeDel(name, id) {
  const db = await openDb();
  const tx = db.transaction(name, "readwrite");
  tx.objectStore(name).delete(id);
  await txDone(tx);
}
async function purgeExpiredTrash() {
  const items = await storeAll("trash");
  const now = Date.now();
  for (const it of items) {
    if (now - (it.trashedAt || 0) > TRASH_MS) await storeDel("trash", it.id);
  }
}

async function api(path, body) {
  var headers = authHeaders();
  if (body) headers["Content-Type"] = "application/json";
  const res = await fetch(qs(path), {
    method: body ? "POST" : "GET",
    headers: headers,
    body: body ? JSON.stringify(body) : undefined,
    cache: "no-store",
    credentials: "omit",
  });
  const data = await res.json().catch(function() { return {}; });
  if (!res.ok || data.ok === false) throw new Error(data.error || ("HTTP " + res.status));
  return data;
}

function fillNotebooks(list, defaultId) {
  const sel = document.getElementById("nb");
  if (!sel) return;
  var prev = selectedNb || defaultId || "";
  sel.innerHTML = "";
  list = list || [];
  if (!list.length) {
    const o = document.createElement("option");
    o.value = ""; o.textContent = "（电脑上还没有记录本，请先新建）";
    sel.appendChild(o);
    selectedNb = "";
    return;
  }
  var hasPrev = false;
  list.forEach(function(n) {
    const o = document.createElement("option");
    o.value = n.id; o.textContent = n.name;
    sel.appendChild(o);
    if (n.id === prev) hasPrev = true;
  });
  selectedNb = hasPrev ? prev : (defaultId || list[0].id);
  sel.value = selectedNb;
  sel.onchange = function() {
    selectedNb = sel.value;
    if (lanOk && selectedNb) {
      api("/api/notebook", { notebook_id: selectedNb }).catch(function(){});
    }
  };
}

function setLan(ok, detail) {
  lanOk = !!ok;
  const pill = document.getElementById("lanPill");
  if (!pill) return;
  if (ok) {
    pill.textContent = "已连接电脑";
    pill.className = "lan-pill lan-on";
  } else {
    pill.textContent = detail ? ("未连通 · " + detail) : "未连电脑 · 仅本地缓存";
    pill.className = "lan-pill lan-off";
  }
  var qw = document.getElementById("queueWarn");
  if (qw) {
    if (ok) {
      if (window.__sendPipe && window.__sendPipe.running) {
        qw.textContent = "发送进行中：可继续勾选未发送项追加队列；发送中/排队中条目不可勾选。";
      } else {
        qw.textContent = "可勾选后发送到电脑。发送中仍可追加新勾选。";
      }
    } else {
      qw.textContent =
        "当前无法连上电脑服务。内容可先「加入待发送」。请确认：同一 Wi‑Fi、电脑 Obsidian 开着、手机入口运行中、链接带 ?t= 令牌。";
    }
  }
}

function authHeaders() {
  var h = {};
  var tok = TOKEN;
  try {
    if (!tok) tok = new URLSearchParams(location.search).get("t") || "";
  } catch (e) {}
  if (tok) h["X-Bridge-Token"] = tok;
  return h;
}

/** Low-level GET with timeout; returns { ok, status, data, error } */
function probeGet(path, timeoutMs) {
  timeoutMs = timeoutMs || 4000;
  return new Promise(function(resolve) {
    var done = false;
    var timer = setTimeout(function() {
      if (done) return;
      done = true;
      resolve({ ok: false, status: 0, data: {}, error: "超时" });
    }, timeoutMs);
    var opts = {
      method: "GET",
      headers: authHeaders(),
      cache: "no-store",
      credentials: "omit",
    };
    // Prefer not using AbortController on flaky mobile WebViews; use timeout race instead
    fetch(qs(path), opts).then(function(res) {
      return res.json().catch(function() { return {}; }).then(function(data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve({
          ok: res.ok && data && data.ok !== false,
          status: res.status,
          data: data || {},
          error: (!res.ok || (data && data.ok === false))
            ? ((data && data.error) || ("HTTP " + res.status))
            : "",
        });
      });
    }).catch(function(e) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      var msg = String(e && e.message || e || "网络错误");
      if (msg.indexOf("Failed to fetch") >= 0 || msg.indexOf("NetworkError") >= 0) {
        msg = "无法访问电脑服务";
      }
      resolve({ ok: false, status: 0, data: {}, error: msg });
    });
  });
}

async function refreshLan() {
  // CRITICAL: if this HTML was served by the desktop bridge, we are already connected.
  // Never leave the pill stuck on "检测网络…" — mark connected first, then refine via API.
  var host = "";
  try { host = location.hostname || ""; } catch (e) {}
  var hasTok = !!(TOKEN || ((location.search || "").indexOf("t=") >= 0));
  var pageFromBridge =
    (location.protocol === "http:" || location.protocol === "https:") &&
    hasTok &&
    host.length > 0;

  if (pageFromBridge && !lanOk) {
    // Optimistic: page load already proved the phone can reach the computer
    setLan(true);
    try {
      if (NOTEBOOKS && NOTEBOOKS.length) fillNotebooks(NOTEBOOKS, DEFAULT_NB);
    } catch (e0) {}
  }

  try {
    var r = await probeGet("/api/ping", 3500);
    if (!r.ok) r = await probeGet("/api/status", 3500);
    if (r.ok) {
      setLan(true);
      try {
        if (r.data && r.data.notebooks && r.data.notebooks.length) {
          fillNotebooks(r.data.notebooks, r.data.notebookId || DEFAULT_NB);
        } else if (NOTEBOOKS && NOTEBOOKS.length) {
          fillNotebooks(NOTEBOOKS, DEFAULT_NB);
        }
      } catch (e1) {}
      return;
    }
    // API failed but page was served by bridge — stay connected (don't flip to red)
    if (pageFromBridge) {
      setLan(true);
      var pill = document.getElementById("lanPill");
      if (pill) {
        pill.textContent = "已连接电脑（页面可达）";
        pill.className = "lan-pill lan-on";
      }
      return;
    }
    setLan(false, (r.error || "检测失败").toString().slice(0, 48));
  } catch (e) {
    if (pageFromBridge) {
      setLan(true);
      return;
    }
    setLan(false, String(e && e.message || e || "未知错误").slice(0, 48));
  }
}

function switchTab(name) {
  ["compose","queue","trash","recent"].forEach(function(t) {
    document.getElementById("tab-" + t).classList.toggle("hidden", t !== name);
  });
  document.querySelectorAll(".tabs button").forEach(function(b) {
    b.classList.toggle("active", b.getAttribute("data-tab") === name);
  });
  if (name === "queue") renderQueue();
  if (name === "trash") renderTrash();
  if (name === "recent") refreshRecent();
}
document.querySelectorAll(".tabs button").forEach(function(b) {
  b.onclick = function() { switchTab(b.getAttribute("data-tab")); };
});

async function addQueueItem(item) {
  item.id = item.id || uid();
  item.createdAt = item.createdAt || Date.now();
  item.notebook_id = item.notebook_id || selectedNb || "";
  await storePut("queue", item);
  setStatus("已加入待发送（本地缓存）", "ok");
  renderQueue();
}

document.getElementById("btnCache").onclick = async function() {
  const text = document.getElementById("text").value.trim();
  if (!text) return setStatus("请先输入内容", "err");
  await addQueueItem({ type: "text", text: text, organize: true, title: text.split("\\n")[0].slice(0, 40) });
  document.getElementById("text").value = "";
};

document.getElementById("btnSendNow").onclick = async function() {
  const text = document.getElementById("text").value.trim();
  if (!text) return setStatus("请先输入内容", "err");
  if (!lanOk) {
    await addQueueItem({ type: "text", text: text, organize: true, title: text.split("\\n")[0].slice(0, 40) });
    setStatus("未连局域网：已缓存到待发送", "err");
    return;
  }
  setStatus("发送并整理中…");
  try {
    const r = await api("/api/text", { text: text, organize: true, source: "mobile-web", notebook_id: selectedNb, capturedAt: Date.now() });
    setStatus("已写入：" + (r.title || r.path || "ok") + (r.organized ? "（已 AI 整理）" : ""), "ok");
    document.getElementById("text").value = "";
    refreshRecent();
  } catch (e) {
    await addQueueItem({ type: "text", text: text, organize: true, title: text.split("\\n")[0].slice(0, 40) });
    setStatus("发送失败，已改存待发送：" + (e.message || e), "err");
  }
};

document.getElementById("btnInbox").onclick = async function() {
  const text = document.getElementById("text").value.trim();
  if (!text) return setStatus("请先输入内容", "err");
  if (!lanOk) {
    await addQueueItem({ type: "text", text: text, organize: false, title: text.split("\\n")[0].slice(0, 40) });
    setStatus("未连局域网：已缓存（仅收件箱模式）", "err");
    return;
  }
  setStatus("写入收件箱…");
  try {
    const r = await api("/api/text", { text: text, organize: false, source: "mobile-web", notebook_id: selectedNb, capturedAt: Date.now() });
    setStatus("已进收件箱：" + (r.path || "ok"), "ok");
    document.getElementById("text").value = "";
    refreshRecent();
  } catch (e) {
    setStatus(String(e.message || e), "err");
  }
};

function blobToBase64(blob) {
  return new Promise(function(resolve, reject) {
    const fr = new FileReader();
    fr.onload = function() {
      const s = String(fr.result || "");
      const i = s.indexOf(",");
      resolve(i >= 0 ? s.slice(i + 1) : s);
    };
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

async function sendOne(it) {
  var capturedAt = it.createdAt || it.capturedAt || Date.now();
  if (it.type === "text") {
    return api("/api/text", {
      text: it.text,
      organize: it.organize !== false,
      source: "mobile-web-queue",
      notebook_id: it.notebook_id || selectedNb,
      capturedAt: capturedAt,
      createdAt: capturedAt,
    });
  }
  if (it.type === "voice") {
    return api("/api/voice", {
      audioBase64: it.audioBase64,
      mimeType: it.mimeType || "audio/wav",
      organize: true,
      source: "mobile-web-voice-queue",
      notebook_id: it.notebook_id || selectedNb,
      capturedAt: capturedAt,
      createdAt: capturedAt,
    });
  }
  if (it.type === "file") {
    return api("/api/file", {
      fileBase64: it.fileBase64,
      fileName: it.fileName,
      mimeType: it.mimeType,
      title: it.title,
      notebook_id: it.notebook_id || selectedNb,
      capturedAt: capturedAt,
      createdAt: capturedAt,
    });
  }
  throw new Error("unknown type");
}

async function sendIds(ids) {
  if (!lanOk) {
    setStatus("未连局域网，无法发送", "err");
    return;
  }
  var added = enqueueSend(ids || []);
  if (!added) {
    setStatus(window.__sendPipe && window.__sendPipe.running
      ? "所选条目已在发送队列中"
      : "没有可发送的内容（排队中/发送中请用取消）", "err");
    return;
  }
  if (window.__sendPipe && window.__sendPipe.running) {
    setStatus("已追加 " + added + " 条到发送队列", "ok");
    renderQueue();
    updateSendProgressUi();
  } else {
    setStatus("开始发送（可追加；可勾选取消排队）…", "ok");
  }
  void pumpSend();
}

function ensureSendPipe() {
  if (!window.__sendPipe) {
    window.__sendPipe = {
      running: false,
      pending: [],
      activeId: null,
      cancelled: {},
      done: 0,
      ok: 0,
      fail: 0,
      cancelledCount: 0,
      t0: 0,
    };
  }
  return window.__sendPipe;
}

function isInSendPipeline(id) {
  var p = window.__sendPipe;
  if (!p || !id) return false;
  if (p.activeId === id) return true;
  return p.pending.indexOf(id) >= 0;
}

function enqueueSend(ids) {
  var p = ensureSendPipe();
  var n = 0;
  (ids || []).forEach(function(id) {
    if (!id) return;
    if (p.activeId === id) return;
    if (p.pending.indexOf(id) >= 0) return;
    if (p.cancelled[id]) delete p.cancelled[id];
    p.pending.push(id);
    n++;
  });
  return n;
}

function pipelineTotal(p) {
  return p.done + p.pending.length + (p.activeId ? 1 : 0);
}

function updateSendProgressUi(extraLabel, indeterminate, state) {
  var p = ensureSendPipe();
  var total = pipelineTotal(p);
  var done = p.done;
  var label = extraLabel;
  if (!label) {
    if (p.running) {
      var eta = "";
      if (p.done > 0 && total > p.done) {
        var elapsed = (Date.now() - p.t0) / 1000;
        var per = elapsed / Math.max(p.done, 1);
        var left = Math.ceil(per * (total - p.done));
        eta = " · 约剩 " + left + " 秒";
      }
      label = "进度 " + done + "/" + total +
        "（成功 " + p.ok +
        (p.fail ? " / 失败 " + p.fail : "") +
        (p.cancelledCount ? " / 取消 " + p.cancelledCount : "") +
        "）" + eta;
    } else {
      label = "发送完成：成功 " + p.ok +
        (p.fail ? "，失败 " + p.fail : "") +
        (p.cancelledCount ? "，取消 " + p.cancelledCount : "");
    }
  }
  showSendProgress(done, Math.max(total, 1), label, !!indeterminate, state);
}

async function pumpSend() {
  var p = ensureSendPipe();
  if (p.running) return;
  if (!lanOk) {
    setStatus("未连局域网，无法发送", "err");
    return;
  }
  if (!p.pending.length) return;

  p.running = true;
  // New session if idle start
  if (!p.t0) {
    p.t0 = Date.now();
    p.done = 0;
    p.ok = 0;
    p.fail = 0;
    p.cancelledCount = 0;
  }
  updateSendProgressUi("开始发送…");
  renderQueue();

  try {
    while (p.pending.length > 0) {
      if (!lanOk) {
        setStatus("网络中断，剩余 " + p.pending.length + " 条仍在待发送", "err");
        break;
      }
      var id = p.pending.shift();
      if (p.cancelled[id]) {
        delete p.cancelled[id];
        p.cancelledCount++;
        p.done++;
        p.activeId = null;
        updateSendProgressUi();
        renderQueue();
        continue;
      }
      p.activeId = id;
      renderQueue();

      var all = await storeAll("queue");
      var it = null;
      for (var i = 0; i < all.length; i++) {
        if (all[i].id === id) { it = all[i]; break; }
      }
      if (p.cancelled[id]) {
        delete p.cancelled[id];
        p.cancelledCount++;
        p.done++;
        p.activeId = null;
        updateSendProgressUi();
        renderQueue();
        continue;
      }
      if (!it) {
        // Already gone from cache (sent or deleted) — do NOT count as fail
        p.done++;
        p.activeId = null;
        updateSendProgressUi();
        continue;
      }

      var label = (it.title || it.fileName || it.type || "条目").toString().slice(0, 28);
      var totalNow = pipelineTotal(p);
      showSendProgress(
        p.done,
        Math.max(totalNow, 1),
        "正在发送 " + (p.done + 1) + "/" + totalNow + " · " + label,
        true
      );
      setStatus("发送中… " + (p.done + 1) + "/" + totalNow, "ok");

      var sentOk = false;
      var errMsg = "";
      try {
        await sendOne(it);
        sentOk = true;
      } catch (e) {
        errMsg = String(e && e.message || e || "");
      }
      // if cancelled during flight, prefer cancel over fail when still in cache
      if (p.cancelled[id]) {
        delete p.cancelled[id];
        p.cancelledCount++;
        p.done++;
        p.activeId = null;
        updateSendProgressUi();
        renderQueue();
        continue;
      }
      if (sentOk) {
        try { await storeDel("queue", id); } catch (e2) {}
        p.ok++;
      } else {
        p.fail++;
        setStatus("发送失败：" + errMsg, "err");
      }
      p.done++;
      p.activeId = null;
      updateSendProgressUi();
      renderQueue();
    }
  } finally {
    p.running = false;
    p.activeId = null;
    var finalMsg = "发送完成：成功 " + p.ok +
      (p.fail ? "，失败 " + p.fail : "") +
      (p.cancelledCount ? "，取消 " + p.cancelledCount : "");
    if (p.pending.length) {
      finalMsg = "进行中断：成功 " + p.ok +
        (p.fail ? "，失败 " + p.fail : "") +
        "，仍剩排队 " + p.pending.length;
    }
    var st = "done";
    if (p.fail > 0 && p.ok === 0) st = "fail";
    else if (p.fail > 0) st = "done";
    if (p.pending.length) st = null;
    showSendProgress(p.done, Math.max(pipelineTotal(p), p.done, 1), finalMsg, false, st);
    setStatus(finalMsg, p.ok > 0 ? "ok" : (p.fail ? "err" : "ok"));
    renderQueue();
    refreshRecent();
    if (!p.pending.length) {
      setTimeout(function() {
        var q = ensureSendPipe();
        if (!q.running && !q.pending.length) {
          hideSendProgress();
          q.done = 0;
          q.ok = 0;
          q.fail = 0;
          q.cancelledCount = 0;
          q.t0 = 0;
          q.cancelled = {};
        }
      }, 3500);
    } else if (lanOk) {
      // continue remaining
      void pumpSend();
    }
  }
}

function cancelSendIds(ids) {
  var p = ensureSendPipe();
  var n = 0;
  (ids || []).forEach(function(id) {
    if (!id) return;
    var idx = p.pending.indexOf(id);
    if (idx >= 0) {
      p.pending.splice(idx, 1);
      p.cancelledCount++;
      p.done++;
      n++;
      return;
    }
    if (p.activeId === id) {
      p.cancelled[id] = true;
      n++;
    }
  });
  if (!n) {
    setStatus("请勾选「排队中」的条目以取消（发送中只能尽量标记）", "err");
    return;
  }
  updateSendProgressUi();
  renderQueue();
  setStatus("已取消 " + n + " 条排队（仍在待发送列表，可稍后重发）", "ok");
}

function showSendProgress(done, total, label, indeterminate, state) {
  var wrap = document.getElementById("sendProgress");
  var bar = document.getElementById("sendProgressBar");
  var lab = document.getElementById("sendProgressLabel");
  if (!wrap || !bar || !lab) return;
  wrap.classList.add("show");
  lab.textContent = label || "";
  bar.classList.remove("indeterminate", "done", "fail");
  if (state === "done") bar.classList.add("done");
  if (state === "fail") bar.classList.add("fail");
  if (indeterminate && done < total) {
    bar.classList.add("indeterminate");
    bar.style.width = "40%";
  } else {
    var pct = total > 0 ? Math.round((done / total) * 100) : 0;
    if (pct > 100) pct = 100;
    bar.style.width = pct + "%";
  }
}

function hideSendProgress() {
  var wrap = document.getElementById("sendProgress");
  var bar = document.getElementById("sendProgressBar");
  if (wrap) wrap.classList.remove("show");
  if (bar) {
    bar.style.width = "0%";
    bar.classList.remove("indeterminate", "done", "fail");
  }
}

function selectedFrom(listId) {
  return Array.from(document.querySelectorAll("#" + listId + " input[type=checkbox]:checked")).map(function(el) {
    return el.getAttribute("data-id");
  }).filter(function(id) {
    return id && !isInSendPipeline(id);
  });
}

function setAllChecks(listId, checked) {
  document.querySelectorAll("#" + listId + " input[type=checkbox]").forEach(function(el) {
    if (el.disabled) return;
    // for queue: only free items when selecting for send
    var id = el.getAttribute("data-id");
    if (listId === "queue" && checked && isInSendPipeline(id)) return;
    el.checked = !!checked;
  });
}

async function renderQueue() {
  var items = (await storeAll("queue")).sort(function(a,b){return (b.createdAt||0)-(a.createdAt||0);});
  var ul = document.getElementById("queue");
  ul.innerHTML = "";
  if (!items.length) {
    ul.innerHTML = "<li class='meta'>暂无待发送内容</li>";
    return;
  }
  var p = window.__sendPipe;
  items.forEach(function(it) {
    var li = document.createElement("li");
    var label = it.type + " · " + esc(it.title || it.fileName || it.text || "").slice(0, 60);
    var when = it.createdAt ? new Date(it.createdAt).toLocaleString() : "";
    var inPipe = isInSendPipeline(it.id);
    var isActive = p && p.activeId === it.id;
    var badge = "";
    var dis = "";
    var rowCls = "item-row";
    if (isActive) {
      badge = "<span class='badge badge-send'>发送中</span>";
      rowCls += " sending";
    } else if (inPipe) {
      badge = "<span class='badge badge-wait'>排队中</span>";
      rowCls += " sending";
    }
    // queued/active can be checked for cancel; free for send
    li.innerHTML = "<div class='" + rowCls + "'><input type='checkbox' data-id='" + esc(it.id) + "'" + dis + "/><div><strong>" +
      label + "</strong>" + badge + "<div class='meta'>做成 " + when + " · 发送后电脑将使用此时间</div></div></div>";
    ul.appendChild(li);
  });
}

async function renderTrash() {
  await purgeExpiredTrash();
  var items = (await storeAll("trash")).sort(function(a,b){return (b.trashedAt||0)-(a.trashedAt||0);});
  var ul = document.getElementById("trash");
  ul.innerHTML = "";
  if (!items.length) {
    ul.innerHTML = "<li class='meta'>垃圾箱为空</li>";
    return;
  }
  items.forEach(function(it) {
    var left = Math.max(0, TRASH_MS - (Date.now() - (it.trashedAt || 0)));
    var days = Math.ceil(left / (24*60*60*1000));
    var li = document.createElement("li");
    li.innerHTML = "<div class='item-row'><input type='checkbox' data-id='" + esc(it.id) + "'/><div><strong>" +
      esc(it.type + " · " + (it.title || it.fileName || "")) +
      "</strong><div class='meta'>剩余约 " + days + " 天 · " + new Date(it.trashedAt||0).toLocaleString() + "</div></div></div>";
    ul.appendChild(li);
  });
}

document.getElementById("btnSelAll").onclick = function() { setAllChecks("queue", true); };
document.getElementById("btnSelNone").onclick = function() { setAllChecks("queue", false); };
document.getElementById("btnTrashSelAll").onclick = function() { setAllChecks("trash", true); };
document.getElementById("btnTrashSelNone").onclick = function() { setAllChecks("trash", false); };

document.getElementById("btnSendSel").onclick = function() {
  void sendIds(selectedFrom("queue"));
};
document.getElementById("btnSendAll").onclick = function() {
  void (async function() {
    var items = await storeAll("queue");
    var ids = items.map(function(x){ return x.id; }).filter(function(id){
      return !isInSendPipeline(id);
    });
    await sendIds(ids);
  })();
};
document.getElementById("btnCancelSel").onclick = function() {
  var ids = Array.from(document.querySelectorAll("#queue input[type=checkbox]:checked")).map(function(el) {
    return el.getAttribute("data-id");
  }).filter(Boolean);
  cancelSendIds(ids);
};
document.getElementById("btnDelSel").onclick = async function() {
  var ids = selectedFrom("queue");
  var all = await storeAll("queue");
  var byId = {};
  all.forEach(function(x){ byId[x.id] = x; });
  for (var i = 0; i < ids.length; i++) {
    var it = byId[ids[i]];
    if (!it) continue;
    it.trashedAt = Date.now();
    await storePut("trash", it);
    await storeDel("queue", ids[i]);
  }
  renderQueue();
  setStatus("已移入垃圾箱", "ok");
};
document.getElementById("btnRestore").onclick = async function() {
  var ids = selectedFrom("trash");
  var all = await storeAll("trash");
  var byId = {};
  all.forEach(function(x){ byId[x.id] = x; });
  for (var i = 0; i < ids.length; i++) {
    var it = byId[ids[i]];
    if (!it) continue;
    delete it.trashedAt;
    await storePut("queue", it);
    await storeDel("trash", ids[i]);
  }
  renderTrash();
  setStatus("已恢复到待发送", "ok");
};
document.getElementById("btnPurge").onclick = async function() {
  var ids = selectedFrom("trash");
  for (var i = 0; i < ids.length; i++) await storeDel("trash", ids[i]);
  renderTrash();
};
document.getElementById("btnEmpty").onclick = async function() {
  if (!confirm("清空垃圾箱？不可恢复")) return;
  var items = await storeAll("trash");
  for (var i = 0; i < items.length; i++) await storeDel("trash", items[i].id);
  renderTrash();
};

/* WAV capture (same as before, simplified) */
function micAvailable() {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== "function") {
    if (location.protocol === "http:") {
      return "HTTP 局域网地址下手机浏览器常禁止麦克风。请用文字/文件，或电脑生成 HTTPS 公网链接后再录音。";
    }
    return "浏览器未提供麦克风 API";
  }
  return "";
}
setMicWarn(micAvailable());

function encodeWavMono(samples, sampleRate) {
  var numChannels = 1, bitsPerSample = 16;
  var blockAlign = numChannels * bitsPerSample / 8;
  var byteRate = sampleRate * blockAlign;
  var dataSize = samples.length * 2;
  var buffer = new ArrayBuffer(44 + dataSize);
  var view = new DataView(buffer);
  function ws(off, s) { for (var i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); }
  ws(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); ws(8, "WAVE");
  ws(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true); view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true); view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true); ws(36, "data"); view.setUint32(40, dataSize, true);
  var offset = 44;
  for (var i = 0; i < samples.length; i++) {
    var s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}
function mergeFloat32(chunks) {
  var total = 0; for (var i = 0; i < chunks.length; i++) total += chunks[i].length;
  var out = new Float32Array(total); var off = 0;
  for (var j = 0; j < chunks.length; j++) { out.set(chunks[j], off); off += chunks[j].length; }
  return out;
}
var stream = null, captureStop = null, t0 = 0, tick = null;
var btnRec = document.getElementById("btnRec");
var btnStop = document.getElementById("btnStop");
var timerEl = document.getElementById("timer");
btnRec.onclick = async function() {
  var warn = micAvailable();
  if (warn && warn.indexOf("禁止麦克风") >= 0) { setStatus(warn, "err"); setMicWarn(warn); return; }
  if (warn) setMicWarn(warn);
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
    var AudioCtx = window.AudioContext || window.webkitAudioContext;
    var ctx = new AudioCtx();
    var source = ctx.createMediaStreamSource(stream);
    var processor = ctx.createScriptProcessor(4096, 1, 1);
    var chunks = []; var stopped = false;
    processor.onaudioprocess = function(ev) {
      if (stopped) return;
      chunks.push(new Float32Array(ev.inputBuffer.getChannelData(0)));
    };
    source.connect(processor);
    var gain = ctx.createGain(); gain.gain.value = 0;
    processor.connect(gain); gain.connect(ctx.destination);
    if (ctx.state === "suspended") await ctx.resume();
    captureStop = async function() {
      stopped = true;
      try { processor.disconnect(); source.disconnect(); gain.disconnect(); } catch (e) {}
      stream.getTracks().forEach(function(t) { t.stop(); });
      var sampleRate = ctx.sampleRate || 48000;
      await ctx.close().catch(function(){});
      var samples = mergeFloat32(chunks);
      if (samples.length < sampleRate * 0.15) throw new Error("录音太短");
      return encodeWavMono(samples, sampleRate);
    };
    t0 = Date.now(); btnRec.disabled = true; btnStop.disabled = false;
    setStatus("录音中…");
    tick = setInterval(function() {
      var s = Math.floor((Date.now() - t0) / 1000);
      timerEl.textContent = String(Math.floor(s/60)).padStart(2,"0") + ":" + String(s%60).padStart(2,"0");
    }, 200);
  } catch (e) {
    setStatus("无法开麦：" + (e.message || e), "err");
  }
};
var pendingVoice = null;
function setVoiceActions(enabled) {
  document.getElementById("btnVoiceCache").disabled = !enabled;
  document.getElementById("btnVoiceSend").disabled = !enabled;
  document.getElementById("btnVoiceInbox").disabled = !enabled;
}
function setVoiceReady(msg) {
  document.getElementById("voiceReady").textContent = msg || "";
}
setVoiceActions(false);

btnStop.onclick = async function() {
  if (!captureStop) return;
  btnStop.disabled = true;
  if (tick) clearInterval(tick);
  setStatus("处理录音…");
  try {
    var blob = await captureStop();
    captureStop = null; stream = null; btnRec.disabled = false;
    var b64 = await blobToBase64(blob);
    pendingVoice = {
      type: "voice",
      audioBase64: b64,
      mimeType: "audio/wav",
      title: "语音 " + new Date().toLocaleString(),
      createdAt: Date.now(),
    };
    setVoiceActions(true);
    setVoiceReady("录音完成，可：加入待发送 / 立即发送 / 仅收件箱");
    setStatus("录音完成，请选择发送方式", "ok");
  } catch (e) {
    btnRec.disabled = false;
    pendingVoice = null;
    setVoiceActions(false);
    setStatus(String(e.message || e), "err");
  } finally {
    captureStop = null; stream = null;
  }
};

document.getElementById("btnVoiceCache").onclick = async function() {
  if (!pendingVoice) return setStatus("请先录音", "err");
  await addQueueItem(Object.assign({}, pendingVoice));
  pendingVoice = null;
  setVoiceActions(false);
  setVoiceReady("");
  setStatus("语音已加入待发送", "ok");
};
document.getElementById("btnVoiceSend").onclick = async function() {
  if (!pendingVoice) return setStatus("请先录音", "err");
  if (!lanOk) {
    await addQueueItem(Object.assign({}, pendingVoice));
    pendingVoice = null;
    setVoiceActions(false);
    setVoiceReady("");
    setStatus("未连局域网：语音已缓存到待发送", "err");
    return;
  }
  setStatus("发送语音并整理…");
  try {
    var r = await sendOne(Object.assign({ notebook_id: selectedNb }, pendingVoice));
    pendingVoice = null;
    setVoiceActions(false);
    setVoiceReady("");
    setStatus("语音已写入：" + (r.title || r.path || "ok"), "ok");
    refreshRecent();
  } catch (e) {
    await addQueueItem(Object.assign({}, pendingVoice));
    pendingVoice = null;
    setVoiceActions(false);
    setVoiceReady("");
    setStatus("发送失败，已改存待发送：" + (e.message || e), "err");
  }
};
document.getElementById("btnVoiceInbox").onclick = async function() {
  if (!pendingVoice) return setStatus("请先录音", "err");
  if (!lanOk) {
    await addQueueItem(Object.assign({}, pendingVoice));
    pendingVoice = null;
    setVoiceActions(false);
    setVoiceReady("");
    setStatus("未连局域网：已缓存", "err");
    return;
  }
  try {
    var r = await api("/api/voice", {
      audioBase64: pendingVoice.audioBase64,
      mimeType: pendingVoice.mimeType || "audio/wav",
      organize: false,
      source: "mobile-web-voice",
      notebook_id: selectedNb,
    });
    pendingVoice = null;
    setVoiceActions(false);
    setVoiceReady("");
    setStatus("语音已进收件箱：" + (r.path || "ok"), "ok");
    refreshRecent();
  } catch (e) {
    setStatus(String(e.message || e), "err");
  }
};

async function processSelectedFiles(mode) {
  var input = document.getElementById("file");
  var files = input.files ? Array.from(input.files) : [];
  if (!files.length) return setStatus("请选择文件", "err");
  if (mode === "cache" || !lanOk) {
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      var b64 = await blobToBase64(f);
      await addQueueItem({
        type: "file",
        fileName: f.name,
        mimeType: f.type || "application/octet-stream",
        fileBase64: b64,
        title: f.name,
        size: f.size,
      });
    }
    input.value = "";
    setStatus((!lanOk && mode !== "cache" ? "未连局域网，已缓存 " : "已缓存 ") + files.length + " 个文件", !lanOk && mode !== "cache" ? "err" : "ok");
    return;
  }
  setStatus("发送文件中…");
  var ok = 0, fail = 0;
  for (var j = 0; j < files.length; j++) {
    try {
      var ff = files[j];
      var bb = await blobToBase64(ff);
      await api("/api/file", {
        fileBase64: bb,
        fileName: ff.name,
        mimeType: ff.type || "application/octet-stream",
        title: ff.name,
        notebook_id: selectedNb,
        capturedAt: Date.now(),
      });
      ok++;
    } catch (e) {
      fail++;
      try {
        var f2 = files[j];
        var b2 = await blobToBase64(f2);
        await addQueueItem({
          type: "file",
          fileName: f2.name,
          mimeType: f2.type || "application/octet-stream",
          fileBase64: b2,
          title: f2.name,
          size: f2.size,
        });
      } catch (e2) {}
    }
  }
  input.value = "";
  setStatus("文件完成：成功 " + ok + (fail ? "，失败并已缓存 " + fail : ""), ok ? "ok" : "err");
  refreshRecent();
}

document.getElementById("btnFileCache").onclick = function() { void processSelectedFiles("cache"); };
document.getElementById("btnFileSend").onclick = function() { void processSelectedFiles("send"); };
document.getElementById("btnFileInbox").onclick = function() { void processSelectedFiles("inbox"); };

async function refreshRecent() {
  if (!lanOk) return;
  try {
    var r = await api("/api/recent");
    var ul = document.getElementById("recent");
    ul.innerHTML = "";
    (r.items || []).forEach(function(it) {
      var li = document.createElement("li");
      var when = "";
      if (it.at) {
        try { when = new Date(it.at).toLocaleString(); } catch (e) { when = String(it.at); }
      }
      li.innerHTML = "<strong>" + esc(it.title) + "</strong>" +
        (it.organized ? '<span class="badge">AI</span>' : "") +
        (when ? "<div class='meta'>时间 " + esc(when) + "</div>" : "") +
        "<div class='meta'>" + esc(it.preview || "") + "</div>";
      ul.appendChild(li);
    });
  } catch (e) {}
}
document.getElementById("btnRefresh").onclick = function() { refreshRecent(); };

try { fillNotebooks(NOTEBOOKS, DEFAULT_NB); } catch (e) {}
// Page was served by desktop bridge with token => already connected (don't stick on 检测中)
(function bootLan() {
  var tok = TOKEN;
  try { if (!tok) tok = new URLSearchParams(location.search).get("t") || ""; } catch (e) {}
  if (tok && (location.protocol === "http:" || location.protocol === "https:")) {
    setLan(true);
    var _p = document.getElementById("lanPill");
    if (_p) { _p.textContent = "已连接电脑"; _p.className = "lan-pill lan-on"; }
  }
  refreshLan();
  setInterval(refreshLan, 8000);
  setTimeout(function(){ refreshLan(); }, 600);
})();
try { purgeExpiredTrash(); } catch (e) {}
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
