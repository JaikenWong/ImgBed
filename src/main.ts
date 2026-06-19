import "./styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { sendNotification } from "@tauri-apps/plugin-notification";
import { open } from "@tauri-apps/plugin-dialog";

interface UploadResult {
  url: string;
  cdn_url: string;
  filename: string;
}

interface UploadConfig {
  token: string;
  repo_owner: string;
  repo_name: string;
  branch: string;
  path_prefix: string;
  cdn_base: string;
}

const DEFAULTS: Omit<UploadConfig, "token"> = {
  repo_owner: "JaikenWong",
  repo_name: "Drawing-Bed",
  branch: "main",
  path_prefix: "images",
  cdn_base: "https://cdn.jsdelivr.net/gh",
};

const CONFIG_KEYS: (keyof Omit<UploadConfig, "token">)[] = [
  "repo_owner", "repo_name", "branch", "path_prefix", "cdn_base",
];

let watching = false;
let uploading = false;
let currentConfig: UploadConfig = { token: "", ...DEFAULTS };

const $ = <T extends HTMLElement>(sel: string): T =>
  document.querySelector<T>(sel)!;
const $$ = (sel: string) => document.querySelectorAll<HTMLElement>(sel);

// ═══ Config ═══
async function loadConfig(): Promise<void> {
  try {
    const token = await invoke<string | null>("get_config", { key: "github_token" });
    currentConfig.token = token || "";
  } catch {
    currentConfig.token = "";
  }

  for (const key of CONFIG_KEYS) {
    try {
      const val = await invoke<string | null>("get_config", { key });
      if (val) (currentConfig as Record<string, string>)[key] = val;
    } catch { /* keep default */ }
  }

  // Fill UI
  const tokenInput = $("input#tokenInput") as HTMLInputElement;
  tokenInput.value = currentConfig.token ? maskToken(currentConfig.token) : "";

  ($("input#repoOwnerInput") as HTMLInputElement).value = currentConfig.repo_owner;
  ($("input#repoNameInput") as HTMLInputElement).value = currentConfig.repo_name;
  ($("input#branchInput") as HTMLInputElement).value = currentConfig.branch;
  ($("input#pathPrefixInput") as HTMLInputElement).value = currentConfig.path_prefix;
  ($("input#cdnBaseInput") as HTMLInputElement).value = currentConfig.cdn_base;

  updateTokenStatus(currentConfig.token ? "configured" : "", currentConfig.token ? "已配置" : "未配置");
}

function readConfigFromUI(): UploadConfig {
  const tokenInput = $("input#tokenInput") as HTMLInputElement;
  const raw = tokenInput.value.trim();
  // If masked, keep current; otherwise use raw
  const token = raw.includes("•") ? currentConfig.token : raw;

  return {
    token,
    repo_owner: ($("input#repoOwnerInput") as HTMLInputElement).value.trim() || DEFAULTS.repo_owner,
    repo_name: ($("input#repoNameInput") as HTMLInputElement).value.trim() || DEFAULTS.repo_name,
    branch: ($("input#branchInput") as HTMLInputElement).value.trim() || DEFAULTS.branch,
    path_prefix: ($("input#pathPrefixInput") as HTMLInputElement).value.trim() || DEFAULTS.path_prefix,
    cdn_base: ($("input#cdnBaseInput") as HTMLInputElement).value.trim() || DEFAULTS.cdn_base,
  };
}

async function saveAllConfig(): Promise<void> {
  const cfg = readConfigFromUI();
  try {
    if (cfg.token) await invoke("set_config", { key: "github_token", value: cfg.token });
    for (const key of CONFIG_KEYS) {
      await invoke("set_config", { key, value: (cfg as Record<string, string>)[key] });
    }
    currentConfig = cfg;
    // Re-mask token in UI
    ($("input#tokenInput") as HTMLInputElement).value = maskToken(cfg.token);
    updateTokenStatus("configured", "已保存");
    showToast("配置已保存", "success");
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    showToast(`保存失败: ${msg}`, "error");
  }
}

