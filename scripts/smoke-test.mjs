/**
 * 无头冒烟测试：用桩替代 siyuan 模块，验证插件纯逻辑。
 * 覆盖验收：1（vm 解析导出类）、2（注册项与快捷键）、9/10（检索请求时序与参数）、
 * 13（README 四步 + 描述点明 key），外加 i18n 对齐、名称清洗、界面刷新。
 *
 * 运行：node scripts/smoke-test.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "index.js"), "utf8");

let pass = 0;
let fail = 0;
const check = (name, cond, extra) => {
    if (cond) {
        pass++;
        console.log(`  ✓ ${name}`);
    } else {
        fail++;
        console.log(`  ✗ ${name}${extra ? " — " + extra : ""}`);
    }
};

/* ── 桩：getAllEditor 返回的编辑器 ──────────────── */
const DOC_ID = "20260101-rootdoc";
let iconRefreshed = null;
const fakeProtyle = {
    id: "protyle-1",
    block: { rootID: DOC_ID, id: DOC_ID },
    element: {
        classList: { contains: () => false },
        contains: () => false,
        querySelector: () => null,
    },
    title: { element: { querySelector: () => null } },
    background: {
        ial: {},
        render() {
            iconRefreshed = this.ial.icon;
        },
    },
    model: { parent: { setDocIcon: (v) => { iconRefreshed = v; } } },
};

/* ── 桩：siyuan 模块 ────────────────────────────── */
let FAKE_DATA = null;      // loadData 的返回值，可在用例间切换
let FAKE_THROW = false;    // 让 loadData reject（模拟插件生命周期已结束）
class FakePlugin {
    constructor() {
        this.name = "siyuan-plugin-game-covers";
        this.i18n = new Proxy({}, { get: (_, k) => String(k) });
        this.eventBus = { on() {} };
        this.commands = [];
        this.topBars = [];
        this.symbols = [];
    }
    addIcons(s) { this.symbols.push(s); }
    addCommand(c) { this.commands.push(c); }
    addTopBar(t) { this.topBars.push(t); }
    addBreadcrumbButton(b) { this.breadcrumbBtns = this.breadcrumbBtns || []; this.breadcrumbBtns.push(b); return b.id; }
    async loadData() {
        if (FAKE_THROW) throw { code: 410, msg: "Plugin lifecycle has ended" };
        return FAKE_DATA;
    }
    async saveData(k, v) { (this.saved ||= {})[k] = v; }
}
class FakeSetting {
    constructor(opts) { this.opts = opts; this.items = []; }
    addItem(i) { this.items.push(i); }
}
const siyuanStub = {
    Plugin: FakePlugin,
    Dialog: class { constructor() { this.element = { querySelector: () => null }; } destroy() {} },
    Menu: class { addItem() {} open() {} },
    showMessage: () => {},
    getAllEditor: () => [{ protyle: fakeProtyle }],
    Setting: FakeSetting,
};

/* ── 桩：浏览器环境 + SteamGridDB ───────────────── */
const calls = [];
const json = (data) => ({ ok: true, status: 200, json: async () => data });

const fetchStub = async (url, opts = {}) => {
    const u = String(url);
    const headers = opts.headers || {};
    calls.push({ url: u, headers });

    if (u.includes("/search/autocomplete/")) {
        if (headers.Authorization !== "Bearer good-key") {
            return json({ success: false, errors: ["Authentication Required"] });
        }
        return json({
            success: true,
            data: [
                { id: 111, name: "Elden Ring Nightreign", types: ["steam"], verified: false },
                { id: 5999, name: "Elden Ring", types: ["steam"], verified: true },
            ],
        });
    }
    if (u.includes("/grids/game/")) {
        if (headers.Authorization !== "Bearer good-key") return json({ success: false });
        return json({
            success: true,
            data: [
                {
                    id: 12345, score: 98, style: ["alternate"],
                    url: "https://cdn2.steamgriddb.com/grid/abc.png",
                    thumb: "https://cdn2.steamgriddb.com/thumb/abc.png",
                    width: 600, height: 900, mimes: "image/png",
                    upvotes: 12, downvotes: 0,
                    author: { name: "someone", steam64: "x" },
                },
                {
                    id: 12346, score: 91,
                    url: "https://cdn2.steamgriddb.com/grid/def.jpg",
                    thumb: "https://cdn2.steamgriddb.com/thumb/def.jpg",
                    width: 600, height: 900, mimes: "image/jpeg",
                },
            ],
        });
    }
    return { ok: false, status: 404, json: async () => ({}) };
};

