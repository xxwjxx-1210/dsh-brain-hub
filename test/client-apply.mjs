/**
 * dsh-brain-hub 客户端注册测试：伪造 window.__ModuleLoader__ 与最小 react，
 * 执行 dist/client.cjs 后调 apply，确认面板、顶栏图标、确认窗口都挂上了。
 * 跑法：node test/client-apply.mjs
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const bundle = fs.readFileSync(path.join(here, "..", "dist", "client.cjs"), "utf8");

let loaded = null;
globalThis.window = {
  __ModuleLoader__: {
    load(definition) {
      loaded = definition;
    },
  },
};

const react = {
  createElement: () => null,
  useState: (initial) => [initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  useRef: () => ({ current: null }),
};

new Function("window", "require", bundle)(globalThis.window, (id) => {
  if (id === "react") return react;
  throw new Error(`unexpected require: ${id}`);
});

let passed = 0;
const check = (label, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${label}`);
  } catch (error) {
    console.log(`  FAIL ${label}\n       ${String(error && error.message)}`);
    process.exitCode = 1;
  }
};

const injected = [];
const registered = [];
const fakeCtx = {
  effect(fn) {
    fn();
    return () => {};
  },
  slots: {
    inject(name, factory) {
      injected.push(name);
      return factory();
    },
    register(definition, component) {
      registered.push({ definition, component });
      return () => {};
    },
  },
};

check("bundle 已通过 ModuleLoader 注册", () => {
  assert.ok(loaded, "没有调用 window.__ModuleLoader__.load");
  assert.equal(loaded.id, "dsh-brain-hub");
  assert.equal(typeof loaded.factory, "function");
});

const exportsObject = loaded.factory((id) => {
  if (id === "react") return react;
  throw new Error(`unexpected require: ${id}`);
});

check("导出 name / inject / apply", () => {
  assert.equal(exportsObject.name, "dsh-brain-hub");
  assert.deepEqual(exportsObject.inject, ["slots"]);
  assert.equal(typeof exportsObject.apply, "function");
});

check("apply 不抛异常", () => {
  exportsObject.apply(fakeCtx);
});

check("注入面板与顶栏图标两个槽位", () => {
  assert.deepEqual(injected, ["settings.section", "conversation.session.header.utilities"]);
});

check("设置面板注册项字段正确", () => {
  assert.equal(registered.length, 2);
  const { definition, component } = registered[0];
  assert.equal(definition.name, "settings.section");
  assert.equal(definition.id, "brain-hub");
  assert.equal(definition.order, 49);
  assert.equal(typeof definition.label, "function");
  assert.equal(definition.label(), "记忆中枢");
  assert.equal(typeof component, "function");
});

check("工具栏图标注册项字段正确", () => {
  const { definition, component } = registered[1];
  assert.equal(definition.name, "conversation.session.header.utilities");
  assert.equal(definition.id, "brain-hub-header");
  assert.equal(definition.order, -1000);
  assert.equal(definition.label(), "记忆中枢");
  assert.equal(typeof component, "function");
});

check("确认窗口是独立 DOM 浮层，不依赖槽位", () => {
  const code = fs.readFileSync(path.join(here, "..", "dist", "client.cjs"), "utf8");
  assert.match(code, /dsh-brain-hub-review/);
  assert.match(code, /function openReview/);
  assert.doesNotMatch(code, /conversation\.input\.overlay/);
});

check("槽位异常时只警告不抛", () => {
  const original = console.warn;
  let warned = 0;
  console.warn = () => {
    warned += 1;
  };
  try {
    exportsObject.apply({
      effect() {
        throw new Error("no slot service");
      },
      slots: { inject: () => {}, register: () => {} },
    });
  } finally {
    console.warn = original;
  }
  assert.equal(warned, 2);
});

console.log(passed === 8 ? `\n全部通过：${passed} 项` : `\n失败，仅通过 ${passed} 项`);