// ═══ Token ═══
async function testConnection(): Promise<void> {
  const cfg = readConfigFromUI();
  if (!cfg.token) {
    showToast("请输入 Token", "error");
    return;
  }

  updateTokenStatus("testing", "测试中...");
  const btn = $("button#testTokenBtn") as HTMLButtonElement;
  btn.disabled = true;

  try {
    const resp = await fetch("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${cfg.token}`, "User-Agent": "imgbed-app" },
    });
    if (resp.ok) {
      const data = await resp.json();
      // Token works, auto-save
      currentConfig = cfg;
      await invoke("set_config", { key: "github_token", value: cfg.token });
      for (const key of CONFIG_KEYS) {
        await invoke("set_config", { key, value: (cfg as Record<string, string>)[key] });
      }
      ($("input#tokenInput") as HTMLInputElement).value = maskToken(cfg.token);
      updateTokenStatus("configured", `✓ ${data.login}`);
      showToast("连接成功，配置已保存", "success");
    } else {
      updateTokenStatus("error", "Token 无效");
      showToast("Token 验证失败", "error");
    }
  } catch {
    updateTokenStatus("error", "网络错误");
    showToast("网络连接失败", "error");
  } finally {
    btn.disabled = false;
  }
}

function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "•".repeat(token.length);
  return token.slice(0, 4) + "•".repeat(token.length - 8) + token.slice(-4);
}

function updateTokenStatus(state: string, text: string) {
  const indicator = $(".status-indicator");
  const label = $(".token-status .status-text");
  indicator.className = `status-indicator ${state}`;
  label.textContent = text;
}

// ═══ Upload ═══
async function uploadClipboardImage() {
  if (uploading) return;
  if (!currentConfig.token) {
    showToast("请先在设置中配置 Token", "error");
    switchTab("settings");
    return;
  }

  uploading = true;
  const portal = $(".upload-portal") as HTMLElement;
  const progress = $(".upload-progress") as HTMLElement;
  portal.style.display = "none";
  progress.style.display = "flex";

  try {
    // Try clipboard first
    const result = await invoke<UploadResult>("upload_clipboard_image", {
      config: currentConfig,
    });
    history.unshift(result);
    if (history.length > 20) history.pop();
    renderHistory();
    await writeText(result.cdn_url);
    showToast("链接已复制到剪贴板", "success");
    await sendNotification({ title: "ImgBed", body: "图片已上传，链接已复制" });
  } catch {
    // Clipboard has no image → open file picker
    try {
      const selected = await open({
        multiple: true,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"] }],
      });
      if (!selected) {
        showToast("未选择文件", "info");
        return;
      }
      const paths = Array.isArray(selected) ? selected : [selected];
      for (const filePath of paths) {
        const result = await invoke<UploadResult>("upload_file", {
          config: currentConfig,
          path: filePath,
        });
        history.unshift(result);
        if (history.length > 20) history.pop();
        await writeText(result.cdn_url);
      }
      renderHistory();
      showToast("链接已复制到剪贴板", "success");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`上传失败: ${msg}`, "error");
    }
  } finally {
    uploading = false;
    portal.style.display = "";
    progress.style.display = "none";
  }
}

async function handleFileDrop(files: FileList) {
  if (!currentConfig.token) {
    showToast("请先在设置中配置 Token", "error");
    switchTab("settings");
    return;
  }

  for (const file of Array.from(files)) {
    if (!file.type.startsWith("image/")) continue;
    try {
      const result = await invoke<UploadResult>("upload_file", {
        config: currentConfig,
        path: (file as File & { path?: string }).path || file.name,
      });
      history.unshift(result);
      renderHistory();
      await writeText(result.cdn_url);
      showToast("链接已复制到剪贴板", "success");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      showToast(`上传失败: ${msg}`, "error");
    }
  }
}