const sandbox = {
    console,
    fetch: fetchStub,
    URLSearchParams,
    document: {
        querySelector: () => null,
        querySelectorAll: () => [],
        activeElement: null,
        body: { appendChild: () => {}, insertAdjacentHTML: () => {} },
        createElement: () => ({
            className: "",
            innerHTML: "",
            querySelector: () => ({ value: "" }),
            setAttribute: () => {},
            getAttribute: () => null,
            addEventListener: () => {},
        }),
    },
    window: { siyuan: {}, getSelection: () => null },
    setTimeout,
    MutationObserver: class { observe() {} disconnect() {} },
    FormData: class { append() {} },
    Blob: class {},
    require: (m) => (m === "siyuan" ? siyuanStub : createRequire(import.meta.url)(m)),
    module: { exports: {} },
};
sandbox.exports = sandbox.module.exports;
vm.createContext(sandbox);

console.log("1) 语法解析（验收 1）");
let PluginClass;
try {
    vm.runInContext(src, sandbox, { filename: "index.js" });
    PluginClass = sandbox.module.exports;
    check("index.js 可被 vm 解析且 module.exports 是类", typeof PluginClass === "function");
} catch (err) {
    check("index.js 可解析", false, err.message);
    process.exit(1);
}

console.log("2) 生命周期（验收 2）");
const p = new PluginClass();
await p.onload();
check("onload 不抛错", true);
check("注册了 1 个 command", p.commands.length === 1, `实际 ${p.commands.length}`);
check("注册了 1 个 topBar", p.topBars.length === 1, `实际 ${p.topBars.length}`);
check("注册了 1 组 icon symbol", p.symbols.length === 1, `实际 ${p.symbols.length}`);
check("symbol 带 id iconGameCovers", /id="iconGameCovers"/.test(p.symbols[0]));
check(
    "快捷键不与 DevTools 冲突（⌥⌘I/⌥⌘J/⌥⌘C）",
    !["⌥⌘I", "⌥⌘J", "⌥⌘C"].includes(p.commands[0]?.hotkey),
    p.commands[0]?.hotkey
);
check("快捷键是 ⌥⌘G", p.commands[0]?.hotkey === "⌥⌘G", p.commands[0]?.hotkey);
check("命令回调打开选择器", typeof p.commands[0]?.callback === "function");
check("注册了面包屑按钮", (p.breadcrumbBtns || []).length === 1);
check("注册了设置面板", p.setting && typeof p.setting.addItem === "function" && p.setting.items.length === 1);

