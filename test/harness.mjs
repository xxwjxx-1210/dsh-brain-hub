/**
 * dsh-brain-hub 宿主侧集成测试：假 ctx + 临时 git 仓库 + 本地 bare 远端。
 * 跑法：node test/harness.mjs
 */
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import assert from "node:assert/strict";

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = await import(pathToFileURL(path.join(here, "..", "dist", "index.js")).href);

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "brain-hub-"));
const memoryDir = path.join(tmp, "memory");
const notesDir = path.join(tmp, "dsh_memory");
const bareDir = path.join(tmp, "remote.git");
await fs.mkdir(memoryDir, { recursive: true });
await fs.mkdir(notesDir, { recursive: true });

const run = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

run(tmp, ["init", "--bare", "-b", "main", bareDir]);
run(memoryDir, ["init", "-b", "main"]);
run(memoryDir, ["config", "user.name", "hub-test"]);
run(memoryDir, ["config", "user.email", "hub@test.local"]);
await fs.writeFile(path.join(memoryDir, "MEMORY.md"), "# 核心记忆\n\n## 用户\n\n- 测试用户\n", "utf8");
run(memoryDir, ["add", "-A"]);
run(memoryDir, ["commit", "-m", "init"]);
run(memoryDir, ["remote", "add", "origin", bareDir]);
run(memoryDir, ["push", "-u", "origin", "main"]);

/* ------------------------------ fake ctx ------------------------------ */
function makeCtx() {
  const state = { sections: [], tools: new Map(), routes: new Map(), logs: [] };
  const ctx = {
    logger: {
      info: (m) => state.logs.push(`info ${m}`),
      warn: (m) => state.logs.push(`warn ${m}`),
      error: (m) => state.logs.push(`error ${m}`),
    },
    systemPrompt: {
      section(def) {
        state.sections.push(def);
        return () => {};
      },
    },
    tools: {
      register(def) {
        state.tools.set(def.name, def);
        return () => {};
      },
    },
    connection: {
      fetch: {
        register(route) {
          state.routes.set(route.path, route);
          return () => {};
        },
      },
    },
    inject(_services, fn) {
      return fn({ effect: (fn2) => fn2(), connection: ctx.connection });
    },
    state,
  };
  return ctx;
}

const ctx = makeCtx();
const config = {
  memoryDir,
  notesDir,
  branch: "main",
  coreLimit: 3000,
  autoPull: false,
  autoPush: true,
  readOnly: false,
};

plugin.apply(ctx, config);
await new Promise((r) => setTimeout(r, 150));

