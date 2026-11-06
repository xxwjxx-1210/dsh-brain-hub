/**
 * dsh-brain-hub — 记忆库总控（Host）
 *
 * 一个包顶三件事：
 *   1. 记忆库：MEMORY.md + notes/*.md + index.json，git 自动 commit/push；
 *   2. 卡片收件箱：网页版拆好的卡片先落 inbox/，勾选后再进 notes/；
 *   3. 网页版笔记：侧栏网页版「存记忆」写进来的 progress.md（带历史滚动）。
 *
 * 这个文件只做宿主侧；面板在 dist/client.cjs。
 */
import { promises as fs } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const execFileAsync = promisify(execFile);

export const name = "dsh-brain-hub";
export const inject = ["systemPrompt", "tools", "connection"];

const RPC_PATH = "/api/plugin-rpc/brain-hub";
const RPC_METHOD = "plugin-rpc/brain-hub";
const HISTORY_KEEP = 20;

const DEFAULTS = {
  memoryDir: "",
  notesDir: "",
  remote: "",
  branch: "main",
  role: "primary",
  coreLimit: 3000,
  recentLimit: 6,
  autoPull: true,
  autoPush: true,
  injectProgress: true,
  readOnly: false,
  commitMessage: "memory: {tool}",
  backend: "git", // git | folder | local
};

/** 云端模式：git = 仓库 + 远端；folder = 被 OneDrive/坚果云等同步的文件夹；local = 只在本机。 */
function syncMode(config) {
  const raw = String(config.backend || "git").trim().toLowerCase();
  if (raw === "folder" || raw === "onedrive" || raw === "sync") return "folder";
  if (raw === "local" || raw === "none" || raw === "off") return "local";
  return "git";
}

/* ------------------------------- paths ------------------------------- */

function home() {
  return os.homedir();
}

function resolvePaths(config) {
  const dshHome = process.env.DSH_HOME?.trim() || path.join(home(), ".dsh");
  const memoryDir = path.resolve(config.memoryDir?.trim() || path.join(dshHome, "memory"));
  const notesDir = path.resolve(config.notesDir?.trim() || path.join(dshHome, "dsh_memory"));
  return {
    memoryDir,
    notesDir,
    coreFile: path.join(memoryDir, "MEMORY.md"),
    notes: path.join(memoryDir, "notes"),
    priv: path.join(memoryDir, "private"),
    inbox: path.join(memoryDir, "inbox"),
    indexFile: path.join(memoryDir, "index.json"),
    progressFile: path.join(notesDir, "progress.md"),
    history: path.join(notesDir, "history"),
  };
}

async function ensureDirs(p) {
  await fs.mkdir(p.notes, { recursive: true });
  await fs.mkdir(p.priv, { recursive: true });
  await fs.mkdir(p.inbox, { recursive: true });
  await fs.mkdir(p.history, { recursive: true });
  await ensureGitignore(p);
}

/** private/ 永不进 git：客户名、报价、内部数据都放这里。 */
async function ensureGitignore(p) {
  const file = path.join(p.memoryDir, ".gitignore");
  const text = await fs.readFile(file, "utf8").catch(() => "");
  if (/^private\/?\s*$/m.test(text)) return;
  const next = `${text}${text.endsWith("\n") || text.length === 0 ? "" : "\n"}# 只存本地、永不推送到 GitHub\nprivate/\n`;
  await fs.writeFile(file, next, "utf8").catch(() => {});
}

/* ------------------------------- git ------------------------------- */

async function git(dir, args, timeout = 120000) {
  try {
    const { stdout, stderr } = await execFileAsync("git", ["-C", dir, ...args], {
      timeout,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
      maxBuffer: 8 * 1024 * 1024,
    });
    return { ok: true, out: `${stdout || ""}${stderr || ""}`.trim() };
  } catch (error) {
    const out = `${error.stdout || ""}${error.stderr || ""}`.trim() || String(error.message || error);
    return { ok: false, out };
  }
}

async function isRepo(dir) {
  return (await git(dir, ["rev-parse", "--is-inside-work-tree"])).ok;
}

async function pathExists(target) {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

async function commitAndPush(p, config, tool) {
  if (config.readOnly) return { ok: true, skipped: "readOnly" };
  const mode = syncMode(config);
  if (mode === "folder") return { ok: true, message: `已保存到 ${p.memoryDir}，这个文件夹在你的同步盘里` };
  if (mode === "local") return { ok: true, message: "已保存到本机（当前是只存本地模式）" };
  const wanted = ["MEMORY.md", "notes", "inbox", "index.json", "prompts", "hub.json"];
  const present = [];
  for (const name of wanted) {
    if (await pathExists(path.join(p.memoryDir, name))) present.push(name);
  }
  if (present.length === 0) return { ok: true, noop: true, message: "记忆库还是空的，没有可提交的内容" };
  const add = await git(p.memoryDir, ["add", "-A", "--", ...present]);
  if (!add.ok) return { ok: false, message: add.out };

  const message = String(config.commitMessage || DEFAULTS.commitMessage).replace("{tool}", tool);
  const commit = await git(p.memoryDir, ["commit", "-m", message]);
  if (!commit.ok) {
    if (/nothing (?:added )?to commit|no changes added|无文件要提交/i.test(commit.out)) {
      return { ok: true, noop: true, message: "没有新改动" };
    }
    return { ok: false, message: commit.out };
  }
  if (!config.autoPush) return { ok: true, message: "已提交（未推送）" };
  if (!(await isRepo(p.memoryDir))) return { ok: true, message: "已提交（不是 git 仓库，未推送）" };

  let last = { ok: false, out: "" };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    last = await git(p.memoryDir, ["push", "origin", `HEAD:${config.branch || "main"}`], 180000);
    if (last.ok) return { ok: true, message: `已提交并推送：${message}` };
    if (attempt < 3) await new Promise((r) => setTimeout(r, 3000));
  }
  return { ok: false, message: `已提交，推送失败：${last.out}`, needsPushRetry: true };
}

