/**
 * UI 集成测试：在真实 DOM（jsdom）里跑 openPicker 与表情面板 tab，
 * 用桩替代 siyuan 模块与 SteamGridDB 接口，验证对话框结构、无 key 降级、
 * 检索参数、插入正文、设为文档图标、IME、尺寸切换、错误路径。
 *
 * 覆盖验收：3、4、5、6、7、8、9、10、11、12。
 *
 * 运行：node scripts/ui-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { JSDOM } from "jsdom";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "index.js"), "utf8");
const zhI18n = JSON.parse(fs.readFileSync(path.join(root, "i18n", "zh_CN.json"), "utf8"));

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
    if (cond) { pass++; console.log(`  ✓ ${name}`); }
    else { fail++; console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`); }
};

const dom = new JSDOM(`<!doctype html><html><body></body></html>`, { url: "http://127.0.0.1:6806/" });
const { window } = dom;

/* ── 记录网络调用 ──────────────────────────────── */
const calls = [];            // 全部 fetch
const uploads = [];          // /api/asset/upload 的 {dir, file}
const emojiFiles = new Map(); // putFile 写进 emojis 组的文件
const messages = [];         // showMessage
let sgdbAuthOk = true;       // 验收 11：切换成 success:false
let insertBlockCalled = false;

const json = (data) => ({ ok: true, status: 200, json: async () => data });

const fetchStub = async (url, opts = {}) => {
    const u = String(url);
    const headers = opts.headers || {};
    const rec = { url: u, method: opts.method || "GET", headers };
    calls.push(rec);

    if (u.startsWith("https://www.steamgriddb.com/api/v2/search/autocomplete/")) {
        if (!sgdbAuthOk || headers.Authorization !== "Bearer good-key") {
            return json({ success: false, errors: ["Authentication Required"] });
        }
        const term = decodeURIComponent(u.split("/autocomplete/")[1]);
        const data = term.toLowerCase().includes("elden")
            ? [
                  { id: 111, name: "Elden Ring Nightreign", types: ["steam"], verified: false },
                  { id: 5999, name: "Elden Ring", types: ["steam"], verified: true },
              ]
            : [];
        return json({ success: true, data });
    }
    if (u.startsWith("https://www.steamgriddb.com/api/v2/grids/game/")) {
        if (!sgdbAuthOk || headers.Authorization !== "Bearer good-key") {
            return json({ success: false });
        }
        rec.query = Object.fromEntries(new URLSearchParams(u.split("?")[1] || ""));
        return json({
            success: true,
            data: [
                { id: 12345, score: 98, url: "https://cdn2.steamgriddb.com/grid/abc.png", thumb: "https://cdn2.steamgriddb.com/thumb/abc.png", width: 600, height: 900, mimes: "image/png", author: { name: "someone" } },
                { id: 12346, score: 91, url: "https://cdn2.steamgriddb.com/grid/def.jpg", thumb: "https://cdn2.steamgriddb.com/thumb/def.jpg", width: 600, height: 900, mimes: "image/jpeg", author: { name: "other" } },
                { id: 12347, score: 88, url: "https://cdn2.steamgriddb.com/grid/ghi.jpg", thumb: "https://cdn2.steamgriddb.com/thumb/ghi.jpg", width: 600, height: 900, mimes: "image/jpeg" },
            ],
        });
    }
    if (u.includes("steamgriddb.com/grid/") || u.includes("steamgriddb.com/thumb/")) {
        return { ok: true, status: 200, blob: async () => ({ parts: ["fake-image"] }) };
    }
    if (u.includes("/api/file/readDir")) {
        return json({ code: 0, data: [...emojiFiles.keys()].map((n) => ({ name: n, isDir: false })) });
    }
    if (u.includes("/api/file/putFile")) {
        const p = opts.body && opts.body.entries ? opts.body.entries.get("path") : "";
        const name = p.split("/").pop();
        if (name) emojiFiles.set(name, true);
        return json({ code: 0, data: null });
    }
    if (u.includes("/api/attr/setBlockAttrs")) {
        rec.attr = JSON.parse(opts.body);
        return json({ code: 0, data: null });
    }
    if (u.includes("/api/asset/upload")) {
        const dir = opts.body && opts.body.entries ? opts.body.entries.get("assetsDirPath") : "";
        const file = opts.body && opts.body.entries ? opts.body.entries.get("file[]") : "";
        uploads.push({ dir, file });
        return json({ code: 0, data: { succMap: { [file]: `assets/game-covers/${file}` } } });
    }
    if (u.includes("/api/block/insertBlock")) {
        insertBlockCalled = true;
        return json({ code: 0 });
    }
    return { ok: false, status: 404, json: async () => ({ code: 404 }) };
};

