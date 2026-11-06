/**
 * dsh-brain-hub — 面板（Client）
 *
 * 三个页签：新卡片 / 我的记忆 / 网页版。
 * 只依赖 react；通过 connection.rpc 调用 host 的 /api/plugin-rpc/brain-hub。
 */
window.__ModuleLoader__.load({
  id: "dsh-brain-hub",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;

    const React = require("react");
    const { useCallback, useEffect, useMemo, useRef, useState } = React;
    const h = React.createElement;

    const RPC_PATH = "/api/plugin-rpc/brain-hub";
    const RPC_METHOD = "plugin-rpc/brain-hub";
    const CHAT_URL = "https://chat.deepseek.com";

    /** 用户可改的显示名；为空时用默认名。 */
    let HUB_TITLE = "";
// 本轮（本次页面加载）内做过什么，用来判断四个步骤该不该打钩
const HUB_SESSION = { attempted: 0, cards: 0, saved: 0, startAt: Date.now() };
    const titleOf = () => HUB_TITLE.trim() || "记忆中枢";

    function connectionOf(ctx) {
      if (!ctx) return null;
      let connection = null;
      try {
        connection = ctx.get ? ctx.get("connection", false) : null;
      } catch {
        connection = null;
      }
      if (!connection) connection = ctx.connection || null;
      if (!connection && ctx.root) {
        try {
          connection = ctx.root.get ? ctx.root.get("connection", false) : ctx.root.connection;
        } catch {
          connection = null;
        }
      }
      return connection || null;
    }

    async function callRpc(ctx, endpoint, payload) {
      const connection = connectionOf(ctx);
      const rpc = connection && connection.rpc;
      if (!rpc || typeof rpc.call !== "function") throw new Error("connection.rpc 不可用");
      const response = await rpc.call(
        "/api",
        RPC_METHOD,
        { endpoint, payload: payload || {} },
        AbortSignal.timeout(120000)
      );
      if (!response || response.ok !== true) {
        const error = response && response.error;
        throw new Error((error && error.message) || "RPC 调用失败");
      }
      return response.value;
    }

    /* ---------------------------- webds dom ---------------------------- */

    const BUILD_TAG = "0.2.6";

    function findWebview() {
      const frames = Array.from(document.querySelectorAll("webview[data-sidebar-browser-frame]"));
      if (frames.length === 0) return null;
      const visible = frames.find((frame) => {
        const rect = frame.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && frame.offsetParent !== null;
      });
      return visible || frames[0];
    }

    /** 在网页版里跑一段脚本：把页面内抛出的异常变成可读的错误，而不是笼统的 Script failed to execute。 */
    async function evalInPage(view, script, tag) {
      if (!view || typeof view.executeJavaScript !== "function") throw new Error("没找到网页版视图");
      const wrapped = `(() => { try { return (${script}); } catch (e) { return { __guestError: String((e && (e.stack || e.message)) || e) }; } })()`;
      let lastProblem = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const result = await view.executeJavaScript(wrapped);
          if (result && result.__guestError) {
            const detail = tidy(result.__guestError, 800);
            throw hubError("网页里执行出错：" + detail.split("\n")[0], detail.slice(0, 800));
          }
          return result;
        } catch (problem) {
          if (problem && problem.hubDetail) throw problem;
          lastProblem = problem;
          const fresh = findWebview();
          if (fresh) view = fresh;
          const text = String((problem && problem.message) || problem);
          if (!/GUEST_VIEW_MANAGER_CALL|Script failed to execute|destroyed|navigat/i.test(text)) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
      const message = tidy(String((lastProblem && lastProblem.message) || lastProblem).split("\n")[0], 240);
      throw hubError(
        "和网页版通信失败：" + message,
        [
          "出错的那一步：" + (tag || "未标记"),
          "页面地址：" + ((view && view.src) || ""),
          "已经自动重试 3 次（每次隔 500 毫秒）。",
          "如果一直这样：先在侧栏把网页版打开、登录好、能手动打字，再点第 2 步。"
        ].join("\n")
      );
    }

    async function openChat(ctx) {
      const sidebar = ctx && ctx.get ? ctx.get("sidebarRight", false) : null;
      if (!sidebar || typeof sidebar.openTab !== "function") throw new Error("找不到 sidebarRight 服务，请先在侧栏打开一次网页版");
      await sidebar.openTab("browser", { params: { url: CHAT_URL } });
      return "已打开网页版侧栏，等页面加载完再点抓取";
    }

    const GRAB_SCRIPT = `(() => {
      const pick = document.querySelector('main') || document.querySelector('[class*="chat"]') || document.body;
      const text = (pick && pick.innerText ? pick.innerText : '').trim();
      return { href: location.href, text: text.slice(-12000) };
    })()`;

    async function grabPage(ctx) {
      const view = findWebview();
      if (!view || typeof view.executeJavaScript !== "function") throw new Error("没找到网页版视图，请先打开侧栏的网页版");
      const result = await evalInPage(view, GRAB_SCRIPT, "抓取正文");
      const text = String((result && result.text) || "").trim();
      if (text.length < 20) throw new Error("页面上没抓到内容（可能还没加载完）");
      return { text, href: String((result && result.href) || "") };
    }

    function injectScript(text) {
      const json = JSON.stringify(String(text));
      return `(() => {
        const payload = ${json};
        if (/sign_in|signin|login/i.test(location.href)) {
          return { ok: false, signIn: true, error: '侧栏网页版还停在登录页，请先在侧栏登录' };
        }
        const selectors = ['#chat-input', 'textarea[placeholder]', 'textarea', '.ProseMirror', '[contenteditable="true"]', '[contenteditable]', '[role="textbox"]'];
        let input = null;
        for (const selector of selectors) {
          const found = Array.from(document.querySelectorAll(selector)).find((el) => {
            const rect = el.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
          if (found) { input = found; break; }
        }
        const steps = [];
        const step = (name, fn) => {
          try { steps.push(name + ":" + JSON.stringify(fn())); }
          catch (e) { steps.push(name + ":ERR " + String((e && (e.message || e)) || e)); }
        };
        if (!input) return { ok: false, error: "页面上找不到输入框", steps };
        step("focus", () => { input.focus(); return true; });
        if (typeof input.setSelectionRange === "function") {
          step("selectRange", () => { input.setSelectionRange(0, String(input.value || "").length); return true; });
        }
        if (input.tagName === "TEXTAREA" || input.tagName === "INPUT") {
          step("nativeSetter", () => {
            const proto = input.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const desc = Object.getOwnPropertyDescriptor(proto, "value");
            if (!desc || typeof desc.set !== "function") throw new Error("没有 value setter");
            desc.set.call(input, payload);
            return String(input.value || "").length;
          });
        } else {
          step("textContent", () => { input.textContent = payload; return String(input.textContent || "").length; });
        }
        step("inputEvent", () => { input.dispatchEvent(new InputEvent("input", { bubbles: true, cancelable: true, inputType: "insertText", data: payload })); return true; });
        step("plainEvent", () => { input.dispatchEvent(new Event("input", { bubbles: true })); return true; });
        if (typeof document.execCommand === "function") {
          step("execCommand", () => document.execCommand("insertText", false, payload));
        }
        const worked = steps.some((line) => /^(nativeSetter|textContent|execCommand):(?!ERR)/.test(line));
        return { ok: worked, tag: input.tagName, steps, error: worked ? "" : "输入框写不进去" };
      })()`;
    }

    async function sendToPage(ctx, text) {
      const view = findWebview();
      if (!view || typeof view.executeJavaScript !== "function") throw new Error("没找到网页版视图，请先打开侧栏的网页版");
      const result = await evalInPage(view, injectScript(text), "填输入框");
      if (!result || result.ok !== true) throw new Error((result && result.error) || "写入输入框失败");
      return "已把内容填进网页版输入框，自己按发送即可";
    }

    /* -------------------------- 让网页版整理卡片 -------------------------- */

    const DISTILL_PROMPT = "你是我的知识收件箱助手。把我们这段对话整理成「以后还用得上」的卡片，直接写进我的记忆库。\n\n【先判断值不值得存】问三个问题，全是否就只输出 NO_CARDS：\n1. 三个月后我还会再查这件事吗？\n2. 不查资料，我自己想得起来吗？\n3. 这里有判断、阈值、条件、坑吗——还是只是常识和百科？\n\n【先定卡的类型，再写】\n- 方法卡：怎么做（步骤、清单、参数、流程）\n- 判断卡：怎么判（什么信号说明什么，决策规则，风险排序）\n- 案例卡：这个对象是什么情况（某个公司、客户、设备、项目的具体事实与结论）\n\n【硬规则】\n1. 一张卡只装一个能独立复用的点。同一个依据支撑不同适用边界时，拆成两张，在「关联」里互链，不要合并——合并会丢掉边界。\n2. 数量由信息密度决定，不设上限也不凑数：常见 2–6 张，只有 1 张也行。整段都是闲聊就 NO_CARDS。\n3. 常识、百科、教材原文、客套、过程叙述一律不抄；只记「不查资料就想不起来、或容易踩坑」的部分。\n4. 原文的专有名词、型号、案号、条款号、数字与单位一律原样保留，不要改写或四舍五入。\n5. 案例卡可以留具体对象（公司名、金额、型号）；方法卡和判断卡里不写具体对象，只写通用的怎么判、怎么做。\n6. 数字不确定、说法有冲突：保留分歧并标「（待核实）」，写清由谁、用什么方式核。禁止编造数据和链接。\n7. 下面的模板是填空用的，尖括号和示例字都要换成这张卡的真实内容。**如果你输出的 title 或正文里出现了模板原文（比如「动宾短语」「对象 + 结论」「一句话说清：做什么、怎么判」），说明你抄了模板没写内容，必须重写成真实内容，写不出就说明不值得存、只输出 NO_CARDS。**\n\n【每张卡严格按模板，不加解释、序号、前后缀】\n---CARD---\ntitle: <这张卡的主题，动宾短语 8–18 字；案例卡写「对象 + 结论」>\ntags: <3–5 个词，第一个是主题域如 光伏/尽调/安防/家电，第二个是 方法/判断/案例，其余是关键词>\n## 结论\n<一句话说清：做什么、怎么判、这个对象是什么情况。>\n## 依据\n- <2–5 条关键事实、数据、机理，每条一句话；清单型可以多列几条>\n- 建议链接：[[<本段对话里出现过的已有概念>]]（找不到就写 [[待归类]]）\n## 适用边界\n- <什么条件下成立；什么情况下不适用，或最常见的错法>\n## 关联\n- [[<另一张卡的标题>]] · 支持/延伸/反驳/案例 · 一句话理由\n来源：[[YYYY-MM-DD 输入类型]]\n核实状态：未核实\n---END---\n\n【硬性要求】\n- 正文 150–500 字；任何一句脱离原文都能独立看懂\n- 链接只能用本段对话里出现过的概念，宁可写 [[待归类]]，不许编造\n- 除卡片块外不要输出任何文字；不值得存就只输出 NO_CARDS";

    const PAGE_STATE_SCRIPT = `(() => {
      const main = document.querySelector('main') || document.body;
      const text = (main && main.innerText ? main.innerText : '').trim();
      return { len: text.length, text: text.slice(-20000), href: location.href };
    })()`;

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    /** 点发送：按 aria-label → 表单提交 → 回车 → 同一容器里最后一个按钮 的顺序尝试。 */
    const SEND_SCRIPT = `(() => {
      const visible = (el) => {
        if (!el) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      };
      const selectors = ['#chat-input', 'textarea[placeholder]', 'textarea', '[contenteditable="true"]', '[role="textbox"]'];
      let input = null;
      for (const selector of selectors) {
        const found = Array.from(document.querySelectorAll(selector)).find(visible);
        if (found) { input = found; break; }
      }
      if (!input) return { ok: false, error: '页面上找不到输入框' };

      const labelOf = (el) => ((el.getAttribute('aria-label') || '') + ' ' + (el.title || '') + ' ' + (el.innerText || '')).toLowerCase();
      const hits = (el) => /发送|send|submit/.test(labelOf(el));

      for (const el of document.querySelectorAll('button, [role="button"], [data-testid]')) {
        if (!visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
        if (hits(el)) { el.click(); return { ok: true, how: 'label' }; }
      }

      const form = input.closest('form');
      if (form && typeof form.requestSubmit === 'function') {
        form.requestSubmit();
        return { ok: true, how: 'form' };
      }

      const fire = (type) => input.dispatchEvent(new KeyboardEvent(type, {
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
      }));
      fire('keydown');
      fire('keypress');
      fire('keyup');

      const box = input.closest('div');
      if (box) {
        const buttons = Array.from(box.querySelectorAll('button, [role="button"]')).filter((el) => visible(el) && !el.disabled);
        if (buttons.length > 0) {
          buttons[buttons.length - 1].click();
          return { ok: true, how: 'sibling' };
        }
      }
      return { ok: true, how: 'enter' };
    })()`;

    function hubError(message, detail) {
      const error = new Error(message);
      error.hubDetail = String(detail || "");
      return error;
    }

    /** 把 A：A：A：… 这种重复前缀折成一句（正则回溯会在长串上爆栈，这里用线性扫描）。 */
    function collapseRepeat(text) {
      const raw = String(text || "").slice(0, 4000);
      for (let len = 3; len <= 40; len += 1) {
        if (raw.length < len * 3) break;
        const unit = raw.slice(0, len);
        let times = 1;
        while (times < 300 && raw.slice(times * len, (times + 1) * len) === unit) times += 1;
        if (times >= 3) return unit + raw.slice(times * len);
      }
      return raw;
    }

    function tidy(text, limit) {
      let out = collapseRepeat(text);
      out = out.replace(/\s+/g, " ").trim();
      const max = limit || 400;
      return out.length > max ? `${out.slice(0, max)}…` : out;
    }

    function hostOf(href) {
      try {
        return new URL(href).host;
      } catch (problem) {
        return String(href || "未知页面");
      }
    }

    async function askPageAndWait(view, prompt, options) {
      const timeoutMs = (options && options.timeoutMs) || 90000;
      const onStage = (options && typeof options.onStage === "function") ? options.onStage : function () {};

      const before = await evalInPage(view, PAGE_STATE_SCRIPT, "读页面状态");
      const baseLen = Number(before && before.len) || 0;
      const href = String((before && before.href) || "");
      if (/sign_in|signin|\/login/i.test(href)) {
        throw hubError(
          "侧栏网页版还没登录",
          ["当前页面：" + href, "每次重启 DSH 后都要在侧栏重新登录一次网页版", "登录完成、能看到对话输入框后，再点第 2 步"].join("\n")
        );
      }
      onStage(`已连上 ${hostOf(href)}（正文 ${baseLen} 字）`);

      let injected = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        injected = await evalInPage(view, injectScript(prompt), "填输入框");
        if (injected && injected.ok === true) break;
        if (injected && injected.signIn) break;
        onStage(`输入框还没出来，${attempt + 1}/3 次重试…`);
        await sleep(1200);
      }
      if (!injected || injected.ok !== true) {
        throw hubError(
          `写不进输入框：${(injected && injected.error) || "未知原因"}`,
          ["页面：" + href, "正文：" + baseLen + " 字", "步骤：" + ((injected && injected.steps) || []).join(" | "), (injected && injected.signIn) ? "请在侧栏把网页版登录好，再点第 2 步" : "可能不是对话页，或输入框还没加载完"].join("\n")
        );
      }
      onStage(`规则已填进输入框（${injected.tag}），正在发送…`);

      await sleep(600);
      const sent = await evalInPage(view, SEND_SCRIPT, "点发送");
      if (!sent || sent.ok !== true) {
        throw hubError(
          `没发出去：${(sent && sent.error) || "找不到发送按钮"}`,
          [`页面：${href}`, `输入框：${injected.tag}`, "可以手动在网页版按一次回车"].join("\n")
        );
      }
      onStage(`已发出（${sent.how}），等回答，最多 ${Math.round(timeoutMs / 1000)} 秒…`);

      const started = Date.now();
      let lastLen = baseLen;
      let stable = 0;
      let nudges = 0;
      let tail = "";
      const mark = String(prompt).slice(0, 40);

      while (Date.now() - started < timeoutMs) {
        await sleep(2000);
        const now = await evalInPage(view, PAGE_STATE_SCRIPT, "读页面状态");
        const len = Number(now && now.len) || 0;
        const text = String((now && now.text) || "");
        if (text) tail = text.slice(-600);

        if (len > baseLen && len === lastLen) stable += 1;
        else stable = 0;

        const growth = len - baseLen;
        const seconds = Math.round((Date.now() - started) / 1000);

        if (growth > 0 && stable < 2) {
          onStage(`网页版在写（+${growth} 字，${seconds} 秒）…`);
        }
        lastLen = len;
        if (stable >= 2) return text;

        const echoed = text.includes(mark);
        if (growth <= 0 && !echoed && nudges === 0 && seconds > 8) {
          nudges = 1;
          onStage(`没看到新内容，再点一次发送（${seconds} 秒）…`);
          await evalInPage(view, SEND_SCRIPT, "点发送");
        } else if (growth <= 0 && !echoed && nudges === 1 && seconds > 25) {
          nudges = 2;
          onStage(`还是没动静，最后再试一次（${seconds} 秒）…`);
          await evalInPage(view, SEND_SCRIPT, "点发送");
        }
      }

      throw hubError(
        `网页版 ${Math.round(timeoutMs / 1000)} 秒没给出回答`,
        [
          `页面：${href}`,
          `输入框：${injected.tag}，发送方式：${sent.how}`,
          `正文长度：${baseLen} → ${lastLen}`,
          tail ? `页面末尾：…${tail.slice(-260)}` : "页面末尾：空",
        ].join("\n")
      );
    }

    async function knownTopicList(ctx) {
      try {
        const value = await callRpc(ctx, "cards.list", {});
        const titles = Array.isArray(value && value.knownTitles) ? value.knownTitles : [];
        return titles
          .map((title) => String(title || "").trim())
          .filter(Boolean)
          .slice(0, 60);
      } catch (problem) {
        return [];
      }
    }

    async function buildPrompt(ctx) {
      const custom = await callRpc(ctx, "prompt.get", {}).catch(() => null);
      const base = (custom && String(custom.text || "").trim()) || DISTILL_PROMPT;
      return base;
    }
    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text);
          return true;
        }
      } catch (error) {
        /* 回退到 execCommand */
      }
      try {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.cssText = "position:fixed;left:-9999px;top:0;";
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand("copy");
        area.remove();
        return ok;
      } catch (error) {
        return false;
      }
    }

    async function distillCards(ctx, onStage) {
      const stage = typeof onStage === "function" ? onStage : function () {};

      let view = findWebview();
      if (!view) {
        stage("侧栏里没有网页版，正在打开…");
        await openChat(ctx);
        await sleep(2500);
        view = findWebview();
      }
      if (!view) {
        throw hubError(
          "找不到侧栏里的网页版视图",
          ["请先点第 1 步打开网页版，确认侧栏里能看到 chat.deepseek.com", "如果侧栏开着但这里找不到，多半是页面还没加载完，等两秒再点第 2 步"].join("\n")
        );
      }

      const prompt = await buildPrompt(ctx);

      stage("正在把提炼规则发给网页版…");
      const text = await askPageAndWait(view, prompt, { timeoutMs: 90000, onStage: stage });

      stage("收到回答，正在拆成卡片…");
      const value = await callRpc(ctx, "cards.save", { text });
      const saved = (value.saved || []).length;
      if (saved === 0) {
        const blank = /NO_CARDS/i.test(text);
        const dupOnly = (value.skipped || []).filter((s) => /已有/.test(String(s.reason || ""))).length;
        return {
          message: blank
            ? "网页版判断这段对话没有值得沉淀的内容"
            : dupOnly
              ? `这 ${dupOnly} 张卡库里都已经有了，没有新卡`
              : "没识别到卡片格式，看下面网页版最后的输出",
          saved,
          raw: String(text || ""),
        };
      }
      const skipped = (value.skipped || []).length;
      return {
        message: skipped
          ? `收到 ${saved} 张新卡片，跳过 ${skipped} 张（已存在/模板）`
          : `收到 ${saved} 张新卡片，请逐张确认`,
        saved,
        raw: "",
      };
    }

    /* ------------------------------ styles ------------------------------ */

    const styles = {
      root: { display: "flex", flexDirection: "column", gap: 10, fontSize: 13, color: "inherit" },
      tabs: { display: "flex", gap: 6, borderBottom: "1px solid rgba(127,127,127,.25)", paddingBottom: 6 },
      tab: (active) => ({
        padding: "4px 10px",
        borderRadius: 6,
        cursor: "pointer",
        border: "1px solid transparent",
        background: active ? "rgba(85,140,255,.18)" : "transparent",
        color: "inherit",
        fontSize: 13,
      }),
      row: { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" },
      button: (primary) => ({
        padding: "5px 12px",
        borderRadius: 6,
        cursor: "pointer",
        border: "1px solid rgba(127,127,127,.35)",
        background: primary ? "rgba(85,140,255,.85)" : "transparent",
        color: primary ? "#fff" : "inherit",
        fontSize: 13,
      }),
      textarea: {
        width: "100%",
        minHeight: 110,
        padding: 8,
        borderRadius: 6,
        border: "1px solid rgba(127,127,127,.35)",
        background: "rgba(127,127,127,.08)",
        color: "inherit",
        fontFamily: "ui-monospace, Consolas, monospace",
        fontSize: 12,
        resize: "vertical",
        boxSizing: "border-box",
      },
      list: { display: "flex", flexDirection: "column", gap: 6, maxHeight: 280, overflowY: "auto" },
      item: (checked) => ({
        display: "flex",
        gap: 8,
        padding: "6px 8px",
        borderRadius: 6,
        border: `1px solid ${checked ? "rgba(85,140,255,.5)" : "rgba(127,127,127,.22)"}`,
        background: checked ? "rgba(85,140,255,.08)" : "transparent",
      }),
      title: { fontWeight: 600, marginBottom: 2 },
      meta: { fontSize: 11, opacity: 0.65 },
      badge: (uploaded) => ({
        fontSize: 10,
        padding: "1px 6px",
        borderRadius: 999,
        background: uploaded ? "rgba(60,180,120,.25)" : "rgba(230,160,60,.25)",
        marginLeft: 6,
      }),
      pre: {
        margin: 0,
        padding: 8,
        borderRadius: 6,
        background: "rgba(127,127,127,.08)",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        fontSize: 12,
        maxHeight: 260,
        overflowY: "auto",
        fontFamily: "inherit",
      },
      line: (tone) => ({ color: tone === "error" ? "#e06c75" : tone === "ok" ? "#5fb37a" : "inherit", fontSize: 12 }),
    };

    function Button(props) {
      return h(
        "button",
        { type: "button", onClick: props.onClick, disabled: props.disabled, style: styles.button(props.primary) },
        props.children
      );
    }

    /* ----------------------------- cards tab ----------------------------- */

    function CardsTab({ ctx, status, setStatus }) {
      const [text, setText] = useState("");
      const [showPaste, setShowPaste] = useState(false);
      const [cards, setCards] = useState([]);
      const [stats, setStats] = useState(null);
      const [openFile, setOpenFile] = useState("");
      const [detail, setDetail] = useState(null);
      const [showRules, setShowRules] = useState(false);
      const [rules, setRules] = useState("");
      const [rulesNote, setRulesNote] = useState("");
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState("");
      const [error, setError] = useState("");

      const load = useCallback(async () => {
        try {
          const value = await callRpc(ctx, "cards.list", {});
          setCards(value.cards || []);
          setStats(value.stats || null);
          setError("");
        } catch (problem) {
          setError(String(problem.message || problem));
        }
      }, [ctx]);

      useEffect(() => {
        load();
      }, [load]);

      const run = async (fn, label) => {
        setBusy(true);
        setError("");
        setMessage(label + "…");
        try {
          const result = await fn();
          setMessage(typeof result === "string" ? result : (result && result.message) || "完成");
          await load();
        } catch (problem) {
          setError(String(problem.message || problem));
          setMessage("");
        } finally {
          setBusy(false);
        }
      };

      const collect = () =>
        run(async () => {
          const value = await distillCards(ctx);
          return value.message;
        }, "正在让网页版整理这段对话");

      const saveOne = (file) =>
        run(async () => {
          const value = await callRpc(ctx, "cards.upload", { files: [file] });
          if (!value.ok) throw new Error(value.message || "保存失败");
          return "已存进云端";
        }, "保存中");

      const saveAll = () =>
        run(async () => {
          const value = await callRpc(ctx, "cards.list", {});
          const pending = (value.cards || []).filter((card) => !card.uploaded).map((card) => card.file);
          if (pending.length === 0) return "没有待确认的卡片";
          const result = await callRpc(ctx, "cards.upload", { files: pending });
          if (!result.ok) throw new Error(result.message || "保存失败");
          return result.message || "已全部存进云端";
        }, "保存全部");

      const drop = (file) =>
        run(async () => {
          const value = await callRpc(ctx, "cards.discard", { files: [file] });
          if (openFile === file) setOpenFile("");
          return value.message || "已丢掉";
        }, "丢掉");

      const paste = () =>
        run(async () => {
          const value = await callRpc(ctx, "cards.save", { text });
          setText("");
          const saved = (value.saved || []).length;
          return saved ? `收到 ${saved} 张新卡片` : value.message || "没识别到卡片";
        }, "解析中");

      const open = async (file) => {
        if (openFile === file) {
          setOpenFile("");
          setDetail(null);
          return;
        }
        setOpenFile(file);
        setDetail(null);
        try {
          setDetail(await callRpc(ctx, "cards.read", { file }));
        } catch (problem) {
          setError(String(problem.message || problem));
        }
      };

      const pendingCount = cards.filter((card) => !card.uploaded).length;

      const toggleRules = async () => {
        const next = !showRules;
        setShowRules(next);
        if (!next) return;
        try {
          const value = await callRpc(ctx, "prompt.get", {});
          setRules(value.text || "");
          setRulesNote(value.custom ? `正在用你自己的规则（${value.path}）` : "正在用默认规则");
        } catch (problem) {
          setRulesNote(`读取失败：${String(problem.message || problem)}`);
        }
      };

      const saveRules = () =>
        run(async () => {
          const value = await callRpc(ctx, "prompt.save", { text: rules });
          setRulesNote(`已保存（${value.chars} 字），下次「从网页版收新卡片」就按这个来`);
          return "提炼规则已更新";
        }, "保存规则");

      return h(
        "div",
        { style: styles.root },
        h(
          "div",
          { style: styles.meta },
          `这里放网页版整理好的记忆卡。新卡片 ${pendingCount} 张等你确认，已经存好的 ${stats ? stats.notes : 0} 张。`
        ),
        h(
          "div",
          { style: styles.row },
          h(Button, { primary: true, disabled: busy, onClick: collect }, "从网页版收新卡片"),
          h(Button, { disabled: busy || pendingCount === 0, onClick: saveAll }, `全部保存（${pendingCount}）`),
          h(Button, { disabled: busy, onClick: () => setShowPaste((v) => !v) }, showPaste ? "收起手动粘贴" : "手动粘贴"),
          h(Button, { disabled: busy, onClick: toggleRules }, showRules ? "收起提炼规则" : "提炼规则"),
          h(Button, { disabled: busy, onClick: () => load() }, "刷新")
        ),
        showRules
          ? h(
              "div",
              { style: styles.root },
              h(
                "div",
                { style: styles.meta },
                "这段提示词就是发给网页版的原文。改完保存，下次收卡片立即生效，不用重启。"
              ),
              h("textarea", {
                style: { ...styles.textarea, minHeight: 220 },
                value: rules,
                onChange: (event) => setRules(event.target.value),
              }),
              h(
                "div",
                { style: styles.row },
                h(Button, { primary: true, disabled: busy, onClick: saveRules }, "保存规则"),
                rulesNote ? h("span", { style: styles.meta }, rulesNote) : null
              )
            )
          : null,
        showPaste
          ? h(
              "div",
              { style: styles.root },
              h("textarea", {
                style: styles.textarea,
                value: text,
                placeholder: "把 ---CARD--- … ---END--- 格式的卡片整段粘进来",
                onChange: (event) => setText(event.target.value),
              }),
              h(Button, { disabled: busy, onClick: paste }, "解析这些卡片")
            )
          : null,
        busy ? h("div", { style: styles.line("ok") }, message) : message ? h("div", { style: styles.line("ok") }, message) : null,
        error ? h("div", { style: styles.line("error") }, error) : null,
        h(
          "div",
          { style: styles.list },
          cards.length === 0
            ? h(
                "div",
                { style: styles.meta },
                "还没有卡片。点上面的「从网页版收新卡片」，它会请网页版把这段对话整理成卡片，再回来给你确认。"
              )
            : cards.map((card) =>
                h(
                  "div",
                  { key: card.file, style: styles.item(!card.uploaded) },
                  h(
                    "div",
                    { style: { flex: 1, minWidth: 0 } },
                    h(
                      "div",
                      { style: styles.title },
                      card.title,
                      h("span", { style: styles.badge(card.uploaded) }, card.uploaded ? "已存" : "待你确认")
                    ),
                    card.tags && card.tags.length ? h("div", { style: styles.meta }, card.tags.map((tag) => `#${tag}`).join(" ")) : null,
                    h("div", { style: styles.meta }, card.preview),
                    openFile === card.file && detail
                      ? h("pre", { style: styles.pre }, detail.body)
                      : null,
                    h(
                      "div",
                      { style: { ...styles.row, marginTop: 6 } },
                      h("button", { type: "button", style: styles.button(false), onClick: () => open(card.file) }, openFile === card.file ? "收起" : "看看全文"),
                      card.uploaded
                        ? null
                        : h("button", { type: "button", style: styles.button(true), disabled: busy, onClick: () => saveOne(card.file) }, "保存这张"),
                      h("button", { type: "button", style: styles.button(false), disabled: busy, onClick: () => drop(card.file) }, card.uploaded ? "删除" : "不要了")
                    )
                  )
                )
              )
        )
      );
    }

    /* ----------------------------- memory tab ----------------------------- */

    function MemoryTab({ ctx, status, reload }) {
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState("");
      const [error, setError] = useState("");
      const [info, setInfo] = useState(status);

      useEffect(() => {
        setInfo(status);
      }, [status]);

      const sync = async (label) => {
        setBusy(true);
        setError("");
        setMessage(label + "…");
        try {
          const value = await callRpc(ctx, "memory.sync", { action: "push" });
          setMessage(value.message || "已同步");
          await reload();
        } catch (problem) {
          setError(String(problem.message || problem));
          setMessage("");
        } finally {
          setBusy(false);
        }
      };

      if (!info) return h("div", { style: styles.meta }, "正在读取记忆库状态…");

      return h(
        "div",
        { style: styles.root },
        h(
          "div",
          { style: styles.meta },
          `${info.memoryDir} · 分支 ${info.branch || "main"} · ${info.isRepo ? "git 仓库" : "不是 git 仓库"} · 未提交 ${info.dirty ?? 0} 个文件`
        ),
        h("div", { style: styles.meta }, `远端：${info.remote || "（未设置）"}　最近提交：${info.lastCommit || "（无）"}`),
        h("div", { style: styles.meta }, `归档 ${info.notes ?? 0} 条 · 核心记忆 ${info.coreChars ?? 0} 字符`),
        h(
          "div",
          { style: styles.row },
          h(Button, { primary: true, disabled: busy, onClick: () => sync("提交并推送") }, "提交并推送"),
          h(Button, { disabled: busy, onClick: () => reload() }, "刷新")
        ),
        message ? h("div", { style: styles.line("ok") }, message) : null,
        error ? h("div", { style: styles.line("error") }, error) : null,
        h("div", { style: styles.meta }, "核心记忆（每个会话常驻注入，改它请直接说「改核心记忆」）"),
        h("pre", { style: styles.pre }, info.core || "（空）")
      );
    }

    /* ------------------------------ web tab ------------------------------ */

    function WebTab({ ctx }) {
      const [progress, setProgress] = useState(null);
      const [history, setHistory] = useState([]);
      const [busy, setBusy] = useState(false);
      const [message, setMessage] = useState("");
      const [error, setError] = useState("");

      const load = useCallback(async () => {
        try {
          const [current, past] = await Promise.all([
            callRpc(ctx, "progress.read", {}),
            callRpc(ctx, "progress.history", {}),
          ]);
          setProgress(current);
          setHistory((past && past.items) || []);
          setError("");
        } catch (problem) {
          setError(String(problem.message || problem));
        }
      }, [ctx]);

      useEffect(() => {
        load();
      }, [load]);

      const guard = async (fn, label) => {
        setBusy(true);
        setError("");
        setMessage(label + "…");
        try {
          setMessage((await fn()) || "完成");
          await load();
        } catch (problem) {
          setError(String(problem.message || problem));
          setMessage("");
        } finally {
          setBusy(false);
        }
      };

      const grab = () =>
        guard(async () => {
          const page = await grabPage(ctx);
          const value = await callRpc(ctx, "progress.save", {
            text: page.text,
            meta: { source: page.href || CHAT_URL },
          });
          return `已抓取 ${value.chars} 字符，存到 progress.md`;
        }, "抓取网页版");

      const push = () =>
        guard(async () => {
          if (!progress || !progress.text) throw new Error("本地还没有网页版进度可以发送");
          return sendToPage(ctx, progress.text.slice(-6000));
        }, "发送到网页版");

      return h(
        "div",
        { style: styles.root },
        h("div", { style: styles.meta }, "网页版对话进度：抓下来存成 progress.md，旧稿自动进 history（保留最近 20 份），也可以把本地进度塞回网页版输入框。"),
        h(
          "div",
          { style: styles.row },
          h(Button, { primary: true, disabled: busy, onClick: () => guard(openChat(ctx), "打开网页版") }, "打开网页版"),
          h(Button, { disabled: busy, onClick: grab }, "抓取当前对话"),
          h(Button, { disabled: busy, onClick: push }, "发送到网页版"),
          h(Button, { disabled: busy, onClick: () => load() }, "刷新")
        ),
        message ? h("div", { style: styles.line("ok") }, message) : null,
        error ? h("div", { style: styles.line("error") }, error) : null,
        h("div", { style: styles.meta }, progress && progress.updated ? `progress.md 更新于 ${new Date(progress.updated).toLocaleString()}（${progress.chars} 字符）` : "还没有 progress.md"),
        h("pre", { style: styles.pre }, (progress && progress.text) || "（空）"),
        history.length
          ? h(
              "div",
              { style: { ...styles.list, maxHeight: 140 } },
              history.map((item) => h("div", { key: item.file, style: styles.meta }, `${item.file} — ${item.preview}`))
            )
          : null
      );
    }

    /* ------------------------------- panel ------------------------------- */

    function Panel({ ctx }) {
      const [tab, setTab] = useState("cards");
      const [status, setStatus] = useState(null);
      const [error, setError] = useState("");
      const [nameInput, setNameInput] = useState("");
      const [nameNote, setNameNote] = useState("");

      const reload = useCallback(async () => {
        try {
          setStatus(await callRpc(ctx, "status", {}));
          setError("");
        } catch (problem) {
          setError(String(problem.message || problem));
        }
      }, [ctx]);

      useEffect(() => {
        reload();
      }, [reload]);

      useEffect(() => {
        callRpc(ctx, "hub.settings", {})
          .then((value) => {
            const title = (value && value.title) || "";
            HUB_TITLE = title;
            setNameInput(title);
          })
          .catch(() => {});
      }, [ctx]);

      const saveName = async () => {
        try {
          const value = await callRpc(ctx, "hub.rename", { title: nameInput });
          HUB_TITLE = (value && value.title) || "";
          setNameInput(HUB_TITLE);
          setNameNote(HUB_TITLE ? `已改名为「${HUB_TITLE}」` : "已恢复默认名称");
          setTimeout(() => setNameNote(""), 2500);
        } catch (problem) {
          setNameNote(`改名失败：${String(problem.message || problem)}`);
        }
      };

      const tabs = [
        { key: "cards", label: "新卡片" },
        { key: "memory", label: "我的记忆" },
        { key: "web", label: "网页版" },
      ];

      return h(
        "div",
        { style: styles.root },
        h(
          "div",
          { style: styles.row },
          h("span", { style: styles.meta }, "名称"),
          h("input", {
            value: nameInput,
            placeholder: "记忆中枢",
            onChange: (event) => setNameInput(event.target.value),
            style: {
              flex: "1 1 180px",
              minWidth: 120,
              padding: "4px 8px",
              borderRadius: 6,
              border: "1px solid rgba(127,127,127,.35)",
              background: "rgba(127,127,127,.08)",
              color: "inherit",
              fontSize: 13,
            },
          }),
          h(Button, { onClick: saveName }, "保存"),
          nameNote ? h("span", { style: styles.meta }, nameNote) : null
        ),
        h(
          "div",
          { style: styles.tabs },
          tabs.map((item) =>
            h("div", { key: item.key, style: styles.tab(tab === item.key), onClick: () => setTab(item.key) }, item.label)
          )
        ),
        error ? h("div", { style: styles.line("error") }, `连接失败：${error}`) : null,
        tab === "cards" ? h(CardsTab, { ctx, status, setStatus }) : null,
        tab === "memory" ? h(MemoryTab, { ctx, status, reload }) : null,
        tab === "web" ? h(WebTab, { ctx }) : null
      );
    }

    /* --------------------------- 输入框工具栏 --------------------------- */

    const BRAIN_ICON = h(
      "svg",
      {
        width: 16,
        height: 16,
        viewBox: "0 0 24 24",
        fill: "none",
        stroke: "currentColor",
        strokeWidth: 1.6,
        strokeLinecap: "round",
        strokeLinejoin: "round",
        "aria-hidden": "true",
      },
      h("path", { d: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" }),
      h("path", { d: "M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" }),
      h("path", { d: "M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" }),
      h("path", { d: "M17.599 6.5a3 3 0 0 0 .399-1.375" }),
      h("path", { d: "M6.003 5.125A3 3 0 0 0 6.401 6.5" }),
      h("path", { d: "M3.477 10.896a4 4 0 0 1 .585-.396" }),
      h("path", { d: "M19.938 10.5a4 4 0 0 1 .585.396" }),
      h("path", { d: "M6 18a4 4 0 0 1-1.967-.516" }),
      h("path", { d: "M19.967 17.484A4 4 0 0 1 18 18" })
    );

    let menuNode = null;
    const onDocDown = (event) => {
      if (menuNode && !menuNode.contains(event.target)) closeMenu();
    };
    const onEsc = (event) => {
      if (event.key === "Escape") closeMenu();
    };

    function closeMenu() {
      if (!menuNode) return;
      const node = menuNode;
      menuNode = null;
      node.remove();
      document.removeEventListener("mousedown", onDocDown, true);
      document.removeEventListener("keydown", onEsc, true);
    }

    function menuButton(label, primary, onClick) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.style.cssText = [
        "display:block",
        "width:100%",
        "padding:7px 10px",
        "border-radius:7px",
        "font-size:13px",
        "text-align:left",
        "cursor:pointer",
        "border:1px solid " + (primary ? "rgba(85,140,255,.55)" : "rgba(127,127,127,.35)"),
        "background:" + (primary ? "rgba(85,140,255,.22)" : "transparent"),
        "color:inherit",
      ].join(";");
      button.addEventListener("click", onClick);
      return button;
    }

    function stepRow(index, label, state, hint, onClick) {
      const row = document.createElement("button");
      row.type = "button";
      const done = state === "done";
      const active = state === "active";
      row.style.cssText = [
        "display:flex",
        "align-items:center",
        "gap:9px",
        "width:100%",
        "padding:8px 9px",
        "border-radius:8px",
        "text-align:left",
        "cursor:pointer",
        "border:1px solid " + (active ? "rgba(85,140,255,.65)" : done ? "rgba(80,200,140,.35)" : "rgba(127,127,127,.26)"),
        "background:" + (active ? "rgba(85,140,255,.18)" : done ? "rgba(80,200,140,.10)" : "transparent"),
        "color:inherit",
        "font-size:13px",
      ].join(";");

      const badge = document.createElement("span");
      badge.textContent = done ? "✓" : String(index);
      badge.style.cssText = [
        "flex:0 0 auto",
        "width:20px",
        "height:20px",
        "border-radius:999px",
        "display:inline-flex",
        "align-items:center",
        "justify-content:center",
        "font-size:11px",
        "font-weight:600",
        "background:" + (done ? "rgba(80,200,140,.9)" : active ? "rgba(85,140,255,.95)" : "rgba(127,127,127,.26)"),
        "color:" + (done || active ? "#fff" : "rgba(231,234,242,.7)"),
      ].join(";");

      const text = document.createElement("span");
      text.style.cssText = "flex:1;min-width:0;";
      text.textContent = label;

      const tip = document.createElement("span");
      tip.style.cssText = "flex:0 0 auto;font-size:11px;opacity:.62;white-space:nowrap;";
      tip.textContent = hint || "";

      row.append(badge, text, tip);
      row.addEventListener("click", onClick);
      return row;
    }

    function openMenu(ctx, anchor, onChange) {
      if (menuNode) {
        closeMenu();
        return;
      }
      const box = document.createElement("div");
      box.style.cssText = [
        "position:fixed",
        "z-index:9999",
        "width:300px",
        "padding:10px",
        "border-radius:11px",
        "display:flex",
        "flex-direction:column",
        "gap:7px",
        "font-size:13px",
        "background:#242938",
        "color:#e7eaf2",
        "border:1px solid rgba(140,150,175,.35)",
        "box-shadow:0 10px 30px rgba(0,0,0,.45)",
        "visibility:hidden",
      ].join(";");

      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:baseline;gap:6px;";
      const name = document.createElement("span");
      name.textContent = titleOf();
      name.style.cssText = "font-weight:600;font-size:12px;opacity:.85;letter-spacing:.02em";
      const sub = document.createElement("span");
      sub.textContent = "记忆工作流";
      sub.style.cssText = "font-size:11px;opacity:.5";
      head.append(name, sub);
      box.appendChild(head);

      const progress = document.createElement("div");
      progress.style.cssText = "font-size:11px;opacity:.66;";
      box.appendChild(progress);

      const stepsBox = document.createElement("div");
      stepsBox.style.cssText = "display:flex;flex-direction:column;gap:6px;";
      box.appendChild(stepsBox);

      const status = document.createElement("div");
      status.style.cssText =
        "font-size:12px;opacity:.8;min-height:16px;white-space:pre-wrap;line-height:1.5;border-top:1px solid rgba(127,127,127,.18);padding-top:6px;";
      status.textContent = "正在读取状态…";
      box.appendChild(status);

      const say = (text) => {
        status.textContent = text;
      };

      const state = { total: 0, pending: 0, notes: 0, localNotes: 0, ahead: 0, dirty: 0, freshSaved: 0, hasView: false, running: false };
      const steps = [
        { label: "打开网页版", hint: () => (state.hasView ? "已开" : "点这里") },
        {
          label: "让网页版整理成卡片",
          hint: () => (HUB_SESSION.attempted > 0 ? `${HUB_SESSION.cards} 张` : "点这里"),
        },
        {
          label: "逐张确认并保存",
          hint: () =>
            state.pending > 0
              ? `${state.pending} 张待确认`
              : HUB_SESSION.attempted > 0
                ? state.freshSaved > 0
                  ? `本轮存了 ${state.freshSaved} 张`
                  : "已处理"
                : "",
        },
        {
          label: "备份到云端",
          hint: () =>
            HUB_SESSION.attempted === 0
              ? "还没有新卡片"
              : state.ahead > 0
                ? `${state.ahead} 个提交没推`
                : state.dirty > 0
                  ? "有改动没提交"
                  : "已同步",
        },
      ];

      const paint = () => {
        const done = [
          state.hasView,
          HUB_SESSION.attempted > 0,
          HUB_SESSION.attempted > 0 && state.pending === 0,
          HUB_SESSION.attempted > 0 && state.pending === 0 && state.ahead === 0 && state.dirty === 0,
        ];
        let current = done.findIndex((flag) => !flag);
        if (current < 0) current = 3;

        progress.textContent = `第 ${current + 1} 步 / 共 4 步 · ${steps[current].label}`;

        stepsBox.replaceChildren();
        steps.forEach((step, index) => {
          const indexStep = index + 1;
          let rowState = "todo";
          if (done[index]) rowState = "done";
          else if (index === current) rowState = "active";
          stepsBox.appendChild(
            stepRow(indexStep, step.label, rowState, step.hint(), () => runStep(index))
          );
        });
      };

      const load = async () => {
        try {
          const value = await callRpc(ctx, "cards.list", {});
          const allCards = Array.isArray(value.cards) ? value.cards : [];
          state.freshSaved = allCards.filter((c) => c.uploaded && c.mtime >= HUB_SESSION.startAt).length;
          HUB_SESSION.saved = state.freshSaved;
          state.total = (value.stats && value.stats.total) || 0;
          state.pending = (value.stats && value.stats.pendingFresh) || 0;
          state.notes = (value.stats && value.stats.notes) || 0;
          state.localNotes = (value.stats && value.stats.localNotes) || 0;
        } catch (problem) {
          say(`读取状态失败：${String((problem && problem.message) || problem).split("\n")[0]}`);
        }
        try {
          const repo = await callRpc(ctx, "status", {});
          state.ahead = Number(repo && repo.ahead) || 0;
          state.dirty = Number(repo && repo.dirty) || 0;
          if (repo && typeof repo.notes === "number") state.notes = repo.notes;
          if (repo && typeof repo.localNotes === "number") state.localNotes = repo.localNotes;
        } catch (problem) {
          /* 状态读不到就按未备份显示 */
        }
        state.hasView = !!findWebview();
        paint();
      };

      const runStep = async (index) => {
        if (state.running) return;
        state.running = true;
        try {
          if (index === 0) {
            say("第 1 步：正在打开网页版…");
            await openChat(ctx);
            await sleep(2500);
            state.hasView = !!findWebview();
            say(state.hasView ? "第 1 步完成：网页版已打开" : "没找到网页版视图，试试侧栏手动打开");
            paint();
          } else if (index === 1) {
            say("第 2 步：正在让网页版整理…");
            HUB_SESSION.startAt = Date.now();
            HUB_SESSION.attempted = 0;
            HUB_SESSION.cards = 0;
            HUB_SESSION.saved = 0;
            state.freshSaved = 0;
            paint();
            let value = null;
            try {
              value = await distillCards(ctx, (text) => say(`第 2 步：${text}`));
            } catch (problem) {
              const first = tidy(String((problem && problem.message) || problem).split("\n")[0], 240);
              const detail = tidy((problem && problem.hubDetail) || "", 900);
              const lines = [];
              const fullMessage = first + (detail ? "\n\n" + detail : "");
              say(`第 2 步没成功：${first}`);
              openReview(ctx, { message: fullMessage, raw: [detail, banner].filter(Boolean).join("\n") });
              return;
            }
            await load();
            await onChange();
            HUB_SESSION.attempted = 1;
            HUB_SESSION.cards = value.saved || 0;
            paint();
            if ((value.saved || 0) > 0) {
              say(`第 2 步完成：${value.message}`);
              openReview(ctx, {
                message: value.message,
                generated: { at: Date.now(), saved: value.saved || 0, skipped: value.skipped || 0 },
              });
            } else {
              say(`第 2 步没拿到卡片：${value.message}`);
              openReview(ctx, { message: value.message, raw: value.raw });
            }
          } else if (index === 2) {
            say("第 3 步：打开确认窗口…");
            openReview(ctx, {});
          } else {
            say("第 4 步：正在备份（commit + push）…");
            const value = await callRpc(ctx, "memory.sync", { action: "push" });
            await load();
            say(`第 4 步完成：${value.message || "已备份"}`);
          }
        } catch (problem) {
          say(`失败：${String((problem && problem.message) || problem).split("\n")[0]}`);
        } finally {
          state.running = false;
          paint();
        }
      };


      const copyRule = menuButton("复制整理规则（自己粘贴到网页版）", false, async () => {
        try {
          const text = await buildPrompt(ctx);
          const ok = await copyText(text);
          say(ok ? "规则已复制到剪贴板，去侧栏网页版粘贴后按回车" : "复制失败，请手动打开「提炼规则」复制");
        } catch (problem) {
          say("复制失败：" + String((problem && problem.message) || problem).split("\n")[0]);
        }
      });
      copyRule.style.fontSize = "12px";
      box.appendChild(copyRule);

      const pullLast = menuButton("收进网页版最后的回答", false, async () => {
        try {
          say("第 2 步（手动模式）：正在读网页版正文…");
          const page = await grabPage(ctx);
          const value = await callRpc(ctx, "cards.save", { text: page.text });
          const saved = Array.isArray(value.saved) ? value.saved.length : 0;
          const skipped = Number(value.skipped) || 0;
          HUB_SESSION.attempted = 1;
          HUB_SESSION.cards = saved;
          await load();
          say(saved ? `收到 ${saved} 张新卡片` : "没解析出卡片");
          openReview(ctx, {
            message: saved ? `收到 ${saved} 张新卡片${skipped ? `，跳过 ${skipped} 张（已存在/模板）` : ""}` : "网页版最后这段里没有 ---CARD--- 块，可能只回了普通文字",
            raw: String(page.text || "").slice(-900),
            generated: saved ? { at: Date.now(), saved, skipped } : null
          });
        } catch (problem) {
          say("收不进来：" + String((problem && problem.message) || problem).split("\n")[0]);
        }
      });
      pullLast.style.fontSize = "12px";
      box.appendChild(pullLast);

      document.body.appendChild(box);
      const rect = anchor ? anchor.getBoundingClientRect() : null;
      const width = box.offsetWidth;
      const height = box.offsetHeight;
      const left = rect ? Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) : 16;
      const top = rect ? Math.max(8, rect.top - height - 8) : 80;
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.visibility = "visible";
      menuNode = box;
      document.addEventListener("mousedown", onDocDown, true);
      document.addEventListener("keydown", onEsc, true);

      paint();
      load();
    }


    /* ----------------------------- 首次使用引导 ----------------------------- */

    let WELCOME_SHOWN = false;

    const CLOUD_MODES = [
      {
        id: "git",
        name: "Git 仓库",
        hint: "推到你自己的私有仓库，手机/多台电脑都能拉",
        yaml: [
          "- id: dsh-brain-hub",
          "  name: dsh-brain-hub",
          "  config:",
          "    backend: git",
          "    remote: 'https://github.com/<你>/<私有仓库>.git'",
          "    branch: main"
        ].join("\n")
      },
      {
        id: "folder",
        name: "OneDrive / 同步盘",
        hint: "把记忆库放进 OneDrive、坚果云这类已同步的文件夹，不用 git",
        yaml: [
          "- id: dsh-brain-hub",
          "  name: dsh-brain-hub",
          "  config:",
          "    backend: folder",
          "    memoryDir: 'C:\\Users\\<你>\\OneDrive\\brain-hub'"
        ].join("\n")
      },
      {
        id: "local",
        name: "只存本机",
        hint: "不联网、不备份，卡片只留在这台电脑",
        yaml: [
          "- id: dsh-brain-hub",
          "  name: dsh-brain-hub",
          "  config:",
          "    backend: local"
        ].join("\n")
      }
    ];

    function openWelcome(ctx) {
      const old = document.getElementById("dsh-brain-hub-welcome");
      if (old) old.remove();

      const layer = document.createElement("div");
      layer.id = "dsh-brain-hub-welcome";
      layer.style.cssText = [
        "position:fixed", "inset:0", "z-index:2147483100",
        "background:rgba(0,0,0,.55)", "display:flex", "align-items:center", "justify-content:center",
        "font:14px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif"
      ].join(";");

      const box = document.createElement("div");
      box.style.cssText = [
        "width:min(560px,92vw)", "max-height:86vh", "overflow:auto",
        "background:#1b1f24", "color:#e8eaed", "border:1px solid #333a42",
        "border-radius:14px", "padding:22px 22px 16px", "box-shadow:0 24px 64px rgba(0,0,0,.5)"
      ].join(";");

      const title = document.createElement("div");
      title.textContent = "欢迎使用 记忆中枢";
      title.style.cssText = "font-size:19px;font-weight:600;margin-bottom:6px;";
      box.appendChild(title);

      const lead = document.createElement("div");
      lead.textContent = "三步就能用起来，不用敲命令：";
      lead.style.cssText = "opacity:.75;margin-bottom:12px;";
      box.appendChild(lead);

      const steps = [
        ["1", "在侧栏打开网页版 DeepSeek 并登录（每次重启 DSH 后要重登一次）"],
        ["2", "和它正常聊天，聊完点会话顶栏那枚脑子图标"],
        ["3", "按四步走：打开网页版 → 整理成卡片 → 逐张确认 → 备份到云端"]
      ];
      for (const [num, text] of steps) {
        const row = document.createElement("div");
        row.style.cssText = "display:flex;gap:10px;margin:7px 0;";
        const badge = document.createElement("div");
        badge.textContent = num;
        badge.style.cssText = "flex:0 0 20px;height:20px;border-radius:50%;background:#2a4a7f;color:#cfe2ff;font-size:12px;text-align:center;line-height:20px;";
        const label = document.createElement("div");
        label.textContent = text;
        row.appendChild(badge);
        row.appendChild(label);
        box.appendChild(row);
      }

      const sub = document.createElement("div");
      sub.textContent = "记忆放在哪里，你选一个（之后也能改）：";
      sub.style.cssText = "margin:16px 0 8px;opacity:.75;";
      box.appendChild(sub);

      const preview = document.createElement("pre");
      preview.style.cssText = [
        "margin:0", "padding:10px 12px", "background:#12161a", "border:1px solid #2b333b",
        "border-radius:10px", "font:12px/1.55 ui-monospace,Consolas,monospace",
        "white-space:pre-wrap", "word-break:break-all", "color:#b9c6d4", "min-height:64px"
      ].join(";");

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.textContent = "复制这段配置";
      copyBtn.style.cssText = "margin-top:8px;padding:6px 12px;border-radius:8px;border:1px solid #3a4652;background:#20262c;color:#dbe4ee;cursor:pointer;";

      let chosen = CLOUD_MODES[0];
      const paintChoice = () => {
        preview.textContent = chosen.yaml;
        copyBtn.textContent = "复制「" + chosen.name + "」配置";
      };

      for (const mode of CLOUD_MODES) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = mode.name + " — " + mode.hint;
        btn.style.cssText = [
          "display:block", "width:100%", "text-align:left", "margin:6px 0",
          "padding:9px 12px", "border-radius:10px", "cursor:pointer",
          "border:1px solid #333a42", "background:#20262c", "color:#e8eaed", "font-size:13px"
        ].join(";");
        btn.onclick = () => {
          chosen = mode;
          for (const other of box.querySelectorAll("[data-mode]")) {
            other.style.borderColor = other === btn ? "#3f7dd4" : "#333a42";
            other.style.background = other === btn ? "#23324a" : "#20262c";
          }
          paintChoice();
        };
        btn.dataset.mode = mode.id;
        box.appendChild(btn);
      }

      box.appendChild(preview);
      box.appendChild(copyBtn);
      paintChoice();

      copyBtn.onclick = async () => {
        const ok = await copyText(chosen.yaml);
        copyBtn.textContent = ok ? "已复制，粘贴到 profile 的 cordis.patch.yml" : "复制失败，请手动选中";
        setTimeout(() => paintChoice(), 2200);
      };

      const tip = document.createElement("div");
      tip.textContent = "配置文件：<profile>\\cordis.patch.yml，改完重启 DSH 生效。";
      tip.style.cssText = "margin-top:14px;font-size:12px;opacity:.6;";
      box.appendChild(tip);

      const footer = document.createElement("div");
      footer.style.cssText = "display:flex;justify-content:flex-end;gap:10px;margin-top:16px;";

      const done = document.createElement("button");
      done.type = "button";
      done.textContent = "知道了，开始用";
      done.style.cssText = "padding:8px 16px;border-radius:9px;border:none;background:#3f7dd4;color:#fff;font-weight:600;cursor:pointer;";
      done.onclick = async () => {
        layer.remove();
        try {
          await callRpc(ctx, "hub.onboard", {});
        } catch (error) {
          /* 存不下也无所谓，下次再显示一遍 */
        }
      };

      footer.appendChild(done);
      box.appendChild(footer);

      layer.appendChild(box);
      layer.addEventListener("mousedown", (event) => {
        if (event.target === layer) layer.remove();
      });
      document.body.appendChild(layer);
    }

    function ToolbarEntry({ ctx }) {
      const [pending, setPending] = useState(0);
      const [hover, setHover] = useState(false);
      const [label, setLabel] = useState(() => titleOf());
      const anchorRef = useRef(null);

      const refresh = useCallback(async () => {
        try {
          const value = await callRpc(ctx, "cards.list", {});
          setPending((value.stats && value.stats.pending) || 0);
        } catch {
          /* 没有服务时安静失败，别在工具栏弹错 */
        }
      }, [ctx]);

      useEffect(() => {
        refresh();
      }, [refresh]);

      useEffect(() => {
        callRpc(ctx, "hub.settings", {})
          .then((value) => {
            HUB_TITLE = (value && value.title) || "";
            setLabel(titleOf());
            if (value && value.onboarded === false && !WELCOME_SHOWN) {
              WELCOME_SHOWN = true;
              setTimeout(() => openWelcome(ctx), 700);
            }
          })
          .catch(() => {});
      }, [ctx]);

      return h(
        "button",
        {
          ref: anchorRef,
          type: "button",
          title: pending > 0 ? `${label}：${pending} 张新卡片等你确认` : label,
          "aria-label": label,
          onClick: () => openMenu(ctx, anchorRef.current, refresh),
          onMouseEnter: () => setHover(true),
          onMouseLeave: () => setHover(false),
          style: {
            position: "relative",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: 28,
            padding: 0,
            borderRadius: 8,
            border: "1px solid transparent",
            background: hover ? "rgba(127,127,127,.18)" : "transparent",
            color: "inherit",
            cursor: "pointer",
            opacity: 0.85,
          },
        },
        BRAIN_ICON,
        pending > 0
          ? h(
              "span",
              {
                style: {
                  position: "absolute",
                  top: -2,
                  right: -2,
                  minWidth: 14,
                  height: 14,
                  padding: "0 3px",
                  borderRadius: 999,
                  background: "#4c8dff",
                  color: "#fff",
                  fontSize: 9,
                  lineHeight: "14px",
                  textAlign: "center",
                  fontWeight: 600,
                },
              },
              pending > 99 ? "99+" : String(pending)
            )
          : null
      );
    }

    /* --------------------------- 确认窗口 --------------------------- */

    const REVIEW_ID = "dsh-brain-hub-review";
    let reviewState = {
      open: false,
      busy: false,
      cards: [],
      stats: null,
      message: "",
      raw: "",
      expanded: "",
      showDup: false,
      generated: null,
    };
    let reviewCtx = null;

    function reviewLayer() {
      let node = document.getElementById(REVIEW_ID);
      if (!node) {
        node = document.createElement("div");
        node.id = REVIEW_ID;
        node.style.cssText =
          "position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;padding:16px 16px 88px;";
        node.addEventListener("mousedown", (event) => {
          if (event.target === node) closeReview();
        });
        document.body.appendChild(node);
      }
      return node;
    }

    function closeReview() {
      reviewState = { ...reviewState, open: false, message: "", raw: "", expanded: "" };
      const node = document.getElementById(REVIEW_ID);
      if (node) node.remove();
    }

    function rbtn(label, kind, onClick) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      const primary = kind === "primary";
      const danger = kind === "danger";
      button.style.cssText = [
        `padding:${primary ? "6px 14px" : "4px 10px"}`,
        `border-radius:${primary ? 8 : 6}px`,
        `font-size:${primary ? 13 : 12}px`,
        "cursor:pointer",
        primary ? "border:none" : "border:1px solid rgba(127,127,127,.35)",
        `background:${primary ? "rgba(76,141,255,.9)" : "transparent"}`,
        `color:${primary ? "#fff" : danger ? "rgba(255,140,140,.95)" : "inherit"}`,
        primary && reviewState.busy ? "opacity:.6" : "",
      ]
        .filter(Boolean)
        .join(";");
      button.disabled = primary && reviewState.busy;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      return button;
    }

    function reviewAction(ctx, fn, label) {
      reviewState = { ...reviewState, busy: true, message: `${label}…` };
      renderReview();
      Promise.resolve()
        .then(fn)
        .then((message) => openReview(ctx, { message }))
        .catch((problem) => {
          reviewState = {
            ...reviewState,
            busy: false,
            message: `失败：${String((problem && problem.message) || problem).split("\n")[0]}`,
          };
          renderReview();
        });
    }

    function renderReview() {
      const node = document.getElementById(REVIEW_ID);
      if (!reviewState.open) {
        if (node) node.remove();
        return;
      }
      const layer = reviewLayer();
      const allPending = reviewState.cards.filter((card) => !card.uploaded);
      const dups = allPending.filter((card) => card.exists);
      const pending = reviewState.showDup ? allPending : allPending.filter((card) => !card.exists);
      const shown = reviewState.showDup ? allPending : pending;

      const panel = document.createElement("div");
      panel.style.cssText =
        "width:min(620px,100%);max-height:72vh;overflow:auto;display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:14px;background:#1e2027;color:#e6e8ee;border:1px solid rgba(127,127,127,.28);box-shadow:0 18px 50px rgba(0,0,0,.55);font:13px/1.6 system-ui,sans-serif;";

      const head = document.createElement("div");
      head.style.cssText = "display:flex;align-items:center;gap:10px;";
      const title = document.createElement("strong");
      title.style.fontSize = "15px";
      title.textContent = pending.length ? `待确认的卡片 · ${pending.length} 张` : "新卡片";
      const spacer = document.createElement("span");
      spacer.style.flex = "1";
      head.append(title, spacer, rbtn("关闭", "ghost", closeReview));
      panel.appendChild(head);

      const stepLine = document.createElement("div");
      stepLine.style.cssText = "font-size:11px;opacity:.6;margin-top:-4px;";
      stepLine.textContent = pending.length
        ? "第 3 步 / 共 4 步 · 逐张确认并保存，保存后回到顶栏图标做第 4 步备份"
        : "第 3 步 / 共 4 步 · 没有待确认的卡片，可以回到第 2 步整理或第 4 步备份";
      panel.appendChild(stepLine);

      const status = document.createElement("div");
      status.style.cssText =
        "display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:rgba(230,232,238,.62);";
      const gen = reviewState.generated;
      const statusText = document.createElement("span");
      statusText.textContent = gen
        ? `生成状态：${new Date(gen.at).toLocaleTimeString("zh-CN", { hour12: false })} 生成 ${gen.saved} 张，${gen.skipped ? `跳过 ${gen.skipped} 张（已存在/模板）` : "无跳过"}`
        : `生成状态：${allPending.length} 张待确认${dups.length ? `，其中 ${dups.length} 张库里已有` : ""}`;
      status.appendChild(statusText);
      if (dups.length) {
        status.appendChild(
          rbtn(reviewState.showDup ? `隐藏已存在的（${dups.length}）` : `显示已存在的（${dups.length}）`, "ghost", () => {
            reviewState = { ...reviewState, showDup: !reviewState.showDup };
            renderReview();
          })
        );
      }
      panel.appendChild(status);

      if (reviewState.message) {
        const note = document.createElement("div");
        note.style.cssText =
          "font-size:12px;color:rgba(230,232,238,.78);background:rgba(127,127,127,.12);border-radius:8px;padding:8px 10px;white-space:pre-wrap;";
        note.textContent = reviewState.message;
        panel.appendChild(note);
      }

      if (reviewState.cards.length === 0 && reviewState.raw) {
        const wrap = document.createElement("div");
        wrap.style.fontSize = "12px";
        const caption = document.createElement("div");
        caption.style.cssText = "margin-bottom:6px;opacity:.7;";
        caption.textContent = "详细情况（可全选复制发我）：";
        const pre = document.createElement("pre");
        pre.style.cssText =
          "white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;font-size:11px;line-height:1.5;background:rgba(0,0,0,.35);border-radius:8px;padding:10px;margin:0;";
        pre.textContent = reviewState.raw.slice(-1200);
        wrap.append(caption, pre);
        panel.appendChild(wrap);
      }

      for (const card of shown) {
        const row = document.createElement("div");
        row.style.cssText =
          "display:flex;flex-direction:column;gap:6px;padding:10px 12px;border-radius:10px;background:rgba(127,127,127,.10);border:1px solid rgba(127,127,127,.18);";

        const line = document.createElement("div");
        line.style.cssText = "display:flex;gap:8px;align-items:center;flex-wrap:wrap;";
        const name = document.createElement("span");
        name.style.cssText = "font-weight:600;font-size:13px;word-break:break-word;";
        name.textContent = card.uploaded ? `✓ ${card.title}` : card.title;
        line.appendChild(name);
        if (Array.isArray(card.tags) && card.tags.length) {
          const tagLine = document.createElement("span");
          tagLine.style.cssText = "font-size:11px;color:rgba(230,232,238,.55);";
          tagLine.textContent = card.tags.map((tag) => `#${tag}`).join(" ");
          line.appendChild(tagLine);
        }
        row.appendChild(line);

        const expanded = reviewState.expanded === card.file;
        const body = document.createElement("div");
        body.style.cssText = "font-size:12px;color:rgba(230,232,238,.78);white-space:pre-wrap;";
        body.textContent = expanded ? card.preview || "" : (card.preview || "").slice(0, 120);
        row.appendChild(body);

        const actions = document.createElement("div");
        actions.style.cssText = "display:flex;gap:6px;flex-wrap:wrap;";
        if (!card.uploaded) {
          actions.appendChild(
            rbtn("存到云端", "primary", () =>
              reviewAction(
                reviewCtx,
                async () => {
                  const value = await callRpc(reviewCtx, "cards.upload", { files: [card.file] });
                  return value.message || "已保存 1 张";
                },
                "存云端"
              )
            )
          );
          actions.appendChild(
            rbtn("只存本地", "ghost", () =>
              reviewAction(
                reviewCtx,
                async () => {
                  const value = await callRpc(reviewCtx, "cards.upload", { files: [card.file], local: true });
                  return value.message || "已存到本地";
                },
                "存本地"
              )
            )
          );
        }
        actions.appendChild(
          rbtn(expanded ? "收起" : "看全文", "ghost", () => {
            reviewState = { ...reviewState, expanded: expanded ? "" : card.file };
            renderReview();
          })
        );
        if (!card.uploaded) {
          actions.appendChild(
            rbtn("不要了", "danger", () =>
              reviewAction(
                reviewCtx,
                async () => {
                  const value = await callRpc(reviewCtx, "cards.discard", { files: [card.file] });
                  return value.message || "已丢掉";
                },
                "丢掉"
              )
            )
          );
        }
        row.appendChild(actions);
        panel.appendChild(row);
      }

      const foot = document.createElement("div");
      foot.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;padding-top:2px;align-items:center;";
      foot.appendChild(
        rbtn(pending.length ? `全部存到云端（${pending.length}）` : "全部存到云端", "primary", () => {
          if (pending.length === 0) return;
          reviewAction(
            reviewCtx,
            async () => {
              const value = await callRpc(reviewCtx, "cards.upload", {
                files: pending.map((card) => card.file),
              });
              return value.message || `已保存 ${pending.length} 张`;
            },
            "全部存云端"
          );
        })
      );
      foot.appendChild(
        rbtn(pending.length ? `全部只存本地（${pending.length}）` : "全部只存本地", "ghost", () => {
          if (pending.length === 0) return;
          reviewAction(
            reviewCtx,
            async () => {
              const value = await callRpc(reviewCtx, "cards.upload", {
                files: pending.map((card) => card.file),
                local: true,
              });
              return value.message || `已存本地 ${pending.length} 张`;
            },
            "全部存本地"
          );
        })
      );
      foot.appendChild(rbtn("刷新", "ghost", () => openReview(reviewCtx, {})));
      if (reviewState.busy) {
        const busy = document.createElement("span");
        busy.style.cssText = "font-size:12px;opacity:.7;";
        busy.textContent = "处理中…";
        foot.appendChild(busy);
      }
      panel.appendChild(foot);

      layer.replaceChildren(panel);
    }

    async function openReview(ctx, options) {
      const opts = options || {};
      reviewCtx = ctx;
      reviewState = {
        ...reviewState,
        open: true,
        busy: true,
        message: opts.message || "",
        raw: opts.raw || "",
        generated: opts.generated || reviewState.generated,
        showDup: false,
      };
      renderReview();
      try {
        const value = await callRpc(ctx, "cards.list", {});
        reviewState = {
          ...reviewState,
          busy: false,
          cards: value.cards || [],
          stats: value.stats || null,
        };
      } catch (problem) {
        reviewState = {
          ...reviewState,
          busy: false,
          message: `读取新卡片失败：${String((problem && problem.message) || problem).split("\n")[0]}`,
        };
      }
      renderReview();
    }

    exports.name = "dsh-brain-hub";
    exports.inject = ["slots"];
    exports.apply = function apply(ctx) {
      try {
        ctx.effect(
          () =>
            ctx.slots.inject("settings.section", () =>
              ctx.slots.register(
                {
                  name: "settings.section",
                  id: "brain-hub",
                  order: 49,
                  label: () => "记忆中枢",
                },
                (props) => h(Panel, { ...(props || {}), ctx })
              )
            ),
          "brain-hub panel"
        );
      } catch (problem) {
        // 槽位不可用时别把整个客户端带崩
        // eslint-disable-next-line no-console
        console.warn("[dsh-brain-hub] 面板注册失败：", problem);
      }

      try {
        ctx.effect(
          () =>
            ctx.slots.inject("conversation.session.header.utilities", () =>
              ctx.slots.register(
                {
                  name: "conversation.session.header.utilities",
                  id: "brain-hub-header",
                  order: -1000,
                  label: () => "记忆中枢",
                },
                (props) => h(ToolbarEntry, { ...(props || {}), ctx })
              )
            ),
          "brain-hub header"
        );
      } catch (problem) {
        // eslint-disable-next-line no-console
        console.warn("[dsh-brain-hub] 顶栏按钮注册失败：", problem);
      }

    };

    return module.exports;
  },
});