// ═══ Clipboard Watch ═══
async function toggleWatch() {
  const toggle = $(".watch-toggle");
  if (watching) {
    await invoke("stop_watching");
    watching = false;
    toggle.classList.remove("active");
  } else {
    await invoke("watch_clipboard");
    watching = true;
    toggle.classList.add("active");
  }
}

// ═══ History ═══
function renderHistory() {
  const list = $(".history-list");
  const count = $("span#historyCount");
  count.textContent = String(history.length);

  if (history.length === 0) {
    list.innerHTML = `
      <div class="history-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" opacity="0.3">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
        <span>暂无记录</span>
      </div>`;
    return;
  }

  list.innerHTML = history
    .map(
      (item, i) => `
    <div class="history-item" style="animation-delay: ${i * 0.04}s">
      <div class="history-item-icon">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      </div>
      <div class="history-item-info">
        <div class="history-item-name">${item.filename}</div>
        <div class="history-item-url">${item.cdn_url}</div>
      </div>
      <button class="history-copy-btn" data-url="${item.cdn_url}" title="复制链接">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
        </svg>
      </button>
    </div>`
    )
    .join("");

  list.querySelectorAll(".history-copy-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const url = (btn as HTMLElement).dataset.url!;
      await writeText(url);
      btn.classList.add("copied");
      showToast("已复制", "success");
      setTimeout(() => btn.classList.remove("copied"), 1500);
    });
  });
}

// ═══ Tab Navigation ═══
function switchTab(tab: string) {
  $$(".tab-item").forEach((t) => {
    t.classList.toggle("active", t.dataset.tab === tab);
  });
  $$(".page").forEach((p) => {
    p.classList.toggle("active", p.dataset.page === tab);
  });
}

// ═══ Toast ═══
function showToast(msg: string, type: "success" | "error" | "info" = "info") {
  const container = $("div#toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = msg;
  container.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("exit");
    setTimeout(() => toast.remove(), 250);
  }, 2200);
}

// ═══ Token Visibility ═══
function setupTokenVisibility() {
  const btn = $("button#tokenVisibilityBtn");
  const input = $("input#tokenInput") as HTMLInputElement;
  const eyeOpen = btn.querySelector(".eye-open") as HTMLElement;
  const eyeClosed = btn.querySelector(".eye-closed") as HTMLElement;
  let visible = false;

  btn.addEventListener("click", () => {
    visible = !visible;
    input.type = visible ? "text" : "password";
    eyeOpen.style.display = visible ? "none" : "";
    eyeClosed.style.display = visible ? "" : "none";
    if (visible && currentConfig.token) {
      input.value = currentConfig.token;
    } else if (currentConfig.token) {
      input.value = maskToken(currentConfig.token);
    }
  });
}

// ═══ Drag & Drop ═══
function setupDragDrop() {
  const portal = $(".upload-portal");

  portal.addEventListener("dragover", (e) => {
    e.preventDefault();
    portal.classList.add("dragover");
  });

  portal.addEventListener("dragleave", () => {
    portal.classList.remove("dragover");
  });

  portal.addEventListener("drop", (e) => {
    e.preventDefault();
    portal.classList.remove("dragover");
    const files = (e as DragEvent).dataTransfer?.files;
    if (files?.length) handleFileDrop(files);
  });

  portal.addEventListener("click", uploadClipboardImage);
}

// ═══ Init ═══
async function init() {
  await loadConfig();

  await listen("clipboard-image-detected", async () => {
    if (uploading) return;
    await uploadClipboardImage();
  });

  $$(".tab-item").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab!));
  });

  $(".watch-toggle").addEventListener("click", toggleWatch);

  // Settings: test first, then auto-save on success
  $("button#testTokenBtn").addEventListener("click", testConnection);
  // Save button for manual save (e.g. only changed repo config)
  $("button#saveTokenBtn").addEventListener("click", saveAllConfig);

  setupTokenVisibility();
  setupDragDrop();
  renderHistory();
}

document.addEventListener("DOMContentLoaded", init);