/* ----------------------------- core memory ----------------------------- */

async function readCore(p) {
  try {
    return await fs.readFile(p.coreFile, "utf8");
  } catch {
    return "";
  }
}

function splitSections(text) {
  const lines = String(text || "").split(/\r?\n/);
  const head = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    const match = /^##\s+(.+?)\s*$/.exec(line);
    if (match) {
      current = { title: match[1], body: [] };
      sections.push(current);
      continue;
    }
    if (current) current.body.push(line);
    else head.push(line);
  }
  return { head: head.join("\n").trim(), sections };
}

function joinSections(head, sections) {
  const parts = [];
  if (head) parts.push(head);
  for (const section of sections) {
    parts.push(`## ${section.title}\n${section.body.join("\n").trim()}`.trim());
  }
  return `${parts.join("\n\n")}\n`;
}

async function coreAction(p, action, section, text) {
  const raw = await readCore(p);
  const { head, sections } = splitSections(raw || "# 核心记忆\n");
  const title = String(section || "").trim();
  const index = sections.findIndex((s) => s.title === title);

  if (action === "append") {
    const addition = String(text || "").trim();
    if (!title) return { ok: false, message: "append 需要 section" };
    if (index >= 0) {
      const body = sections[index].body.join("\n").trim();
      sections[index].body = [`${body}\n${addition}`.trim().split("\n")];
    } else {
      sections.push({ title, body: addition.split("\n") });
    }
  } else if (action === "replace") {
    if (!title) return { ok: false, message: "replace 需要 section" };
    if (index >= 0) sections[index].body = String(text || "").trim().split("\n");
    else sections.push({ title, body: String(text || "").trim().split("\n") });
  } else if (action === "remove") {
    if (index < 0) return { ok: false, message: `没有分节：${title}` };
    sections.splice(index, 1);
  } else {
    return { ok: false, message: `未知 action：${action}` };
  }

  const next = joinSections(head, sections);
  await fs.writeFile(p.coreFile, next, "utf8");
  return { ok: true, message: `已${action}分节「${title}」，核心记忆 ${next.length} 字符` };
}

/* ------------------------------- notes ------------------------------- */

function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() +
    pad(date.getMonth() + 1) +
    pad(date.getDate()) +
    "-" +
    pad(date.getHours()) +
    pad(date.getMinutes()) +
    pad(date.getSeconds())
  );
}

function slugify(title) {
  return (
    String(title)
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 40) || "card"
  );
}