console.log("3) i18n key 集合");
const zh = JSON.parse(fs.readFileSync(path.join(root, "i18n", "zh_CN.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(root, "i18n", "en_US.json"), "utf8"));
const SPEC_KEYS = [
    "topbarTitle", "menuOpen", "openPicker", "pickerTitle", "searchPlaceholder",
    "dimPoster", "dimHero", "dimSquare", "hint", "countResult", "searching",
    "noResult", "emptyKeyword", "searchFailed", "needKey", "keyHelp", "goSettings",
    "keyLabel", "keyDesc", "authFailed", "noBlock", "insertBody", "setAsDocIcon",
    "inserted", "insertFailed", "applied", "applyFailed", "goApply",
];
check("zh_CN / en_US key 集合一致",
    JSON.stringify(Object.keys(zh).sort()) === JSON.stringify(Object.keys(en).sort()),
    `zh=${Object.keys(zh).length} en=${Object.keys(en).length}`);
const missingKeys = SPEC_KEYS.filter((k) => !(k in zh) || !(k in en));
check("覆盖规范要求的全部 28 个 key（含 goApply）", missingKeys.length === 0, missingKeys.join(","));
check("无多余 key", Object.keys(zh).length === SPEC_KEYS.length,
    Object.keys(zh).filter((k) => !SPEC_KEYS.includes(k)).join(","));
check("占位符 $1 用在 countResult/inserted", zh.countResult.includes("$1") && zh.inserted.includes("$1"));

console.log("4) SteamGridDB 检索（验收 9/10）");
p.sgdbKey = "good-key";
calls.length = 0;
const items = await p.searchGames("elden ring", "600x900");
check("一次搜索固定 2 个请求", calls.length === 2, `实际 ${calls.length}`);
check("先 autocomplete 后 grids",
    calls[0].url.includes("/search/autocomplete/") && calls[1].url.includes("/grids/game/"));
check("关键词 encodeURIComponent", calls[0].url.endsWith("/search/autocomplete/elden%20ring"), calls[0].url);
check("两个请求都带 Authorization: Bearer",
    calls[0].headers.Authorization === "Bearer good-key" && calls[1].headers.Authorization === "Bearer good-key");
const gid = calls[1].url.split("/grids/game/")[1].split("?")[0];
check("取的是第一个游戏（verified 优先，不是 Nightreign）", gid === "5999", gid);
const qs = new URLSearchParams(calls[1].url.split("?")[1]);
check("dimensions=600x900", qs.get("dimensions") === "600x900", qs.get("dimensions"));
check("mimes=image/jpeg,image/png", qs.get("mimes") === "image/jpeg,image/png", qs.get("mimes"));
check("nsfw=false", qs.get("nsfw") === "false", qs.get("nsfw"));
check("humor=false", qs.get("humor") === "false", qs.get("humor"));
check("返回映射含 thumb/cover/mime/作者", items.length === 2
    && items[0].thumb === "https://cdn2.steamgriddb.com/thumb/abc.png"
    && items[0].cover === "https://cdn2.steamgriddb.com/grid/abc.png"
    && items[0].mime === "image/png"
    && items[0].title === "Elden Ring"
    && items[0].sub === "someone"
    && items[0].w === 600 && items[0].h === 900);

console.log("5) petal key 读取兼容（不同 loadData 返回形态）");
FAKE_DATA = { sgdbKey: "key-as-object" };
const p2 = new PluginClass();
await p2.onload();
check("loadData 返回对象 → key 读出", p2.sgdbKey === "key-as-object", p2.sgdbKey);
FAKE_DATA = '{"sgdbKey":"key-as-string"}';
const p3 = new PluginClass();
await p3.onload();
check("loadData 返回 JSON 字符串 → key 读出（text/plain 内核兼容）", p3.sgdbKey === "key-as-string", p3.sgdbKey);
FAKE_DATA = "raw-token-string";
const p4 = new PluginClass();
await p4.onload();
check("裸 key 字符串兜底", p4.sgdbKey === "raw-token-string", p4.sgdbKey);
FAKE_DATA = "";
const p5 = new PluginClass();
await p5.onload();
check("空字符串 → 无 key", p5.sgdbKey === "", p5.sgdbKey);
FAKE_DATA = null;
const p6 = new PluginClass();
await p6.onload();
check("文件缺失 → 无 key", p6.sgdbKey === "", p6.sgdbKey);
FAKE_THROW = true;
const p7 = new PluginClass();
await p7.onload();
check("loadData reject（生命周期结束）→ onload 不崩、无 key",
    p7.sgdbKey === "" && p7.commands.length === 1, p7.sgdbKey);
FAKE_THROW = false;
check("后续实例的读取不影响已有实例的 key", p.sgdbKey === "good-key", p.sgdbKey);

console.log("6) 失败路径");
calls.length = 0;
p.sgdbKey = "bad-key";
let authErr = null;
try { await p.searchGames("elden ring", "600x900"); } catch (e) { authErr = e; }
check("success:false（HTTP 200）按 AUTH 抛出", authErr && authErr.message === "AUTH", String(authErr));
check("AUTH 时不再请求 grids", calls.length === 1, `实际 ${calls.length}`);
p.sgdbKey = "";
let noKeyErr = null;
try { await p.searchGames("elden ring", "600x900"); } catch (e) { noKeyErr = e; }
check("没 key 抛 NO_KEY", noKeyErr && noKeyErr.message === "NO_KEY", String(noKeyErr));
check("没 key 零请求", calls.length === 1, `实际 ${calls.length}`);

console.log("7) 名称清洗");
check("非法字符剔除", p.safeName('Elden Ring: "Deluxe" <Edition>?') === "Elden Ring Deluxe Edition", p.safeName('Elden Ring: "Deluxe" <Edition>?'));
check("空名兜底 game", p.safeName("   ") === "game");
check("超长截断 32", p.safeName("A".repeat(50)).length === 32);
check("png mime → .png", p.extOf({ mime: "image/png", cover: "https://x/grid/a" }) === ".png");
check("png URL → .png", p.extOf({ mime: "", cover: "https://x/grid/a.png?token=1" }) === ".png");
check("jpeg → .jpg", p.extOf({ mime: "image/jpeg", cover: "https://x/grid/a.jpg" }) === ".jpg");

console.log("8) 文档 id 与界面刷新");
p.activeProtyle = null;
check("activeDocId 取自 getAllEditor", p.activeDocId() === DOC_ID, p.activeDocId());
check("protyleOf 能按 id 找到实例", p.protyleOf(DOC_ID) === fakeProtyle);
check("找不到时返回 null", p.protyleOf("nonexistent") === null);
iconRefreshed = null;
const refreshed = p.refreshTitleIcon(DOC_ID, "game-covers/Elden Ring-12345.png");
check("refreshTitleIcon 返回 true", refreshed === true);
check("刷新后 ial.icon 已更新", fakeProtyle.background.ial.icon === "game-covers/Elden Ring-12345.png");
check("图标值同步到了标签页", iconRefreshed === "game-covers/Elden Ring-12345.png", String(iconRefreshed));

console.log("9) HTML 转义");
check("转义 <script>", p.esc("<script>") === "&lt;script&gt;");
check("转义引号", p.esc('a"b') === "a&quot;b");
check("null 安全", p.esc(null) === "");

console.log("10) README 与集市描述（验收 13）");
const zhReadme = fs.readFileSync(path.join(root, "README_zh_CN.md"), "utf8");
const enReadme = fs.readFileSync(path.join(root, "README.md"), "utf8");
const conf = JSON.parse(fs.readFileSync(path.join(root, "plugin.json"), "utf8"));
check("中文 README 含申请地址", zhReadme.includes("https://www.steamgriddb.com/profile/preferences/api"));
check("中文 README 含 Preferences → API 路径", zhReadme.includes("Preferences → API"));
check("中文 README 含四步（有序列表 4 项）",
    /1\..*\n.*2\..*\n.*3\..*\n.*4\./s.test(zhReadme.split("## 先配 API Key")[1] || ""));
check("中文 README 含数据来源声明（不存储、不再分发）",
    zhReadme.includes("不存储、不再分发"));
check("英文 README 含申请地址", enReadme.includes("https://www.steamgriddb.com/profile/preferences/api"));
check("英文 README 含 API key 章节", enReadme.includes("Set up your API key first"));
check("英文 README 含数据来源声明", enReadme.includes("does not store or redistribute"));
check("plugin.json description 点明需要 key（zh_CN）", conf.description.zh_CN.includes("API Key"));
check("plugin.json description 点明需要 key（default）", conf.description.default.includes("API Key"));
check("displayName 的 zh_CN 与 zh-CN 一致（default 为英文兜底）",
    conf.displayName.zh_CN === conf.displayName["zh-CN"] && conf.displayName.zh_CN === "Steam Games Cover Get");
check("description 的 zh_CN 与 zh-CN 一致",
    conf.description.zh_CN === conf.description["zh-CN"]);
check("readme 三键齐全",
    conf.readme.default === "README.md" && conf.readme.zh_CN === "README_zh_CN.md" && conf.readme["zh-CN"] === "README_zh_CN.md");
check("plugin.json name 与目录名一致", conf.name === path.basename(root));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