let passed = 0;
const failures = [];
async function check(label, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS ${label}`);
  } catch (error) {
    failures.push({ label, error });
    console.log(`  FAIL ${label}\n       ${String(error && error.message).split("\n")[0]}`);
  }
}

const rpcEnvelope = async (raw) => {
  const route = ctx.state.routes.get("/api/plugin-rpc/brain-hub");
  const request = new Request("http://local/api/plugin-rpc/brain-hub", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof raw === "string" ? raw : JSON.stringify(raw),
  });
  const response = await route.fetch(request);
  return { status: response.status, body: await response.json() };
};

const rpc = (endpoint, payload = {}) =>
  rpcEnvelope({
    type: "client-request",
    rpcId: "r1",
    method: "plugin-rpc/brain-hub",
    payload: { endpoint, payload },
  });

try {
  console.log("== 注册 ==");
  await check("系统提示分节已注册", () => {
    assert.equal(ctx.state.sections.length, 1);
    assert.equal(ctx.state.sections[0].name, "dsh-brain-hub:core");
    assert.equal(ctx.state.sections[0].order, 60);
  });
  await check("9 个记忆工具已注册", () => {
    assert.deepEqual([...ctx.state.tools.keys()].sort(), [
      "memory_core",
      "memory_forget",
      "memory_list",
      "memory_read",
      "memory_search",
      "memory_stats",
      "memory_sync",
      "memory_update",
      "memory_write",
    ]);
  });
  await check("RPC 路由已注册", () => {
    const route = ctx.state.routes.get("/api/plugin-rpc/brain-hub");
    assert.deepEqual(route.methods, ["POST"]);
    assert.equal(route.requestBody, "buffered");
    assert.equal(typeof route.fetch, "function");
  });
  await check("核心记忆已注入系统提示", () => {
    assert.match(ctx.state.sections[0].text(), /测试用户/);
  });
  await check("系统提示里标题不重复", () => {
    const text = ctx.state.sections[0].text();
    assert.equal((text.match(/# 核心记忆/g) || []).length, 1);
  });

  console.log("== 记忆读写 ==");
  let writeResult = "";
  await check("memory_write 返回成功", async () => {
    writeResult = await ctx.state.tools.get("memory_write").execute({
      title: "光伏踏勘要点",
      content: "檩条跨度 6m、截面低于 180mm 要警惕。",
      tags: ["光伏", "踏勘"],
    });
    assert.match(writeResult, /已保存/);
  });
  await check("notes 里出现 1 个文件", async () => {
    const files = (await fs.readdir(path.join(memoryDir, "notes"))).filter((f) => f.endsWith(".md"));
    assert.equal(files.length, 1);
  });
  await check("index.json 重建为 1 条", async () => {
    const index = JSON.parse(await fs.readFile(path.join(memoryDir, "index.json"), "utf8"));
    assert.equal(index.version, 1);
    assert.equal(index.notes.length, 1);
    assert.equal(index.notes[0].title, "光伏踏勘要点");
  });
  await check("远端收到 memory_write 提交", () => {
    assert.match(run(bareDir, ["log", "--oneline", "main"]), /memory: memory_write/);
  });
  await check("memory_search 命中", async () => {
    const result = await ctx.state.tools.get("memory_search").execute({ query: "檩条 踏勘" });
    assert.match(result, /光伏踏勘要点/);
  });
  await check("memory_read 返回正文", async () => {
    const files = (await fs.readdir(path.join(memoryDir, "notes"))).filter((f) => f.endsWith(".md"));
    const result = await ctx.state.tools.get("memory_read").execute({ id: files[0].replace(/\.md$/, "") });
    assert.match(result, /180mm/);
  });
  await check("memory_core append 生效", async () => {
    const result = await ctx.state.tools.get("memory_core").execute({ action: "append", section: "环境", text: "- DSH 装在 D 盘" });
    assert.match(result, /环境/);
    const core = await fs.readFile(path.join(memoryDir, "MEMORY.md"), "utf8");
    assert.match(core, /## 环境/);
    assert.match(core, /DSH 装在 D 盘/);
    assert.match(ctx.state.sections[0].text(), /DSH 装在 D 盘/);
  });
  await check("memory_stats 报数正确", async () => {
    const result = await ctx.state.tools.get("memory_stats").execute({});
    assert.match(result, /归档：1 条/);
  });

  console.log("== 卡片收件箱 ==");
  const cardText = [
    "---CARD---",
    "title: 售电套餐诊断方法",
    "tags: 售电, 方法论",
    "先看负荷曲线，再看峰谷比例。",
    "---END---",
    "---CARD---",
    "title: 地勘资料整理流程",
    "tags: 地勘",
    "收集图件 → 归档 → 出清册。",
    "---END---",
  ].join("\n");

  await check("cards.save 收录 2 张", async () => {
    const result = await rpc("cards.save", { text: cardText });
    assert.equal(result.body.result.value.saved.length, 2);
  });
  await check("cards.list 统计与标题解析", async () => {
    const result = await rpc("cards.list");
    const value = result.body.result.value;
    assert.equal(value.stats.total, 2);
    assert.equal(value.stats.pending, 2);
    assert.equal(value.stats.notes, 1);
    const titles = value.cards.map((c) => c.title).join(",");
    assert.match(titles, /售电套餐诊断方法/);
    assert.match(titles, /地勘资料整理流程/);
  });

  const listed = (await rpc("cards.list")).body.result.value;
  const target = listed.cards.find((c) => c.title.startsWith("售电"));

  await check("cards.upload 成功", async () => {
    const result = await rpc("cards.upload", { files: [target.file] });
    assert.equal(result.body.result.value.ok, true);
  });
  await check("notes 多了一张、收件箱保留", async () => {
    const files = (await fs.readdir(path.join(memoryDir, "notes"))).filter((f) => f.endsWith(".md"));
    assert.equal(files.length, 2);
    const inbox = await fs.readdir(path.join(memoryDir, "inbox"));
    assert.equal(inbox.length, 2);
  });
  await check("收件箱标记已上传、待上传只剩 1", async () => {
    const value = (await rpc("cards.list")).body.result.value;
    assert.equal(value.stats.uploaded, 1);
    assert.equal(value.stats.pending, 1);
    assert.equal(value.cards.find((c) => c.file === target.file).uploaded, true);
  });
  await check("上传产生 card-inbox 提交", () => {
    assert.match(run(bareDir, ["log", "--oneline", "main"]), /memory: card-inbox/);
  });
  await check("重复上传不产生新提交", async () => {
    const before = run(bareDir, ["rev-parse", "main"]);
    const result = await rpc("cards.upload", { files: [target.file] });
    const message = result.body.result.value.message;
    assert.match(message, /没有新改动|已上传/);
    assert.equal(run(bareDir, ["rev-parse", "main"]), before);
  });
  await check("空上传被拒绝", async () => {
    const result = await rpc("cards.upload", { files: [] });
    assert.equal(result.body.result.value.ok, false);
  });

  await check("重复主题的卡片照常保存（已取消查重）", async () => {
    const first = await rpc("cards.save", {
      text: ["---CARD---", "title: 已经存过的主题", "这条只写一次，第二次也应当存下来。", "---END---"].join("\n"),
    });
    assert.equal(first.body.result.value.saved.length, 1);
    const again = await rpc("cards.save", {
      text: ["---CARD---", "title: 已经存过的主题", "换了措辞，但主题一样，仍然要能存。", "---END---"].join("\n"),
    });
    const value = again.body.result.value;
    assert.equal(value.saved.length, 1);
    assert.notEqual(value.saved[0].file, first.body.result.value.saved[0].file);
  });

  await check("列表把已存在的卡标记为 exists 且不算待确认", async () => {
    const noteFile = path.join(memoryDir, "notes", "20260101-same-topic.md");
    const dupFile = `${Date.now()}-dup-topic.md`;
    const body = [
      "---",
      "id: 20260101-same-topic",
      "title: 已经存过的主题",
      "tags: 测试",
      "created: 2026-01-01",
      "updated: 2026-01-01",
      "uploaded: false",
      "---",
      "",
      "# 已经存过的主题",
      "",
      "同一个主题的第二份草稿。",
      "",
    ].join("\n");
    await fs.writeFile(noteFile, body, "utf8");
    await fs.writeFile(path.join(memoryDir, "inbox", dupFile), body, "utf8");
    const value = (await rpc("cards.list")).body.result.value;
    const dup = value.cards.find((card) => card.file === dupFile);
    assert.equal(dup.exists, true);
    assert.equal(typeof value.stats.pendingFresh, "number");
    assert.equal(value.stats.pendingFresh, value.stats.pending - value.stats.duplicates);
    assert.ok(Array.isArray(value.knownTitles) && value.knownTitles.includes("已经存过的主题"));
    await fs.unlink(path.join(memoryDir, "inbox", dupFile));
    await fs.unlink(noteFile);
  });

  await rpc("cards.save", {
    text: ["---CARD---", "title: 本地私密卡片", "客户的真实联系方式与报价底线。", "---END---"].join("\n"),
  });
  const localCard = (await rpc("cards.list")).body.result.value.cards.find((c) => c.title.startsWith("本地"));
  const beforeLocal = run(bareDir, ["rev-parse", "main"]);
  await check("只存本地：写进 private/、不进 notes", async () => {
    const result = await rpc("cards.upload", { files: [localCard.file], local: true });
    const value = result.body.result.value;
    assert.equal(value.ok, true);
    assert.match(value.message, /本地/);
    const priv = await fs.readdir(path.join(memoryDir, "private"));
    assert.equal(priv.filter((f) => f.endsWith(".md")).length, 1);
    const notes = (await fs.readdir(path.join(memoryDir, "notes"))).filter((f) => f.endsWith(".md"));
    assert.equal(notes.length, 2);
  });
  await check("只存本地：.gitignore 里写了 private/", async () => {
    const text = await fs.readFile(path.join(memoryDir, ".gitignore"), "utf8");
    assert.match(text, /^private\/$/m);
    assert.equal(run(memoryDir, ["check-ignore", "private/x.md"]).trim().length > 0, true);
  });
  await check("只存本地：不产生远端提交", () => {
    assert.equal(run(bareDir, ["rev-parse", "main"]), beforeLocal);
  });
  await check("只存本地：index 里标 local、统计区分云端/本地", async () => {
    const index = JSON.parse(await fs.readFile(path.join(memoryDir, "index.json"), "utf8"));
    assert.equal(index.notes.filter((n) => n.local === true).length, 1);
    const stats = (await rpc("cards.list")).body.result.value.stats;
    assert.equal(stats.notes, 2);
    assert.equal(stats.localNotes, 1);
  });
  await check("无卡片文本不写文件", async () => {
    const before = (await fs.readdir(path.join(memoryDir, "inbox"))).length;
    await rpc("cards.save", { text: "这里没有任何卡片标记" });
    assert.equal((await fs.readdir(path.join(memoryDir, "inbox"))).length, before);
  });

  console.log("== 人工确认 ==");
  const reviewCard = (await rpc("cards.list")).body.result.value.cards.find((c) => !c.uploaded);
  await check("cards.read 返回完整正文", async () => {
    const value = (await rpc("cards.read", { file: reviewCard.file })).body.result.value;
    assert.equal(value.title, reviewCard.title);
    assert.ok(value.body.length > 20);
  });
  await check("cards.update 改标题与标签", async () => {
    const value = (
      await rpc("cards.update", { file: reviewCard.file, patch: { title: "改过的标题", tags: ["售电", "诊断"] } })
    ).body.result.value;
    assert.equal(value.title, "改过的标题");
    assert.deepEqual(value.tags, ["售电", "诊断"]);
  });
  await check("改名后文件仍可读取", async () => {
    const text = await fs.readFile(path.join(memoryDir, "inbox", reviewCard.file), "utf8");
    assert.match(text, /改过的标题/);
    assert.match(text, /uploaded: false/);
  });
  await check("cards.discard 丢掉卡片", async () => {
    const result = await rpc("cards.discard", { files: [reviewCard.file] });
    assert.equal(result.body.result.value.removed.length, 1);
    const gone = await fs
      .access(path.join(memoryDir, "inbox", reviewCard.file))
      .then(() => false)
      .catch(() => true);
    assert.equal(gone, true);
    const value = (await rpc("cards.list")).body.result.value;
    assert.ok(!value.cards.some((c) => c.file === reviewCard.file));
  });

  console.log("== 提炼规则 ==");
  await check("prompt.get 首次落一份默认规则", async () => {
    const value = (await rpc("prompt.get")).body.result.value;
    assert.equal(value.custom, false);
    assert.match(value.text, /NO_CARDS/);
    assert.match(value.text, /---CARD---/);
    assert.equal(await fs.readFile(value.path, "utf8").then((t) => t.length > 100), true);
  });
  await check("prompt.save 改完能读回", async () => {
    await rpc("prompt.save", { text: "自定义规则：只保留数字和阈值，其余全部删掉，最多两张卡。" });
    const value = (await rpc("prompt.get")).body.result.value;
    assert.equal(value.custom, true);
    assert.match(value.text, /只保留数字和阈值/);
  });

  await check("新模板的三种卡都能解析出 title 与 tags", async () => {
    const frame = (inner) => `---CARD---\n${inner}\n---END---`;
    const text = [
      frame(
        "title: 钢结构光伏踏勘先查檩条承载\ntags: 光伏, 方法, 钢结构, 踏勘\n## 结论\n门式刚架厂房先核檩条承载力与风吸组合。\n## 依据\n- 跨度 6 m、截面高度低于 180 mm 需警惕\n## 适用边界\n- 不适用于混凝土屋面\n## 关联\n- [[待归类]]\n来源：[[2026-11-05 技术踏勘]]\n核实状态：未核实"
      ),
      frame(
        "title: 终止本次执行不等于债务结清\ntags: 尽调, 判断, 执行程序\n## 结论\n终本只说明暂无财产可执行，债权仍在。\n## 依据\n- 发现新财产线索可恢复执行\n## 适用边界\n- 需结合欠税与限高一起看\n## 关联\n- [[宝丰西商-案例]] · 案例 · 同一家公司\n来源：[[2026-11-05 背调]]\n核实状态：未核实"
      ),
      frame(
        "title: 宝丰西商已终本且欠税未清\ntags: 尽调, 案例, 西商集团\n## 结论\n该公司两案终本、欠税约五百万，不宜做长期回款合作。\n## 依据\n- （2025）皖1502执2997号标的约 3003 万元\n## 适用边界\n- 仅代表公开信息状态\n## 关联\n- [[终止本次执行不等于债务结清]] · 支持 · 判断依据\n来源：[[2026-11-05 背调]]\n核实状态：未核实"
      ),
    ].join("\n\n");
    const value = (await rpc("cards.save", { text })).body.result.value;
    assert.equal(value.saved.length, 3);
    const list = (await rpc("cards.list")).body.result.value.cards;
    const titles = list.map((c) => c.title);
    assert.ok(titles.includes("钢结构光伏踏勘先查檩条承载"));
    assert.ok(titles.includes("宝丰西商已终本且欠税未清"));
    const caseCard = list.find((c) => c.title === "宝丰西商已终本且欠税未清");
    assert.deepEqual(caseCard.tags, ["尽调", "案例", "西商集团"]);
  });

  console.log("== 网页版笔记 ==");
  const progressFile = path.join(notesDir, "progress.md");
  await check("progress.save 落盘", async () => {
    const result = await rpc("progress.save", { text: "第一版网页版进度：光伏踏勘", meta: { source: "https://chat.deepseek.com" } });
    assert.equal(result.body.result.value.ok, true);
    assert.match(await fs.readFile(progressFile, "utf8"), /第一版网页版进度/);
  });
  await check("二次保存把旧稿归档到 history", async () => {
    await rpc("progress.save", { text: "第二版网页版进度：售电诊断" });
    const files = (await fs.readdir(path.join(notesDir, "history"))).filter((f) => f.startsWith("progress-"));
    assert.equal(files.length, 1);
    assert.match(await fs.readFile(progressFile, "utf8"), /第二版网页版进度/);
  });
  await check("progress.history 返回 1 条", async () => {
    const result = await rpc("progress.history");
    assert.equal(result.body.result.value.items.length, 1);
  });
  await check("progress.read 返回最新内容", async () => {
    const result = await rpc("progress.read");
    assert.match(result.body.result.value.text, /第二版网页版进度/);
  });
  await check("progress 尾巴注入到系统提示", () => {
    const text = ctx.state.sections[0].text();
    assert.match(text, /最近在网页版聊什么/);
    assert.match(text, /第二版网页版进度/);
    assert.ok(text.length < 6000);
  });

  console.log("== 边界 ==");
  await check("未知 endpoint 报错", async () => {
    const result = await rpc("nope");
    assert.equal(result.body.result.ok, false);
  });
  await check("坏信封返回 400", async () => {
    const result = await rpcEnvelope('{"type":"x"}');
    assert.equal(result.status, 400);
  });
  await check("status 返回目录与最近提交", async () => {
    const value = (await rpc("status")).body.result.value;
    assert.equal(value.memoryDir, memoryDir);
    assert.match(value.lastCommit, /memory:/);
    assert.equal(value.isRepo, true);
  });
  await check("autoPull=false 时启动不拉取", () => {
    assert.ok(ctx.state.logs.every((line) => !line.includes("启动拉取")));
  });

  console.log("== readOnly ==");
  await check("只读模式拒绝写入", async () => {
    const roCtx = makeCtx();
    plugin.apply(roCtx, { ...config, readOnly: true, autoPull: false });
    const result = await roCtx.state.tools.get("memory_write").execute({ title: "x", content: "y" });
    assert.match(result, /只读/);
  });

  if (failures.length > 0) {
    console.error(`\n${failures.length} 项失败：`);
    for (const failure of failures) console.error(`- ${failure.label}: ${String(failure.error && (failure.error.stack || failure.error.message))}`);
    process.exitCode = 1;
  } else {
    console.log(`\n全部通过：${passed} 项`);
  }
} catch (error) {
  console.error("\nUNEXPECTED:", error && (error.stack || error.message || error));
  process.exitCode = 1;
} finally {
  await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
}