function parseTags(raw) {
  if (Array.isArray(raw)) return raw.map((t) => String(t).replace(/^#/, "").trim()).filter(Boolean);
  const text = String(raw || "").trim().replace(/^\[/, "").replace(/\]$/, "");
  return text
    .split(/[,，、]/)
    .map((tag) => tag.trim().replace(/^#/, ""))
    .filter(Boolean);
}

function parseNote(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(String(text || ""));
  const meta = {};
  let body = String(text || "");
  if (match) {
    body = match[2];
    for (const line of match[1].split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  let title = meta.title ? meta.title.replace(/^"|"$/g, "") : "";
  if (!title) {
    const heading = /^#\s+(.+)$/m.exec(body);
    if (heading) title = heading[1].trim();
  }
  return {
    meta,
    title: title || "未命名记忆",
    tags: parseTags(meta.tags),
    uploaded: String(meta.uploaded || "").toLowerCase() === "true",
    body: body.trim(),
  };
}

function buildNote({ id, title, tags, body, created, updated, uploaded }) {
  const now = new Date().toISOString();
  const head = body.startsWith("# ") ? body : `# ${title}\n\n${body}`.trim();
  return [
    "---",
    `id: ${id}`,
    `title: ${JSON.stringify(title)}`,
    `tags: ${(tags || []).join(", ")}`,
    `created: ${created || now}`,
    `updated: ${updated || now}`,
    `uploaded: ${uploaded ? "true" : "false"}`,
    "---",
    "",
    head,
    "",
  ].join("\n");
}

async function listNoteFiles(dir) {
  const entries = await fs.readdir(dir).catch(() => []);
  return entries.filter((f) => f.toLowerCase().endsWith(".md"));
}

async function readNotes(dir, local = false) {
  const files = await listNoteFiles(dir);
  const notes = [];
  for (const file of files) {
    const full = path.join(dir, file);
    try {
      const text = await fs.readFile(full, "utf8");
      const parsed = parseNote(text);
      const stat = await fs.stat(full);
      notes.push({
        id: parsed.meta.id || file.replace(/\.md$/i, ""),
        file,
        title: parsed.title,
        tags: parsed.tags,
        created: parsed.meta.created || "",
        updated: parsed.meta.updated || "",
        uploaded: parsed.uploaded,
        local,
        size: stat.size,
        mtime: stat.mtimeMs,
        body: parsed.body,
      });
    } catch {
      /* 读坏了就跳过 */
    }
  }
  notes.sort((a, b) => b.mtime - a.mtime);
  return notes;
}

/** 云端 notes + 只存本地的 private，合成一份给搜索/列表用。 */
async function readAllNotes(p) {
  const [cloud, priv] = await Promise.all([readNotes(p.notes, false), readNotes(p.priv, true)]);
  return [...cloud, ...priv].sort((a, b) => b.mtime - a.mtime);
}

/** 归一化标题，用来判断"这张卡是不是已经存过了"。 */
function titleKey(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/[（(][^）)]*[）)]/g, "")
    .replace(/[\s·:：,，。.、!！?？"'“”‘’\-—_/\\|()[\]{}<>《》]/g, "")
    .trim();
}

/** 已经入库（云端 + 本地）的标题索引。 */
async function knownTitles(p) {
  const notes = await readAllNotes(p);
  const map = new Map();
  for (const note of notes) {
    const key = titleKey(note.title);
    if (key && !map.has(key)) map.set(key, { title: note.title, local: note.local === true });
  }
  return map;
}

async function rebuildIndex(p, notes) {
  const index = {
    version: 1,
    notes: notes.map((n) => ({
      id: n.id,
      title: n.title,
      tags: n.tags,
      created: n.created,
      updated: n.updated,
      local: n.local === true,
      size: n.size,
    })),
  };
  await fs.writeFile(p.indexFile, `${JSON.stringify(index, null, 2)}\n`, "utf8").catch(() => {});
}

function scoreNote(note, terms) {
  const title = note.title.toLowerCase();
  const tags = note.tags.join(" ").toLowerCase();
  const body = (note.body || "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 5;
    if (tags.includes(term)) score += 3;
    if (body.includes(term)) score += 1;
  }
  return score;
}

function snippet(body, terms, limit = 160) {
  const flat = String(body || "").replace(/\s+/g, " ").trim();
  const hit = terms.map((t) => flat.toLowerCase().indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0];
  if (hit === undefined) return flat.slice(0, limit);
  const start = Math.max(0, hit - 40);
  return `${start > 0 ? "…" : ""}${flat.slice(start, start + limit)}`;
}

/* ----------------------------- web notes ----------------------------- */

async function writeProgress(p, text, meta = {}) {
  const content = String(text || "").trim();
  if (content.length === 0) return { ok: false, message: "内容为空" };
  const cut = content.length > 1800 ? `${content.slice(0, 1800)}\n\n…（已截断）` : content;
  const current = await fs.readFile(p.progressFile, "utf8").catch(() => "");
  if (current.trim()) {
    const archive = path.join(p.history, `progress-${stamp()}.md`);
    await fs.writeFile(archive, current, "utf8").catch(() => {});
    const olds = (await fs.readdir(p.history).catch(() => []))
      .filter((f) => /^progress-\d{8}-\d{6}\.md$/.test(f))
      .sort();
    for (const stale of olds.slice(0, Math.max(0, olds.length - HISTORY_KEEP))) {
      await fs.rm(path.join(p.history, stale), { force: true }).catch(() => {});
    }
  }
  const head = [
    `<!-- saved ${new Date().toISOString()}${meta.source ? ` from ${meta.source}` : ""} -->`,
    "",
  ].join("\n");
  await fs.writeFile(p.progressFile, `${head}${cut}\n`, "utf8");
  return { ok: true, chars: cut.length, file: p.progressFile };
}

async function readProgress(p) {
  const text = await fs.readFile(p.progressFile, "utf8").catch(() => "");
  const stat = await fs.stat(p.progressFile).catch(() => null);
  return { text, updated: stat ? stat.mtime.toISOString() : null, chars: text.length };
}

async function recentProgress(p, limit = 5) {
  const files = (await fs.readdir(p.history).catch(() => []))
    .filter((f) => /^progress-.*\.md$/.test(f))
    .sort()
    .reverse()
    .slice(0, limit);
  const rows = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(p.history, file), "utf8").catch(() => "");
    rows.push({ file, preview: text.replace(/\s+/g, " ").slice(0, 120) });
  }
  return rows;
}

/* ------------------------------- cards ------------------------------- */

function splitCardBlock(raw) {
  const lines = String(raw || "").split(/\r?\n/);
  let title = "";
  let tags = [];
  const seenBody = [];
  for (const line of lines) {
    const titleMatch = /^title:\s*(.+)$/i.exec(line);
    if (titleMatch && seenBody.length === 0 && title === "") {
      title = titleMatch[1].trim().replace(/^["']|["']$/g, "");
      continue;
    }
    const tagsMatch = /^tags:\s*(.+)$/i.exec(line);
    if (tagsMatch && seenBody.length === 0 && tags.length === 0) {
      tags = parseTags(tagsMatch[1]);
      continue;
    }
    seenBody.push(line);
  }
  let body = seenBody.join("\n").trim();
  if (!title) {
    const heading = /^#\s+(.+)$/m.exec(body);
    if (heading) {
      title = heading[1].trim();
      body = body.replace(/^#\s+.+\r?\n?/, "").trim();
    }
  }
  if (!title) title = (body.split(/\r?\n/)[0] || "未命名卡片").slice(0, 40).trim() || "未命名卡片";
  return { title, tags, body };
}

function parseCards(text) {
  const cards = [];
  const re = /---CARD---([\s\S]*?)---END---/g;
  let match = re.exec(String(text || ""));
  while (match !== null) {
    const block = match[1].trim();
    if (block.length > 0) cards.push(splitCardBlock(block));
    match = re.exec(text);
  }
  return cards;
}

async function inboxList(p) {
  const files = await listNoteFiles(p.inbox);
  const known = await knownTitles(p);
  const cards = [];
  for (const file of files) {
    const full = path.join(p.inbox, file);
    try {
      const text = await fs.readFile(full, "utf8");
      const parsed = parseNote(text);
      const stat = await fs.stat(full);
      const knownHit = known.get(titleKey(parsed.title));
      cards.push({
        file,
        title: parsed.title,
        tags: parsed.tags,
        uploaded: parsed.uploaded,
        exists: Boolean(knownHit),
        existsLocal: knownHit ? knownHit.local : false,
        size: stat.size,
        mtime: stat.mtimeMs,
        preview: parsed.body.replace(/\s+/g, " ").slice(0, 160),
      });
    } catch (error) {
      cards.push({ file, title: file, tags: [], uploaded: false, exists: false, size: 0, mtime: 0, preview: String(error.message) });
    }
  }
  cards.sort((a, b) => b.mtime - a.mtime);
  return {
    cards,
    knownTitles: [...known.values()].map((entry) => entry.title).slice(0, 200),
    stats: {
      total: cards.length,
      pending: cards.filter((c) => !c.uploaded).length,
      pendingFresh: cards.filter((c) => !c.uploaded && !c.exists).length,
      uploaded: cards.filter((c) => c.uploaded).length,
      duplicates: cards.filter((c) => c.exists && !c.uploaded).length,
      notes: (await listNoteFiles(p.notes)).length,
      localNotes: (await listNoteFiles(p.priv)).length,
    },
  };
}

const TEMPLATE_MARKS = [
  "动宾短语",
  "对象 + 结论",
  "对象+结论",
  "一句话说清：做什么、怎么判",
  "什么条件下成立；什么情况下不适用",
  "另一张卡的标题",
  "相关的已存在概念",
  "本段对话里出现过的已有概念",
  "3–5 个",
  "2–5 条关键事实",
];

function looksLikeTemplate(card) {
  const title = String(card.title || "");
  const body = String(card.body || "");
  if (/动宾短语|对象\s*\+\s*结论/.test(title)) return true;
  const haystack = `${title}\n${body}`;
  return TEMPLATE_MARKS.filter((mark) => haystack.includes(mark)).length >= 3;
}

async function inboxSave(p, text) {
  const cards = parseCards(text);
  if (cards.length === 0) return { saved: [], skipped: [], message: "没找到 ---CARD--- … ---END--- 包裹的卡片" };
  const existing = new Set((await listNoteFiles(p.inbox)).map((f) => f.toLowerCase()));
  const known = await knownTitles(p);
  for (const file of existing) {
    try {
      const text = await fs.readFile(path.join(p.inbox, file), "utf8");
      const title = parseNote(text).title;
      const key = titleKey(title);
      if (key && !known.has(key)) known.set(key, { title, local: false });
    } catch (error) {
      /* 坏文件不影响保存 */
    }
  }
  const saved = [];
  const skipped = [];
  for (const card of cards) {
    if (looksLikeTemplate(card)) {
      skipped.push({ title: card.title, reason: "把模板本身当成了卡片" });
      continue;
    }
    const key = titleKey(card.title);
    const id = `${stamp()}-${slugify(card.title)}`;
    let file = `${id}.md`;
    let seq = 2;
    while (existing.has(file.toLowerCase())) {
      file = `${id}-${seq}.md`;
      seq += 1;
    }
    await fs.writeFile(
      path.join(p.inbox, file),
      buildNote({ id, title: card.title, tags: card.tags, body: card.body, uploaded: false }),
      "utf8"
    );
    existing.add(file.toLowerCase());
    if (key) known.set(key, { title: card.title, local: false });
    saved.push({ file, title: card.title });
  }
  return { saved, skipped, stats: { parsed: cards.length, saved: saved.length, skipped: skipped.length } };
}

async function inboxRead(p, file) {
  const safe = path.basename(String(file || ""));
  if (!safe) throw new Error("缺少卡片文件名");
  const text = await fs.readFile(path.join(p.inbox, safe), "utf8");
  const parsed = parseNote(text);
  return {
    file: safe,
    id: parsed.meta.id || safe.replace(/\.md$/i, ""),
    title: parsed.title,
    tags: parsed.tags,
    body: parsed.body,
    uploaded: parsed.uploaded,
    created: parsed.meta.created,
    updated: parsed.meta.updated,
  };
}

async function inboxUpdate(p, file, patch = {}) {
  const card = await inboxRead(p, file);
  const title = typeof patch.title === "string" && patch.title.trim() ? patch.title.trim().slice(0, 120) : card.title;
  const tags = Array.isArray(patch.tags)
    ? patch.tags.map((t) => String(t).trim()).filter(Boolean)
    : typeof patch.tags === "string"
      ? patch.tags.split(/[,，\s]+/).map((t) => t.trim()).filter(Boolean)
      : card.tags;
  const body = typeof patch.body === "string" && patch.body.trim() ? patch.body : card.body;
  const text = buildNote({
    id: card.id,
    title,
    tags,
    body,
    created: card.created,
    updated: stamp(),
    uploaded: card.uploaded,
  });
  await fs.writeFile(path.join(p.inbox, card.file), text, "utf8");
  return inboxRead(p, card.file);
}

async function inboxDiscard(p, files) {
  const list = Array.isArray(files) ? files : [files];
  const removed = [];
  for (const file of list) {
    const safe = path.basename(String(file || ""));
    if (!safe) continue;
    const full = path.join(p.inbox, safe);
    const ok = await fs.rm(full, { force: true }).then(() => true).catch(() => false);
    if (ok) removed.push(safe);
  }
  return { removed, message: removed.length ? `已丢弃 ${removed.length} 张卡片` : "没有可丢弃的卡片" };
}

async function inboxUpload(p, config, files, options = {}) {
  const list = Array.isArray(files) ? files.filter((f) => typeof f === "string" && f.trim()) : [];
  if (list.length === 0) return { ok: false, message: "没有选中要保存的卡片" };
  const local = options.local === true;
  const target = local ? p.priv : p.notes;
  await fs.mkdir(target, { recursive: true });
  const staged = [];
  const problems = [];
  for (const file of list) {
    const safe = path.basename(file);
    const from = path.join(p.inbox, safe);
    const to = path.join(target, safe);
    const text = await fs.readFile(from, "utf8").catch(() => null);
    if (text === null) {
      problems.push({ file: safe, reason: "收件箱里找不到" });
      continue;
    }
    const parsed = parseNote(text);
    const noteText = buildNote({
      id: parsed.meta.id || safe.replace(/\.md$/i, ""),
      title: parsed.title,
      tags: parsed.tags,
      body: parsed.body,
      created: parsed.meta.created,
      updated: parsed.meta.updated,
      uploaded: true,
    });
    await fs.writeFile(to, noteText, "utf8");
    await fs.writeFile(from, noteText, "utf8");
    staged.push({ file: safe, title: parsed.title, local });
  }
  if (staged.length === 0) return { ok: false, message: problems[0]?.reason || "没有可保存的卡片", problems };

  await rebuildIndex(p, await readAllNotes(p));

  if (local) {
    return {
      ok: true,
      message: `已保存 ${staged.length} 张到本地（不进 GitHub）`,
      staged,
      problems,
    };
  }

  const result = await commitAndPush(p, config, "card-inbox");
  if (!result.ok) {
    return { ok: false, message: result.message, problems, staged, needsPushRetry: result.needsPushRetry };
  }
  return { ok: true, message: `已上传 ${staged.length} 张卡片（${result.message}）`, staged, problems };
}

/* ------------------------------- rpc ------------------------------- */

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const success = (rpcId, value) => jsonResponse({ type: "server-response", rpcId, result: { ok: true, value } });
const failure = (rpcId, code, message) =>
  jsonResponse({ type: "server-response", rpcId, result: { ok: false, error: { code, message, details: {} } } });

async function memoryStatus(p, config) {
  const all = await readAllNotes(p);
  const cloud = all.filter((n) => !n.local);
  const localOnly = all.filter((n) => n.local);
  const core = await readCore(p);
  const inbox = await inboxList(p);
  const repo = await isRepo(p.memoryDir);
  const status = repo ? await git(p.memoryDir, ["status", "--porcelain"]) : { ok: false, out: "" };
  const remote = repo ? await git(p.memoryDir, ["remote", "get-url", "origin"]) : { ok: false, out: "" };
  const last = repo ? await git(p.memoryDir, ["log", "-1", "--pretty=%h %s"]) : { ok: false, out: "" };
  const ahead = repo
    ? await git(p.memoryDir, ["rev-list", "--count", `origin/${config.branch || "main"}..HEAD`])
    : { ok: false, out: "0" };
  return {
    backend: syncMode(config),
    memoryDir: p.memoryDir,
    notesDir: p.notesDir,
    isRepo: repo,
    remote: remote.ok ? remote.out.trim() : "",
    branch: config.branch,
    lastCommit: last.ok ? last.out.trim() : "",
    dirty: status.ok ? status.out.trim().split("\n").filter(Boolean).length : 0,
    ahead: ahead.ok ? Number(ahead.out.trim()) || 0 : 0,
    core: core.trim(),
    coreChars: core.trim().length,
    notes: cloud.length,
    localNotes: localOnly.length,
    inbox: inbox.stats,
  };
}

function hubView(config, settings) {
  return {
    title: String(settings.title || ""),
    onboarded: settings.onboarded === true,
    backend: syncMode(config),
  };
}

async function readHubSettings(p) {
  try {
    const raw = await fs.readFile(path.join(p.memoryDir, "hub.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeHubSettings(p, patch) {
  const current = await readHubSettings(p);
  const next = { ...current, ...patch };
  await fs.mkdir(p.memoryDir, { recursive: true });
  await fs.writeFile(path.join(p.memoryDir, "hub.json"), `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

/* ---------------------------- 提炼提示词 ---------------------------- */

const DISTILL_FALLBACK = "你是我的知识收件箱助手。把我们这段对话整理成「以后还用得上」的卡片，直接写进我的记忆库。\n\n【先判断值不值得存】问三个问题，全是否就只输出 NO_CARDS：\n1. 三个月后我还会再查这件事吗？\n2. 不查资料，我自己想得起来吗？\n3. 这里有判断、阈值、条件、坑吗——还是只是常识和百科？\n\n【先定卡的类型，再写】\n- 方法卡：怎么做（步骤、清单、参数、流程）\n- 判断卡：怎么判（什么信号说明什么，决策规则，风险排序）\n- 案例卡：这个对象是什么情况（某个公司、客户、设备、项目的具体事实与结论）\n\n【硬规则】\n1. 一张卡只装一个能独立复用的点。同一个依据支撑不同适用边界时，拆成两张，在「关联」里互链，不要合并——合并会丢掉边界。\n2. 数量由信息密度决定，不设上限也不凑数：常见 2–6 张，只有 1 张也行。整段都是闲聊就 NO_CARDS。\n3. 常识、百科、教材原文、客套、过程叙述一律不抄；只记「不查资料就想不起来、或容易踩坑」的部分。\n4. 原文的专有名词、型号、案号、条款号、数字与单位一律原样保留，不要改写或四舍五入。\n5. 案例卡可以留具体对象（公司名、金额、型号）；方法卡和判断卡里不写具体对象，只写通用的怎么判、怎么做。\n6. 数字不确定、说法有冲突：保留分歧并标「（待核实）」，写清由谁、用什么方式核。禁止编造数据和链接。\n7. 下面的模板是填空用的，尖括号和示例字都要换成这张卡的真实内容。**如果你输出的 title 或正文里出现了模板原文（比如「动宾短语」「对象 + 结论」「一句话说清：做什么、怎么判」），说明你抄了模板没写内容，必须重写成真实内容，写不出就说明不值得存、只输出 NO_CARDS。**\n\n【每张卡严格按模板，不加解释、序号、前后缀】\n---CARD---\ntitle: <这张卡的主题，动宾短语 8–18 字；案例卡写「对象 + 结论」>\ntags: <3–5 个词，第一个是主题域如 光伏/尽调/安防/家电，第二个是 方法/判断/案例，其余是关键词>\n## 结论\n<一句话说清：做什么、怎么判、这个对象是什么情况。>\n## 依据\n- <2–5 条关键事实、数据、机理，每条一句话；清单型可以多列几条>\n- 建议链接：[[<本段对话里出现过的已有概念>]]（找不到就写 [[待归类]]）\n## 适用边界\n- <什么条件下成立；什么情况下不适用，或最常见的错法>\n## 关联\n- [[<另一张卡的标题>]] · 支持/延伸/反驳/案例 · 一句话理由\n来源：[[YYYY-MM-DD 输入类型]]\n核实状态：未核实\n---END---\n\n【硬性要求】\n- 正文 150–500 字；任何一句脱离原文都能独立看懂\n- 链接只能用本段对话里出现过的概念，宁可写 [[待归类]]，不许编造\n- 除卡片块外不要输出任何文字；不值得存就只输出 NO_CARDS";

function distillPromptPath(p) {
  return path.join(p.memoryDir, "prompts", "distill.md");
}

async function readDistillPrompt(p) {
  const file = distillPromptPath(p);
  try {
    const text = await fs.readFile(file, "utf8");
    if (text.trim()) return { text, path: file, custom: true };
  } catch {
    /* 没有就用默认的，并落一份 */
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, DISTILL_FALLBACK, "utf8");
  return { text: DISTILL_FALLBACK, path: file, custom: false };
}

async function writeDistillPrompt(p, text) {
  const file = distillPromptPath(p);
  const value = String(text || "").trim();
  if (value.length < 20) throw new Error("提示词太短了，至少 20 个字");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${value}\n`, "utf8");
  return { ok: true, path: file, chars: value.length };
}

async function handleRpc(request, ctx, config, p) {
  if (request.method !== "POST") return new Response("method not allowed", { status: 405 });
  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid json" }, 400);
  }
  if (
    body === null ||
    typeof body !== "object" ||
    body.type !== "client-request" ||
    typeof body.rpcId !== "string" ||
    typeof body.method !== "string"
  ) {
    return jsonResponse({ error: "invalid client-request envelope" }, 400);
  }
  if (body.method !== RPC_METHOD) return jsonResponse({ error: "unknown RPC method" }, 400);

  const wrapped = body.payload;
  if (wrapped === null || typeof wrapped !== "object" || typeof wrapped.endpoint !== "string") {
    return failure(body.rpcId, "invalid-request", "payload 必须是 { endpoint, payload }");
  }
  const payload = wrapped.payload && typeof wrapped.payload === "object" ? wrapped.payload : {};

  try {
    switch (wrapped.endpoint) {
      case "hub.settings":
        return success(body.rpcId, hubView(config, await readHubSettings(p)));
      case "hub.onboard": {
        const settings = await writeHubSettings(p, { onboarded: true });
        return success(body.rpcId, hubView(config, settings));
      }
      case "hub.rename": {
        const title = String(payload.title ?? "").trim().slice(0, 40);
        const settings = await writeHubSettings(p, { title });
        return success(body.rpcId, { title: settings.title || "" });
      }
      case "status":
        return success(body.rpcId, await memoryStatus(p, config));
      case "cards.list":
        return success(body.rpcId, { ...(await inboxList(p)), memoryDir: p.memoryDir });
      case "cards.save":
        return success(body.rpcId, await inboxSave(p, payload.text));
      case "prompt.get":
        return success(body.rpcId, await readDistillPrompt(p));
      case "prompt.save":
        return success(body.rpcId, await writeDistillPrompt(p, payload.text));
      case "cards.read":
        return success(body.rpcId, await inboxRead(p, payload.file));
      case "cards.update":
        return success(body.rpcId, await inboxUpdate(p, payload.file, payload.patch || {}));
      case "cards.discard":
        return success(body.rpcId, await inboxDiscard(p, payload.files));
      case "cards.upload":
        return success(body.rpcId, await inboxUpload(p, config, payload.files, { local: payload.local === true }));
      case "progress.save":
        return success(body.rpcId, await writeProgress(p, payload.text, payload.meta));
      case "progress.read":
        return success(body.rpcId, await readProgress(p));
      case "progress.history":
        return success(body.rpcId, { items: await recentProgress(p) });
      case "memory.sync": {
        if (!(await isRepo(p.memoryDir))) return success(body.rpcId, { ok: false, message: "不是 git 仓库" });
        if (payload.action === "pull") {
          const r = await git(p.memoryDir, ["pull", "--rebase", "--autostash", "origin", config.branch], 180000);
          return success(body.rpcId, { ok: r.ok, message: r.out || "已是最新" });
        }
        const r = await commitAndPush(p, config, "manual");
        return success(body.rpcId, { ok: r.ok, message: r.message || "" });
      }
      default:
        return failure(body.rpcId, "unknown-endpoint", `未知 endpoint：${wrapped.endpoint}`);
    }
  } catch (error) {
    ctx.logger?.warn?.(`[brain-hub] ${wrapped.endpoint} 失败：${String(error)}`);
    return failure(body.rpcId, "internal-error", String(error?.message || error));
  }
}

/* ------------------------------- tools ------------------------------- */

function toolText(result) {
  if (typeof result === "string") return result;
  if (result && typeof result.message === "string") return result.message;
  return JSON.stringify(result ?? null, null, 2);
}

function buildTools(p, config) {
  const guardWrite = () => (config.readOnly ? "当前是只读模式（readOnly: true），不能写入。" : "");

  return [
    {
      name: "memory_write",
      description:
        "保存一条归档记忆，跨所有会话持久。内容要自包含（未来会话看不到当前对话）。保存后立刻进索引，可用 memory_search 检索；开启 autoPush 时会自动 commit + push。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          title: { type: "string", description: "简短标题（用于文件名与检索）" },
          content: { type: "string", description: "记忆正文，自包含，可多行 Markdown" },
          tags: { type: "array", items: { type: "string" }, description: "可选标签" },
        },
        required: ["title", "content"],
      },
      async execute(args) {
        const blocked = guardWrite();
        if (blocked) return blocked;
        const title = String(args.title || "").trim();
        const content = String(args.content || "").trim();
        if (!title || !content) return "title 和 content 都不能为空。";
        const id = `${stamp()}-${slugify(title)}`;
        const file = `${id}.md`;
        await fs.writeFile(
          path.join(p.notes, file),
          buildNote({ id, title, tags: parseTags(args.tags || []), body: content, uploaded: true }),
          "utf8"
        );
        await rebuildIndex(p, await readAllNotes(p));
        const sync = await commitAndPush(p, config, "memory_write");
        const tail = sync.ok ? (sync.noop ? "" : `\n${sync.message}`) : `\n（同步失败：${String(sync.message).split("\n")[0]}）`;
        return `已保存：${title}（${id}）${tail}`;
      },
    },
    {
      name: "memory_search",
      description: "按关键词检索归档记忆（标题/标签/正文），返回相关度排序的摘要。多个关键词用空格分隔。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          query: { type: "string", description: "检索关键词，可用空格分隔多个" },
          limit: { type: "integer", description: "最多返回条数，默认 8" },
        },
        required: ["query"],
      },
      async execute(args) {
        const terms = String(args.query || "")
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean);
        if (terms.length === 0) return "query 不能为空。";
        const notes = await readAllNotes(p);
        const hits = notes
          .map((note) => ({ note, score: scoreNote(note, terms) }))
          .filter((hit) => hit.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, Number(args.limit) || 8);
        if (hits.length === 0) return `没有检索到与「${args.query}」相关的记忆（库里有 ${notes.length} 条）。`;
        return hits
          .map((hit, i) => `${i + 1}. ${hit.note.title}（${hit.note.id}）\n   ${snippet(hit.note.body, terms)}`)
          .join("\n");
      },
    },
    {
      name: "memory_read",
      description: "按 id 读取一条归档记忆的完整内容。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { id: { type: "string", description: "记忆 id（可带 .md 后缀，支持唯一前缀）" } },
        required: ["id"],
      },
      async execute(args) {
        const key = String(args.id || "").replace(/\.md$/i, "").trim();
        const notes = await readAllNotes(p);
        const exact = notes.find((n) => n.id === key);
        const prefixed = notes.filter((n) => n.id.startsWith(key));
        const note = exact || (prefixed.length === 1 ? prefixed[0] : null);
        if (!note) return prefixed.length > 1 ? `前缀「${key}」匹配到 ${prefixed.length} 条，请给更长的 id。` : `没有找到记忆：${args.id}`;
        const head = [`# ${note.title}`, `id: ${note.id}`, note.tags.length ? `tags: ${note.tags.join(", ")}` : "", `updated: ${note.updated}`]
          .filter(Boolean)
          .join("\n");
        return `${head}\n\n${note.body.replace(/^#\s+.+\r?\n?/, "").trim()}`;
      },
    },
    {
      name: "memory_list",
      description: "列出归档记忆（新→旧），可按标签过滤。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          limit: { type: "integer", description: "最多返回条数，默认 20" },
          tag: { type: "string", description: "可选：只列带此标签的记忆" },
        },
      },
      async execute(args) {
        const tag = String(args.tag || "").trim();
        const notes = (await readAllNotes(p)).filter((n) => !tag || n.tags.includes(tag));
        const limit = Number(args.limit) || 20;
        if (notes.length === 0) return tag ? `没有标签为「${tag}」的记忆。` : "记忆库还是空的。";
        return notes
          .slice(0, limit)
          .map((n) => `- ${n.title}（${n.id}）${n.tags.length ? ` #${n.tags.join(" #")}` : ""}`)
          .join("\n");
      },
    },
    {
      name: "memory_stats",
      description: "记忆库概况：归档条数、总大小、标签分布、核心记忆长度、git 状态。",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        const notes = await readAllNotes(p);
        const core = (await readCore(p)).trim();
        const repo = await isRepo(p.memoryDir);
        const remote = repo ? await git(p.memoryDir, ["remote", "get-url", "origin"]) : { out: "" };
        const tagCount = new Map();
        for (const note of notes) for (const tag of note.tags) tagCount.set(tag, (tagCount.get(tag) || 0) + 1);
        const topTags = [...tagCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
        const bytes = notes.reduce((sum, n) => sum + n.size, 0);
        return [
          `目录：${p.memoryDir}`,
          `归档：${notes.length} 条，共 ${(bytes / 1024).toFixed(1)} KB`,
          `核心记忆：${core.length} 字符（上限约 ${config.coreLimit}）`,
          `标签：${topTags.length ? topTags.map(([t, c]) => `${t}(${c})`).join(" ") : "（无）"}`,
          `远端：${remote.out.trim() || "（未设置）"} / 分支 ${config.branch}`,
          `最近更新：${notes[0]?.title || "（空）"}`,
        ].join("\n");
      },
    },
    {
      name: "memory_core",
      description:
        "编辑核心记忆 MEMORY.md——它在每个会话的系统提示里常驻注入，务必保持精炼。action=append 追加到分节末尾；replace 整体替换分节；remove 删除分节。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["append", "replace", "remove"] },
          section: { type: "string", description: "分节名（MEMORY.md 里的 ## 标题），如：用户 / 环境 / 项目" },
          text: { type: "string", description: "要写入的内容（append/replace 时必填）" },
        },
        required: ["action", "section"],
      },
      async execute(args) {
        const blocked = guardWrite();
        if (blocked) return blocked;
        const result = await coreAction(p, args.action, args.section, args.text);
        if (!result.ok) return result.message;
        const sync = await commitAndPush(p, config, "memory_core");
        return `${result.message}${sync.ok ? (sync.noop ? "" : `\n${sync.message}`) : `\n（同步失败：${String(sync.message).split("\n")[0]}）`}`;
      },
    },
    {
      name: "memory_update",
      description: "修改一条已有归档记忆（title / tags / content 三选一或多选）。修改后 updated 刷新，并自动提交推送。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "记忆 id，支持唯一前缀" },
          title: { type: "string" },
          content: { type: "string", description: "新正文（不含一级标题）" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["id"],
      },
      async execute(args) {
        const blocked = guardWrite();
        if (blocked) return blocked;
        const key = String(args.id || "").replace(/\.md$/i, "").trim();
        const notes = await readAllNotes(p);
        const note = notes.find((n) => n.id === key) || (notes.filter((n) => n.id.startsWith(key)).length === 1 ? notes.filter((n) => n.id.startsWith(key))[0] : null);
        if (!note) return `没有找到记忆：${args.id}`;
        const next = buildNote({
          id: note.id,
          title: String(args.title || note.title),
          tags: args.tags === undefined ? note.tags : parseTags(args.tags),
          body: args.content === undefined ? note.body : String(args.content),
          created: note.created,
          updated: new Date().toISOString(),
          uploaded: note.uploaded,
        });
        await fs.writeFile(path.join(note.local ? p.priv : p.notes, note.file), next, "utf8");
        await rebuildIndex(p, await readAllNotes(p));
        const sync = await commitAndPush(p, config, "memory_update");
        return `已更新：${note.title}（${note.id}）${sync.ok ? (sync.noop ? "" : `\n${sync.message}`) : `\n（同步失败：${String(sync.message).split("\n")[0]}）`}`;
      },
    },
    {
      name: "memory_forget",
      description: "处理一条不再需要的归档记忆。mode=archive（默认）移到 notes/archive/ 保留可回滚；mode=delete 直接删除。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string", description: "记忆 id，支持唯一前缀" },
          mode: { type: "string", enum: ["archive", "delete"] },
        },
        required: ["id"],
      },
      async execute(args) {
        const blocked = guardWrite();
        if (blocked) return blocked;
        const key = String(args.id || "").replace(/\.md$/i, "").trim();
        const notes = await readAllNotes(p);
        const note = notes.find((n) => n.id === key) || (notes.filter((n) => n.id.startsWith(key)).length === 1 ? notes.filter((n) => n.id.startsWith(key))[0] : null);
        if (!note) return `没有找到记忆：${args.id}`;
        if (args.mode === "delete") {
          await fs.rm(path.join(note.local ? p.priv : p.notes, note.file), { force: true });
        } else {
          const root = note.local ? p.priv : p.notes;
          const dir = path.join(root, "archive");
          await fs.mkdir(dir, { recursive: true });
          await fs.rename(path.join(root, note.file), path.join(dir, note.file));
        }
        await rebuildIndex(p, await readAllNotes(p));
        const sync = await commitAndPush(p, config, "memory_forget");
        return `已${args.mode === "delete" ? "删除" : "归档"}：${note.title}${sync.ok ? (sync.noop ? "" : `\n${sync.message}`) : `\n（同步失败：${String(sync.message).split("\n")[0]}）`}`;
      },
    },
    {
      name: "memory_sync",
      description: "记忆库 git 同步：status 看状态，pull 拉远端，push 提交并推送本地改动。",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: { type: "string", enum: ["status", "pull", "push"], description: "默认 status" },
        },
      },
      async execute(args) {
        const action = String(args.action || "status");
        if (!(await isRepo(p.memoryDir))) return `目录还不是 git 仓库：${p.memoryDir}`;
        if (action === "pull") {
          const r = await git(p.memoryDir, ["pull", "--rebase", "--autostash", "origin", config.branch], 180000);
          return `拉取${r.ok ? "成功" : "失败"}：${r.out.split("\n")[0]}`;
        }
        if (action === "push") {
          const r = await commitAndPush(p, config, "memory_sync");
          return r.message || "已同步";
        }
        const status = await git(p.memoryDir, ["status", "--porcelain"]);
        const last = await git(p.memoryDir, ["log", "-1", "--pretty=%h %s"]);
        const remote = await git(p.memoryDir, ["remote", "get-url", "origin"]);
        return [
          `目录：${p.memoryDir}`,
          `远端：${remote.out.trim() || "（未设置）"}`,
          `分支：${config.branch}`,
          `最近提交：${last.out.trim() || "（无）"}`,
          `未提交改动：${status.out.trim() ? `${status.out.trim().split("\n").length} 个文件` : "无"}`,
        ].join("\n");
      },
    },
  ];
}