class FD {
    constructor() { this.entries = new Map(); }
    append(k, v, name) { this.entries.set(k, name !== undefined ? name : v); }
}

/* ── siyuan 模块桩 ─────────────────────────────── */
class FakePlugin {
    constructor() {
        this.name = "siyuan-plugin-game-covers";
        this.i18n = zhI18n;
        this.eventBus = { on() {} };
    }
    addIcons() {}
    addCommand() {}
    addTopBar() {}
    addBreadcrumbButton() {}
    async loadData() { return null; }
    async saveData(k, v) { (this.saved ||= {})[k] = v; }
}

class FakeSetting {
    constructor(opts) { this.opts = opts; this.items = []; }
    addItem(i) { this.items.push(i); }
}

const dialogInstances = [];
const fakeDialog = class {
    constructor(opts) {
        this.opts = opts;
        dialogInstances.push(opts);
        const wrap = window.document.createElement("div");
        wrap.innerHTML = opts.content;
        this.element = wrap;
        window.document.body.appendChild(wrap);
    }
    destroy() { this.element.remove(); }
};

/* 编辑器桩 */
const UI_DOC_ID = "20260202-uidoc";
let uiIconRefreshed = null;
const wysiwygEl = window.document.createElement("div");
wysiwygEl.className = "protyle-wysiwyg";
Object.defineProperty(wysiwygEl, "isConnected", { get: () => true });
window.document.body.appendChild(wysiwygEl);

const fakeProtyle = {
    block: { rootID: UI_DOC_ID },
    element: { classList: { contains: () => false }, contains: () => true },
    wysiwyg: { element: wysiwygEl },
    focus() {},
    insert(html) {
        const tpl = window.document.createElement("div");
        tpl.innerHTML = html;
        while (tpl.firstChild) wysiwygEl.appendChild(tpl.firstChild);
    },
    background: {
        ial: {},
        render() { uiIconRefreshed = this.ial.icon; },
    },
    model: { parent: { setDocIcon: (v) => { uiIconRefreshed = v; } } },
};

const menuInstances = [];
class FakeMenu {
    constructor() { this.items = []; menuInstances.push(this); }
    addItem(i) { this.items.push(i); }
    open() {}
    findByLabel(l) { return this.items.find((i) => i.label === l); }
}

const sandbox = {
    console,
    fetch: fetchStub,
    document: window.document,
    window: window,
    URLSearchParams,
    setTimeout,
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    MutationObserver: window.MutationObserver,
    FormData: FD,
    Blob: class { constructor(p) { this.parts = p; } },
    require: (m) => (m === "siyuan" ? {
        Plugin: FakePlugin,
        Dialog: fakeDialog,
        Menu: FakeMenu,
        showMessage: (msg) => messages.push(msg),
        getAllEditor: () => [{ protyle: fakeProtyle }],
        Setting: FakeSetting,
    } : null),
    module: { exports: {} },
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: "index.js" });
const Plugin = sandbox.module.exports;

const p = new Plugin();
await p.onload();