/* ------------------------------- entry ------------------------------- */

export function apply(ctx, config0 = {}) {
  const config = { ...DEFAULTS, ...(config0 || {}) };
  const p = resolvePaths(config);

  ensureDirs(p).catch((error) => ctx.logger?.warn?.(`[brain-hub] 建目录失败：${String(error)}`));

  ctx.inject(["systemPrompt"], (scope) => {
    scope.effect(() => {
      const dispose = ctx.systemPrompt.section({
        name: "dsh-brain-hub:core",
        order: 60,
        text: () => {
          try {
            const parts = [];
            const raw = existsSync(p.coreFile) ? readFileSync(p.coreFile, "utf8").trim() : "";
            if (raw) {
              // 文件本身就以“# 核心记忆”开头，这里去掉再套标题，避免重复
              const body = raw.replace(/^#\s*核心记忆\s*\r?\n?/, "").trim();
              if (body) {
                const limit = Number(config.coreLimit) || DEFAULTS.coreLimit;
                const shown =
                  body.length > limit ? `${body.slice(0, limit)}\n…（核心记忆超出 ${limit} 字上限，已截断）` : body;
                parts.push(`# 核心记忆\n\n${shown}`);
              }
            }
            if (config.injectProgress !== false && existsSync(p.progressFile)) {
              const tail = readFileSync(p.progressFile, "utf8").trim().slice(-700);
              if (tail) parts.push(`# 最近在网页版聊什么\n\n${tail}`);
            }
            return parts.join("\n\n");
          } catch {
            return "";
          }
        },
      });
      return () => dispose?.();
    }, "brain-hub: core section");
  });

  ctx.inject(["tools"], (scope) => {
    scope.effect(() => {
      const disposers = buildTools(p, config).map((def) => ctx.tools.register(def));
      return () => {
        for (const dispose of disposers) dispose?.();
      };
    }, "brain-hub: tools");
  });

  ctx.inject(["connection"], (scope) => {
    scope.effect(() => {
      const dispose = scope.connection.fetch.register({
        path: RPC_PATH,
        methods: ["POST"],
        requestBody: "buffered",
        fetch: (request) => handleRpc(request, ctx, config, p),
      });
      return () => dispose?.();
    }, "brain-hub: rpc route");
  });

  if (config.autoPull) {
    setTimeout(async () => {
      try {
        if (!(await isRepo(p.memoryDir))) return;
        const r = await git(p.memoryDir, ["pull", "--rebase", "--autostash", "origin", config.branch], 180000);
        ctx.logger?.info?.(`[brain-hub] 启动拉取：${r.ok ? "成功" : r.out.split("\n")[0]}`);
      } catch (error) {
        ctx.logger?.warn?.(`[brain-hub] 启动拉取异常：${String(error)}`);
      }
    }, 0);
  }

  ctx.logger?.info?.(`[brain-hub] memory=${p.memoryDir} notes=${p.notesDir} branch=${config.branch}`);
}