const q = (sel) => window.document.querySelector(sel);
const qa = (sel) => [...window.document.querySelectorAll(sel)];
const cards = () => qa(".gcv-card");
const sgdbCalls = () => calls.filter((c) => c.url.includes("steamgriddb.com"));
const gridsCalls = () => sgdbCalls().filter((c) => c.url.includes("/grids/game/"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 打开面板、输入关键词、回车，等搜索完成 */
async function searchInPicker(term = "elden ring") {
    p.openPicker(UI_DOC_ID);
    await sleep(30);
    const input = q(".gcv-search");
    input.value = term;
    input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(80);
    return input;
}

console.log("1) 打开选择器（结构）");
p.openPicker(UI_DOC_ID);
await sleep(30);
check("根容器 .gcv 存在", !!q(".gcv"));
check("有搜索框 .gcv-search", !!q(".gcv-search"));
check("有 3 个尺寸 chips", qa(".gcv-chip").length === 3, `实际 ${qa(".gcv-chip").length}`);
check("chips 是 竖版/横版/方形",
    qa(".gcv-chip").map((c) => c.dataset.d).join(",") === "600x900,460x215,512x512");
check("默认停在竖版", qa(".gcv-chip").find((c) => c.dataset.d === "600x900")?.classList.contains("on"));
check("有计数行与提示行", !!q(".gcv-count") && !!q(".gcv-hint"));
check("有网格 .gcv-grid", !!q(".gcv-grid"));
const lastDialog = dialogInstances[dialogInstances.length - 1];
check("对话框 920×680", lastDialog?.width === "920px" && lastDialog?.height === "680px",
    `${lastDialog?.width} × ${lastDialog?.height}`);
qa(".gcv").forEach((el) => el.closest(".b3-dialog__content")?.parentElement.remove());

console.log("2) 没填 key：零请求 + needKey 引导（验收 8）");
p.openPicker(UI_DOC_ID);
await sleep(30);
check("打开面板即显示 needKey 文案", q(".gcv-notice")?.textContent.includes(zhI18n.needKey));
check("带免费申请链接", !!q(".gcv-notice a[href*='steamgriddb.com/profile/preferences/api']"));
check("主按钮是「去申请」直达申请页", !!q(".gcv-notice .gcv-go-apply[href*='steamgriddb.com/profile/preferences/api']"),
    q(".gcv-go-apply")?.getAttribute("href"));
check("保留打开设置按钮", !!q(".gcv-open-settings"));
const callsBefore = calls.length;
let input = q(".gcv-search");
input.value = "elden";
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(80);
check("搜索时零请求", calls.length === callsBefore, `多出 ${calls.length - callsBefore} 个`);
check("needKey 文案仍在（不弹错误框）", q(".gcv-notice")?.textContent.includes(zhI18n.needKey));
check("没有弹任何 showMessage", messages.length === 0, messages.join("|"));
qa(".gcv").forEach((el) => el.closest(".b3-dialog__content")?.parentElement.remove());
messages.length = 0;

console.log("3) 填 key 搜索：请求时序与参数（验收 9/10）");
p.sgdbKey = "good-key";
input = await searchInPicker("elden ring");
const sg = sgdbCalls();
check("先请求 /search/autocomplete/，再请求 /grids/game/",
    sg.length === 2 && sg[0].url.includes("/search/autocomplete/") && sg[1].url.includes("/grids/game/"),
    sg.map((c) => c.url).join(" | "));
check("autocomplete 带 Bearer", sg[0]?.headers.Authorization === "Bearer good-key");
check("grids 带 Bearer", sg[1]?.headers.Authorization === "Bearer good-key");
check("取 verified 游戏（Elden Ring 本体）", sg[1]?.url.includes("/grids/game/5999"), sg[1]?.url);
const qs = new URLSearchParams(sg[1]?.url.split("?")[1] || "");
check("query 含 dimensions=600x900", qs.get("dimensions") === "600x900", qs.get("dimensions"));
check("query 含 mimes=image/jpeg,image/png", qs.get("mimes") === "image/jpeg,image/png", qs.get("mimes"));
check("query 含 nsfw=false", qs.get("nsfw") === "false", qs.get("nsfw"));
check("query 含 humor=false", qs.get("humor") === "false", qs.get("humor"));
check("计数显示 共 3 个结果", q(".gcv-count")?.textContent === zhI18n.countResult.replace("$1", "3"),
    q(".gcv-count")?.textContent);
check("渲染出 3 张卡片", cards().length === 3, `实际 ${cards().length}`);
check("列表用 thumb 不用原图", cards().every((c) => c.querySelector("img")?.getAttribute("src").includes("/thumb/")));
check("卡片不显示标题（tooltip 承担）", !cards()[0].querySelector(".gcv-name") && !!cards()[0].getAttribute("title"));
check("tooltip 是游戏本体名", cards()[0].getAttribute("title").startsWith("Elden Ring"),
    cards()[0].getAttribute("title"));
check("卡片带设为文档图标按钮", !!cards()[0].querySelector('button[data-act="docicon"]'));

console.log("4) success:false（HTTP 200）→ authFailed（验收 11）");
qa(".gcv").forEach((el) => el.closest(".b3-dialog__content")?.parentElement.remove());
sgdbAuthOk = false;
p.sgdbKey = "wrong-key";
input = await searchInPicker("elden ring");
check("不渲染空列表当结果", cards().length === 0);
check("显示 authFailed 文案", q(".gcv-notice")?.textContent.includes(zhI18n.authFailed),
    q(".gcv-notice")?.textContent);
sgdbAuthOk = true;
p.sgdbKey = "good-key";
qa(".gcv").forEach((el) => el.closest(".b3-dialog__content")?.parentElement.remove());

console.log("5) 尺寸 chip 切换改 dimensions（验收 12）");
input = await searchInPicker("elden ring");
check("初始 grids 请求是 600x900", gridsCalls().at(-1)?.query?.dimensions === "600x900");
const before = gridsCalls().length;
qa(".gcv-chip").find((c) => c.dataset.d === "460x215")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);
check("chip 变为选中态", qa(".gcv-chip").find((c) => c.dataset.d === "460x215")?.classList.contains("on"));
check("切换后重新查询（有词立即重查）", gridsCalls().length === before + 1, `grids 请求 +${gridsCalls().length - before}`);
check("dimensions 从 600x900 变成 460x215", gridsCalls().at(-1)?.query?.dimensions === "460x215",
    gridsCalls().at(-1)?.query?.dimensions);
input.value = "";
const before2 = sgdbCalls().length;
qa(".gcv-chip").find((c) => c.dataset.d === "512x512")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(50);
check("搜索框没词时切 chip 不发请求", sgdbCalls().length === before2);
qa(".gcv").forEach((el) => el.closest(".b3-dialog__content")?.parentElement.remove());
input = await searchInPicker("elden ring");
qa(".gcv-chip").find((c) => c.dataset.d === "512x512")
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(80);
check("方形 dimensions=512x512", gridsCalls().at(-1)?.query?.dimensions === "512x512",
    gridsCalls().at(-1)?.query?.dimensions);
qa(".gcv").forEach((el) => el.closest(".b3-dialog__content")?.parentElement.remove());

console.log("6) 点卡片 = 插入正文，不是设图标（验收 3）");
input = await searchInPicker("elden ring");
calls.length = 0;
uploads.length = 0;
wysiwygEl.innerHTML = "";
cards()[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(120);
check("没有调用 setBlockAttrs", !calls.some((c) => c.attr));
check("调用了 /api/asset/upload", uploads.length === 1, `实际 ${uploads.length}`);
check("assetsDirPath 带 /assets/game-covers/ 结尾斜杠", uploads[0]?.dir === "/assets/game-covers/", uploads[0]?.dir);
check("文件名 = 游戏名-网格id.png（不是只有游戏名）", uploads[0]?.file === "Elden Ring-12345.png", uploads[0]?.file);
const insertedImg = wysiwygEl.querySelector("img");
check("正文里插入了 img", !!insertedImg);
check("img 指向 /assets/game-covers/", (insertedImg?.getAttribute("src") || "").includes("/assets/game-covers/"),
    insertedImg?.getAttribute("src"));
check("img 有 alt", !!insertedImg?.getAttribute("alt"));
check("对话框已关闭", !q(".gcv"));
check("提示已插入", messages.some((m) => m.includes("已插入")), messages.join("|"));
check("同 id 走缓存不再上传", p.assetCache.has(12345));
messages.length = 0;

console.log("7) 悬停按钮 = 设为文档图标（验收 4）");
input = await searchInPicker("elden ring");
calls.length = 0;
uploads.length = 0;
uiIconRefreshed = null;
cards()[0].querySelector('button[data-act="docicon"]')
    .dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(120);
const attrCall = calls.find((c) => c.attr);
check("点按钮才调 setBlockAttrs", !!attrCall);
check("块 id 正确", attrCall?.attr?.id === UI_DOC_ID, attrCall?.attr?.id);
check("icon 值匹配 ^game-covers/.+\\.(jpg|png)$",
    /^game-covers\/.+\.(jpg|png)$/.test(attrCall?.attr?.attrs?.icon || ""), attrCall?.attr?.attrs?.icon);
check("icon 值不带 /emojis/ 前缀", !(attrCall?.attr?.attrs?.icon || "").includes("/emojis/"));
check("封面已写入 data/emojis/game-covers/", emojiFiles.has("Elden Ring-12345.png"),
    [...emojiFiles.keys()].join(","));
check("background.ial.icon 已刷新", uiIconRefreshed === attrCall?.attr?.attrs?.icon, String(uiIconRefreshed));
check("对话框已关闭", !q(".gcv"));
check("提示图标已应用", messages.some((m) => m.includes("图标已应用")), messages.join("|"));
messages.length = 0;

console.log("8) 右键菜单两个选项都在");
input = await searchInPicker("elden ring");
menuInstances.length = 0;
cards()[0].dispatchEvent(new window.MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
const capturedMenu = menuInstances[menuInstances.length - 1];
check("右键弹出菜单", !!capturedMenu);
check("菜单含「插入到正文」", !!capturedMenu?.findByLabel(zhI18n.insertBody),
    capturedMenu?.items.map((i) => i.label).join(","));
check("菜单含「设为文档图标」", !!capturedMenu?.findByLabel(zhI18n.setAsDocIcon),
    capturedMenu?.items.map((i) => i.label).join(","));
qa(".gcv").forEach((el) => el.closest(".b3-dialog__content")?.parentElement.remove());

console.log("9) 回车两次 = 插入第一个结果");
input = await searchInPicker("elden ring");
calls.length = 0;
uploads.length = 0;
wysiwygEl.innerHTML = "";
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(120);
check("插入的是第一个结果（12345）", (wysiwygEl.querySelector("img")?.getAttribute("src") || "").includes("12345"),
    wysiwygEl.querySelector("img")?.getAttribute("src"));
check("对话框已关闭", !q(".gcv"));
qa(".gcv").forEach((el) => el.closest(".b3-dialog__content")?.parentElement.remove());

console.log("10) 中文输入法：组词时回车不提交（验收 5）");
input = await searchInPicker("zzz-empty");
qa(".gcv").forEach((el) => el.closest(".b3-dialog__content")?.parentElement.remove());
p.openPicker(UI_DOC_ID);
await sleep(30);
input = q(".gcv-search");
const imeBase = sgdbCalls().length;
input.dispatchEvent(new window.CompositionEvent("compositionstart", { bubbles: true }));
input.value = "el";
input.dispatchEvent(new window.Event("input", { bubbles: true }));
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));
await sleep(60);
check("isComposing 回车不提交", sgdbCalls().length === imeBase, `多出 ${sgdbCalls().length - imeBase}`);
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", keyCode: 229, bubbles: true }));
await sleep(60);
check("keyCode 229 回车不提交", sgdbCalls().length === imeBase);
input.dispatchEvent(new window.CompositionEvent("compositionend", { bubbles: true }));
await sleep(60);
check("组词结束也不自动请求（查询走回车）", sgdbCalls().length === imeBase);
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(80);
check("正常回车仍然查询", sgdbCalls().length > imeBase);

console.log("11) Esc：先清空，再关闭");
check("输入框有词", !!input.value);
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await sleep(30);
check("Esc 清空搜索框", input.value === "" && !!q(".gcv"));
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
await sleep(30);
check("再按 Esc 关闭面板", !q(".gcv"));

console.log("12) 空 keyword 回车给提示，不发请求（验收 8 补充）");
p.openPicker(UI_DOC_ID);
await sleep(30);
input = q(".gcv-search");
const base2 = sgdbCalls().length;
input.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(50);
check("空词不请求", sgdbCalls().length === base2);
check("提示先输入游戏名", q(".gcv-notice")?.textContent.includes(zhI18n.emptyKeyword));
qa(".gcv").forEach((el) => el.closest(".b3-dialog__content")?.parentElement.remove());

console.log("13) 表情面板：注入 tab（验收 6）");
window.document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="b3-dialog"><div class="emojis">
        <div class="emojis__tabheader">
            <div data-type="tab-emoji" class="block__icon"></div><div class="fn__space"></div>
            <div data-type="tab-custom" class="block__icon"></div><div class="fn__space"></div>
            <div data-type="tab-dynamic" class="block__icon"></div><div class="fn__space"></div>
            <div data-type="tab-link" class="block__icon"></div><div class="fn__space"></div>
        </div>
        <div class="emojis__tabbody">
            <div data-type="tab-emoji"></div>
            <div class="fn__none" data-type="tab-dynamic"></div>
        </div>
     </div></div>`
);
p.watchEmojiDialog();
await sleep(30);

let tab = q(".gcv-emoji-tab");
check("注入了 tab 图标", !!tab);
check("tab 带插件图标 iconGameCovers", /iconGameCovers/.test(tab?.innerHTML || ""));
check("tab 带 data-type=tab-game", tab?.getAttribute("data-type") === "tab-game");
check("注入了对应内容面板", !!q('.gcv-ep[data-type="tab-game"]'));

tab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
const pane = q(".gcv-ep");
check("点击后内容面板展开", !pane.classList.contains("fn__none"));
check("tab 变为选中态", tab.classList.contains("block__icon--active"));
check("其他 tab 内容被收起",
    q('.emojis__tabbody > [data-type="tab-emoji"]').classList.contains("fn__none"));
check("pane 自带搜索框", !!q(".gcv-ep-search"));
check("pane 自带尺寸 chips（3 个）", qa(".gcv-ep-chip").length === 3, `实际 ${qa(".gcv-ep-chip").length}`);

check("重复调 watchEmojiDialog 不注入第二个 tab", (() => {
    p.watchEmojiDialog();
    return qa(".gcv-emoji-tab").length === 1;
})());

console.log("14) 表情面板：搜索并展示封面");
const epInput = q(".gcv-ep-search");
const base3 = sgdbCalls().length;
epInput.value = "elden";
epInput.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(80);
check("pane 内回车触发检索", sgdbCalls().length === base3 + 2, `多出 ${sgdbCalls().length - base3}`);
check("pane 渲染出封面项", qa(".gcv-ep-item").length === 3, `实际 ${qa(".gcv-ep-item").length}`);
check("pane 封面用 thumb", qa(".gcv-ep-item").every((el) => el.querySelector("img")?.getAttribute("src").includes("/thumb/")));

console.log("15) 标头模式（垃圾桶可见）= 只设图标（验收 7a）");
q(".b3-dialog").insertAdjacentHTML("beforeend", '<span class="block__icon" data-action="remove"></span>');
calls.length = 0;
uploads.length = 0;
wysiwygEl.innerHTML = "";
uiIconRefreshed = null;
qa(".gcv-ep-item")[0].dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(120);
check("调用了 setBlockAttrs", !!calls.find((c) => c.attr));
check("没有插入到正文", !wysiwygEl.querySelector("img"));
check("没有上传 assets", uploads.length === 0, JSON.stringify(uploads));
check("icon 值格式正确",
    /^game-covers\/.+\.(jpg|png)$/.test(calls.find((c) => c.attr)?.attr?.attrs?.icon || ""),
    calls.find((c) => c.attr)?.attr?.attrs?.icon);
check("标题图标已刷新", !!uiIconRefreshed, String(uiIconRefreshed));
check("面板用完关闭", !q(".emojis"));

console.log("16) 插入模式（垃圾桶 fn__none）= 只插正文（验收 7b）");
window.document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="b3-dialog"><div class="emojis">
        <div class="emojis__tabheader">
            <div data-type="tab-link" class="block__icon"></div><div class="fn__space"></div>
            <span class="block__icon fn__none" data-action="remove"></span>
        </div>
        <div class="emojis__tabbody"><div data-type="tab-emoji"></div></div>
     </div></div>`
);
p.watchEmojiDialog();
await sleep(30);
const tab2 = [...qa(".gcv-emoji-tab")].pop();
tab2.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(60);
const epInput2 = [...qa(".gcv-ep-search")].pop();
epInput2.value = "elden";
epInput2.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
await sleep(80);
calls.length = 0;
wysiwygEl.innerHTML = "";
[...qa(".gcv-ep-item")].at(-1).dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
await sleep(120);
check("插入模式不改文档图标", !calls.some((c) => c.attr));
check("插入模式下正文出现图片", !!wysiwygEl.querySelector("img"));
check("插入模式图片指向 assets",
    (wysiwygEl.querySelector("img")?.getAttribute("src") || "").includes("/assets/game-covers/"),
    wysiwygEl.querySelector("img")?.getAttribute("src"));
check("面板用完关闭", !q(".emojis"));

console.log("17) onunload 断开 MutationObserver");
let disconnected = false;
const realObserver = p.emojiObserver;
realObserver.disconnect = () => { disconnected = true; };
p.onunload();
check("observer 已 disconnect", disconnected === true);
check("observer 引用已清空", p.emojiObserver === null);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
