/**
 * Game Covers for SiYuan
 *
 * 从 SteamGridDB 搜索游戏封面，插进正文或设为文档图标。
 * 架构沿用 siyuan-plugin-LLM-icons（同一作者的姊妹插件），
 * 点名方法（bindSearchInput / insertToBody / applyIcon / watchEmojiDialog /
 * refreshTitleIcon / activeDocId / currentBlockContext）全部保持同构。
 *
 * 以下机制均已实机验证（继承自 LLM-icons）：
 * - 图标值格式为 `<组名>/<文件名>`，内核通过 `/emojis/<组>/<文件>` 提供静态服务；
 * - 图标文件写入 `data/emojis/<组>/`，会随工作区同步；
 * - 设置图标走 `/api/attr/setBlockAttrs`，属性名 `icon`；
 * - 插入正文走 `/api/asset/upload`，图片落 assets 才不会导出断图。
 *
 * 与 LLM-icons 的本质区别：图片是远程的（SteamGridDB），要先下载再上传。
 *
 * SteamGridDB API 注意（实测确认）：
 * - 全站鉴权（Authorization: Bearer <key>），没有匿名接口；
 * - 鉴权失败也返回 HTTP 200，body 是 {"success": false}，判断成功必须看 success 字段；
 * - /grids/game/ 必须带 mimes=image/jpeg,image/png，否则返回 webp/ico；
 * - 必须带 nsfw=false&humor=false；
 * - 列表显示用 thumb，下载用 url。
 */
const { Plugin, Dialog, Menu, showMessage, getAllEditor, Setting } = require("siyuan");

const PLUGIN_NAME = "siyuan-plugin-game-covers";
const EMOJI_GROUP = "game-covers";
const ASSET_DIR = "game-covers";
const CONF_FILE = "conf.json";
const SGDB = "https://www.steamgriddb.com/api/v2";
const KEY_URL = "https://www.steamgriddb.com/profile/preferences/api";

// 尺寸 chips：本地参数切换，不是重新设计数据源，但接口侧按 dimensions 过滤，切换需重查
const DIMENSIONS = [
    { id: "600x900", lang: "dimPoster" },   // 竖版，当文档图标/封面用这个（默认）
    { id: "460x215", lang: "dimHero" },     // 横版，Steam 库风格
    { id: "512x512", lang: "dimSquare" },   // 方形
];

module.exports = class GameCovers extends Plugin {
    async onload() {
        // key 只存本地 petal（data/storage/petal/<插件名>/conf.json），不上传、不进 README
        await this.loadKey();

        // 封面上传会按 游戏名-网格id 命名，这里按网格 id 缓存已上传路径，避免重复上传
        this.assetCache = new Map();
        // 设为图标时同一张封面只需写入 emojis 组一次
        this.iconCache = new Map();

        this.addIcons(
            // icon-park-outline:game-two（Icon Park，Apache 2.0），与 icon.png 同源
            `<symbol id="iconGameCovers" viewBox="0 0 48 48">
                <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="4" d="m20 15l4 4l4-4V4h-8zm0 18l4-4l4 4v11h-8zm13-5l-4-4l4-4h11v8zm-18-8l4 4l-4 4H4v-8z"/>
            </symbol>`
        );

        this.addCommand({
            langKey: "openPicker",
            // 避开 ⌥⌘I / ⌥⌘J / ⌥⌘C —— 这几个是 Electron 打开 DevTools 的默认键
            hotkey: "⌥⌘G",
            callback: () => this.openPicker(),
        });

        this.addTopBar({
            icon: "iconGameCovers",
            title: this.i18n.topbarTitle,
            position: "right",
            callback: () => this.openPicker(),
        });

        // 面包屑按钮：主题把面包屑移到底部时，它就出现在那条胶囊里
        try {
            this.addBreadcrumbButton({
                id: "game-covers",
                icon: "iconGameCovers",
                title: this.i18n.topbarTitle,
                callback: (event, protyle) => {
                    if (event && event.preventDefault) event.preventDefault();
                    this.activeProtyle = protyle;
                    this.openPicker();
                },
            });
        } catch (err) {
            console.warn("[Game Covers] breadcrumb button failed", err);
        }

        // 表情面板里也放一个入口（面板头部的图标排）
        this.watchEmojiDialog();

        // 文档标题图标右键菜单入口
        this.eventBus.on("click-editortitleicon", (e) => {
            const d = e.detail;
            if (!d || !d.menu) return;
            d.menu.addItem({
                icon: "iconGameCovers",
                label: this.i18n.menuOpen,
                click: () => this.openPicker(d.data && d.data.id),
            });
        });

        this.buildSetting();
    }

    onunload() {
        // 必须 disconnect：MutationObserver 挂在 body 上，插件重载后不清理会注入两个 tab
        if (this.emojiObserver) {
            this.emojiObserver.disconnect();
            this.emojiObserver = null;
        }
    }

    /* ── 设置页 ──────────────────────────────────── */

    /**
     * 读取 petal 里保存的 key。
     *
     * 实测 3.8.9：saveData(object) 落盘正常；loadData 走 /api/file/getFile，
     * 前端按响应 content-type 决定 json() 还是 text()，不同环境下可能拿到
     * 对象或原始字符串；文件缺失时 resolve ""，插件生命周期结束时 reject。
     * 这里统一归一化，任何形态都读得出 key。
     */
    async loadKey() {
        let conf = null;
        try {
            conf = await this.loadData(CONF_FILE);
        } catch {
            conf = null;
        }
        if (typeof conf === "string" && conf.trim()) {
            try {
                conf = JSON.parse(conf);
            } catch {
                // 兜底：文件里直接是裸 key
                conf = { sgdbKey: conf.trim() };
            }
        }
        this.sgdbKey = (conf && typeof conf === "object" ? String(conf.sgdbKey || "") : "").trim();
    }

    buildSetting() {
        this.setting = new Setting({
            width: "620px",
            height: "300px",
            confirmCallback: async () => {
                const value = this.keyInput ? this.keyInput.value.trim() : "";
                this.sgdbKey = value;
                await this.saveData(CONF_FILE, { sgdbKey: value });
                // 确认后，还开着的搜索面板可能停在 needKey 引导页，就地刷新
                if (typeof this._pickerReset === "function") this._pickerReset();
            },
        });
        this.setting.addItem({
            title: this.i18n.keyLabel,
            direction: "none",
            createActionElement: () => {
                const wrap = document.createElement("div");
                wrap.className = "gcv-setting";
                wrap.innerHTML = `
    <input class="b3-text-field fn__block gcv-key-input" spellcheck="false" autocomplete="off" style="width:100%" placeholder="${this.esc(this.i18n.keyLabel)}">
    <div class="b3-label__text">${this.esc(this.i18n.keyDesc)}</div>
    <div class="b3-label__text"><a href="${KEY_URL}" target="_blank" rel="noopener">${KEY_URL}</a></div>`;
                this.keyInput = wrap.querySelector(".gcv-key-input");
                this.keyInput.value = this.sgdbKey || "";
                return wrap;
            },
        });
    }

    /** 每次打开设置面板都回填当前值，避免显示上一次未保存的输入 */
    openSetting() {
        if (this.keyInput) this.keyInput.value = this.sgdbKey || "";
        if (typeof super.openSetting === "function") super.openSetting();
    }

    /* ── SteamGridDB 检索 ────────────────────────── */

    /**
     * 一次搜索固定 2 个请求：autocomplete 拿游戏 id + grids 拿封面。
     * 只对选中的那一个游戏取网格（优先 verified，首条常是同名 DLC / 试玩版）。
     * 成功判断看 body 的 success 字段，不看 HTTP 状态码（鉴权失败也返回 200）。
     */
    async searchGames(term, dimensions) {
        if (!this.sgdbKey) throw new Error("NO_KEY");
        const headers = { Authorization: `Bearer ${this.sgdbKey}` };

        const r1 = await fetch(`${SGDB}/search/autocomplete/${encodeURIComponent(term)}`, { headers });
        const j1 = await r1.json();
        if (!j1.success) throw new Error("AUTH");

        const games = j1.data || [];
        if (!games.length) return [];
        const game = games.find((g) => g.verified) || games[0];

        const q = new URLSearchParams({
            dimensions,
            mimes: "image/jpeg,image/png",
            nsfw: "false",
            humor: "false",
        });
        const r2 = await fetch(`${SGDB}/grids/game/${game.id}?${q}`, { headers });
        const j2 = await r2.json();
        if (!j2.success) throw new Error("AUTH");

        return (j2.data || []).map((g) => ({
            id: g.id,
            title: game.name,
            sub: (g.author && g.author.name) || "",
            cover: g.url,
            thumb: g.thumb,
            mime: g.mimes || "",
            w: g.width,
            h: g.height,
        }));
    }

    /** 文件名安全化：同一游戏几十张风格图靠 网格id 区分，游戏名只做可读部分 */
    safeName(title) {
        return (String(title).replace(/[\\/:*?"<>|]/g, "").trim() || "game").slice(0, 32);
    }

    /** 扩展名从 mimes 或 URL 推断，不能写死 .jpg（返回 PNG 存成 jpg 导出后部分阅读器不认） */
    extOf(item) {
        return (item.mime || "").includes("png") || /\.png($|\?)/i.test(item.cover || "") ? ".png" : ".jpg";
    }

    /* ── 文档图标 ────────────────────────────────── */

    async readGroup() {
        try {
            const resp = await fetch("/api/file/readDir", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ path: `/data/emojis/${EMOJI_GROUP}` }),
            });
            const json = await resp.json();
            return json.code === 0 && Array.isArray(json.data) ? json.data : null;
        } catch {
            return null;
        }
    }

    async putEmojiFile(name, blob) {
        const form = new FormData();
        form.append("path", `/data/emojis/${EMOJI_GROUP}/${name}`);
        form.append("isDir", "false");
        form.append("modTime", String(Math.floor(Date.now() / 1000)));
        form.append("file", blob, name);
        const resp = await fetch("/api/file/putFile", { method: "POST", body: form });
        const json = await resp.json();
        if (json.code !== 0) throw new Error(json.msg || "putFile failed");
        // 图标属性值就是 <组>/<文件>，不能带 /emojis/ 前缀，否则不生效
        return `${EMOJI_GROUP}/${name}`;
    }

    /** 把远程封面下载后写入工作区 emojis 组，返回可直接用作图标的相对值 */
    async materialize(item) {
        if (this.iconCache.has(item.id)) return this.iconCache.get(item.id);

        const file = this.safeName(item.title) + "-" + item.id + this.extOf(item);
        const list = await this.readGroup(); // null 表示目录还不存在
        if (list && list.some((f) => !f.isDir && f.name === file)) {
            const cached = `${EMOJI_GROUP}/${file}`;
            this.iconCache.set(item.id, cached);
            return cached;
        }
        if (!list) {
            // 先写个占位文件把目录建出来
            await this.putEmojiFile(".keep", new Blob([""], { type: "text/plain" }));
        }

        const resp = await fetch(item.cover);
        if (!resp.ok) throw new Error(`封面下载失败 (${resp.status})`);
        const value = await this.putEmojiFile(file, await resp.blob());
        this.iconCache.set(item.id, value);
        return value;
    }

    async applyIcon(blockId, item) {
        if (!blockId) {
            showMessage(this.i18n.noBlock);
            return false;
        }
        try {
            const iconValue = await this.materialize(item);
            const resp = await fetch("/api/attr/setBlockAttrs", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: blockId, attrs: { icon: iconValue } }),
            });
            const json = await resp.json();
            if (json.code !== 0) throw new Error(json.msg || "setBlockAttrs failed");

            // 数据已写入，但界面不会自动更新，需手动刷新标题图标
            this.refreshTitleIcon(blockId, iconValue);

            showMessage(this.i18n.applied, 2000, "info");
            return true;
        } catch (err) {
            console.error("[Game Covers]", err);
            showMessage(`${this.i18n.applyFailed}: ${err.message}`);
            return false;
        }
    }

    /**
     * 当前激活文档的 id。
     *
     * 不能用 `.protyle-title[data-node-id]`：思源的标题元素模板里没有这个属性，
     * 选择器永远为空，导致点图标没反应。正确做法是走 getAllEditor() 拿 protyle
     * 实例，读 block.rootID —— 这也是思源内部应用图标后刷新界面时用的同一个来源。
     */
    activeDocId() {
        // 从编辑器工具栏进来时带了 protyle，优先用它，避免多标签页取错
        if (this.activeProtyle && this.activeProtyle.block) {
            return this.activeProtyle.block.rootID || "";
        }
        const list = typeof getAllEditor === "function" ? getAllEditor() : [];
        const editors = list.filter((e) => e && e.protyle && e.protyle.block);

        // 优先：可见且包含当前焦点的编辑器
        const active = document.activeElement;
        if (active) {
            const hit = editors.find(
                (e) =>
                    !e.protyle.element.classList.contains("fn__none") &&
                    e.protyle.element.contains(active)
            );
            if (hit) return hit.protyle.block.rootID || "";
        }

        // 其次：任何可见的编辑器（排除 fn__none 的后台标签页）
        const visible = editors.find(
            (e) => !e.protyle.element.classList.contains("fn__none")
        );
        if (visible) return visible.protyle.block.rootID || "";

        return (editors[0] && editors[0].protyle.block.rootID) || "";
    }

    /** 找到指定文档对应的 protyle 实例，用于刷新界面 */
    protyleOf(docId) {
        const list = typeof getAllEditor === "function" ? getAllEditor() : [];
        const hit = list
            .filter((e) => e && e.protyle && e.protyle.block)
            .find((e) => e.protyle.block.rootID === docId);
        return hit ? hit.protyle : null;
    }

    /**
     * 设置完属性后刷新界面。
     *
     * /api/attr/setBlockAttrs 只写数据，不更新 DOM。思源自己在收到 setAttrs 事务时
     * 是这么刷新的：background.ial.icon = ...; background.render(ial, block.rootID)
     * 这里调用同一个方法，而不是手动拼 DOM —— 后者会漏掉主题、尺寸等细节。
     */
    refreshTitleIcon(docId, iconValue) {
        const protyle = this.protyleOf(docId);
        if (!protyle) return false;

        try {
            const bg = protyle.background;
            if (bg && typeof bg.render === "function") {
                if (!bg.ial) bg.ial = {};
                bg.ial.icon = iconValue;
                bg.render(bg.ial, protyle.block.rootID);
            }
            // 同步更新文件树里的文档图标
            if (protyle.model && protyle.model.parent && typeof protyle.model.parent.setDocIcon === "function") {
                protyle.model.parent.setDocIcon(iconValue);
            }
            return true;
        } catch (err) {
            console.warn("[Game Covers] refresh failed", err);
            return false;
        }
    }

    /* ── 插入正文 ────────────────────────────────── */

    /** 列表用 thumb 展示，下载落盘用 url 原图；按网格 id 缓存，避免重复上传 */
    async ensureAsset(item) {
        if (this.assetCache.has(item.id)) return this.assetCache.get(item.id);

        const resp = await fetch(item.cover);
        if (!resp.ok) throw new Error(`封面下载失败 (${resp.status})`);
        const blob = await resp.blob();

        const file = this.safeName(item.title) + "-" + item.id + this.extOf(item);
        const form = new FormData();
        form.append("assetsDirPath", `/assets/${ASSET_DIR}/`); // 结尾斜杠必须，否则上传失败
        form.append("file[]", blob, file);

        const up = await fetch("/api/asset/upload", { method: "POST", body: form });
        const json = await up.json();
        if (json.code !== 0) throw new Error(json.msg || "upload failed");

        const succ = (json.data && json.data.succMap) || {};
        const raw = succ[file] || Object.values(succ)[0];
        if (!raw) throw new Error("upload 未返回路径");
        const path = raw.charAt(0) === "/" ? raw : "/" + raw;
        this.assetCache.set(item.id, path);
        return path;
    }

    /** 收集所有可用的 protyle 实例（含隐藏标签页，按活跃度排序） */
    collectProtyles() {
        const list = [];
        const push = (p) => {
            if (p && typeof p.insert === "function" && list.indexOf(p) === -1) list.push(p);
        };
        const visible = (p) => p && p.element && !p.element.classList.contains("fn__none");

        const active = this.protyleOf(this.activeDocId());
        if (active) push(active);

        (getAllEditor() || []).forEach((e) => push(e && e.protyle));

        // 可见的排前面，避免插进后台标签页
        return list.sort((a, b) => (visible(b) ? 1 : 0) - (visible(a) ? 1 : 0));
    }

    /** 当前光标所在块，供 API 兜底定位 */
    currentBlockContext() {
        const sel = window.getSelection();
        let node = sel && sel.anchorNode;
        let el = null;
        while (node) {
            if (node.nodeType === 1 && node.hasAttribute && node.hasAttribute("data-node-id")) {
                el = node;
                break;
            }
            node = node.parentNode;
        }
        if (!el) return null;
        const parent = el.parentElement && el.parentElement.closest("[data-node-id]");
        return {
            id: el.getAttribute("data-node-id"),
            parentId: parent ? parent.getAttribute("data-node-id") : "",
        };
    }

    /** 优先用 protyle 直接插入，失败则走 /api/block/insertBlock */
    async insertToBody(item) {
        const src = await this.ensureAsset(item);
        const alt = String(item.title || "game").replace(/[[\]()]/g, " ").trim();
        const html = `<img src="${this.esc(src)}" alt="${this.esc(alt)}">`;

        for (const protyle of this.collectProtyles()) {
            const wysiwyg = protyle && protyle.wysiwyg && protyle.wysiwyg.element;
            if (!wysiwyg || !wysiwyg.isConnected) continue;
            const before = wysiwyg.querySelectorAll("img").length;
            try {
                if (typeof protyle.focus === "function") protyle.focus();
                protyle.insert(html, false);
            } catch {
                continue;
            }
            // 确认真的插进去了，否则换下一个编辑器
            if (wysiwyg.querySelectorAll("img").length > before) return true;
        }
        return this.insertViaApi(src, alt);
    }

    async insertViaApi(src, alt) {
        const ctx = this.savedBlockCtx || this.currentBlockContext();
        let docId = this.activeDocId();
        if (!docId && ctx && ctx.id) docId = ctx.id;
        if (!docId) return false;

        const parentId = (ctx && ctx.parentId) || docId;
        const payload = {
            dataType: "markdown",
            data: `![${alt}](${src})`,
            parentID: parentId,
        };
        if (ctx && ctx.id && ctx.id !== parentId) payload.previousID = ctx.id;

        try {
            const resp = await fetch("/api/block/insertBlock", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            });
            const json = await resp.json();
            return json.code === 0;
        } catch {
            return false;
        }
    }

    /* ── 卡片渲染 ────────────────────────────────── */

    /**
     * 封面卡片只显示图，不显示标题 —— 同一个游戏的所有网格标题都一样，
     * 显示几十遍「Elden Ring」是噪音。游戏名 + 上传者放 title 属性做 tooltip。
     */
    coverCard(item, { small = false } = {}) {
        const w = item.w || 600;
        const h = item.h || 900;
        const tip = item.sub ? `${item.title} · ${item.sub}` : item.title;
        if (small) {
            return `<div class="gcv-ep-item" data-id="${item.id}" title="${this.esc(tip)}">
    <img src="${this.esc(item.thumb)}" alt="" loading="lazy" decoding="async" style="aspect-ratio:${w}/${h}">
</div>`;
        }
        return `<div class="gcv-card" data-id="${item.id}" title="${this.esc(tip)}">
    <div class="gcv-art"><img src="${this.esc(item.thumb)}" alt="" loading="lazy" decoding="async" style="aspect-ratio:${w}/${h}"></div>
    <div class="gcv-acts">
        <button data-act="docicon" aria-label="${this.esc(this.i18n.setAsDocIcon)}" title="${this.esc(this.i18n.setAsDocIcon)}"><svg><use xlink:href="#iconDoc"></use></svg></button>
    </div>
</div>`;
    }

    /** 尺寸 chips：选中态切换 + 有词立即重查（接口按 dimensions 过滤） */
    bindDimChips(chipsEl, chipClass, getDim, setDim, onRedo) {
        const render = () => {
            chipsEl.innerHTML = DIMENSIONS.map(
                (d) => `<button class="${chipClass}${d.id === getDim() ? " on" : ""}" data-d="${d.id}">${this.esc(this.i18n[d.lang])}</button>`
            ).join("");
        };
        render();
        chipsEl.onclick = (e) => {
            const el = e.target.closest("button[data-d]");
            if (!el) return;
            setDim(el.getAttribute("data-d"));
            render();
            onRedo();
        };
    }

    /* ── 选择器（Dialog，920×680）────────────────── */

    openPicker(docId) {
        const targetId = typeof docId === "string" ? docId : this.activeDocId();
        // 打开瞬间记下光标位置：对话框一弹，选区就没了
        this.savedBlockCtx = this.currentBlockContext();

        const dialog = new Dialog({
            title: this.i18n.pickerTitle,
            width: "920px",
            height: "680px",
            destroyCallback: () => {
                this._pickerReset = null;
            },
            content: `<div class="b3-dialog__content" style="overflow:hidden;display:flex;padding:12px 16px">
    <div class="gcv">
        <div class="gcv-bar">
            <input class="b3-text-field gcv-search" placeholder="${this.esc(this.i18n.searchPlaceholder)}" autocomplete="off" spellcheck="false">
        </div>
        <div class="gcv-chips"></div>
        <div class="gcv-meta">
            <span class="gcv-count"></span>
            <span class="gcv-hint">${this.esc(this.i18n.hint)}</span>
        </div>
        <div class="gcv-scroll">
            <div class="gcv-notice fn__none"></div>
            <div class="gcv-grid"></div>
        </div>
    </div>
</div>`,
        });

        const root = dialog.element;
        const input = root.querySelector(".gcv-search");
        const chips = root.querySelector(".gcv-chips");
        const countEl = root.querySelector(".gcv-count");
        const notice = root.querySelector(".gcv-notice");
        const grid = root.querySelector(".gcv-grid");

        let dim = "600x900";
        let results = [];
        let lastQuery = "";

        const setCount = (text) => {
            countEl.textContent = text;
        };

        const showNotice = (html) => {
            grid.innerHTML = "";
            notice.innerHTML = html;
            notice.classList.remove("fn__none");
        };

        const hideNotice = () => {
            notice.classList.add("fn__none");
            notice.innerHTML = "";
        };

        // 没填 key：不弹错误框、不发请求，内容区给出指引（主按钮直达申请页）
        const renderNeedKey = () => {
            showNotice(`<div class="gcv-notice-main">${this.esc(this.i18n.needKey)}</div>
    <div class="gcv-notice-sub"><a href="${KEY_URL}" target="_blank" rel="noopener">${this.esc(this.i18n.keyHelp)}</a></div>
    <div class="gcv-notice-actions">
        <a class="b3-button b3-button--outline gcv-go-apply" href="${KEY_URL}" target="_blank" rel="noopener">${this.esc(this.i18n.goApply)}</a>
        <button class="b3-button b3-button--outline gcv-open-settings">${this.esc(this.i18n.goSettings)}</button>
    </div>`);
        };

        const reset = () => {
            results = [];
            lastQuery = "";
            setCount("");
            if (!this.sgdbKey) renderNeedKey();
            else hideNotice();
        };

        // 设置面板确认后刷新还开着的面板（见 confirmCallback）
        this._pickerReset = reset;

        const doSearch = async () => {
            const kw = input.value.trim();
            if (!kw) {
                setCount("");
                showNotice(`<div class="gcv-notice-main">${this.esc(this.i18n.emptyKeyword)}</div>`);
                return;
            }
            if (!this.sgdbKey) {
                setCount("");
                renderNeedKey();
                return; // 没 key 零请求
            }
            setCount(this.i18n.searching);
            hideNotice();
            grid.innerHTML = "";
            try {
                results = await this.searchGames(kw, dim);
                lastQuery = kw;
                setCount(this.i18n.countResult.replace("$1", String(results.length)));
                if (!results.length) {
                    showNotice(`<div class="gcv-notice-main">${this.esc(this.i18n.noResult)}</div>`);
                    return;
                }
                grid.innerHTML = results.map((it) => this.coverCard(it)).join("");
            } catch (err) {
                setCount("");
                // success:false 也返回 HTTP 200，静默的话用户会以为是没搜到
                const msg = err && err.message === "AUTH"
                    ? this.i18n.authFailed
                    : this.i18n.searchFailed;
                showNotice(`<div class="gcv-notice-main">${this.esc(msg)}</div>`);
            }
        };

        const insertFirst = async () => {
            if (!results.length) return false;
            const item = results[0];
            const ok = await this.insertToBody(item);
            if (ok) {
                showMessage(this.i18n.inserted.replace("$1", item.title), 2000, "info");
                dialog.destroy();
            } else {
                showMessage(this.i18n.insertFailed);
            }
            return ok;
        };

        this.bindDimChips(
            chips,
            "gcv-chip",
            () => dim,
            (v) => {
                dim = v;
            },
            () => {
                // 切换尺寸：接口侧过滤，有词就立即重查
                if (input.value.trim()) doSearch();
            }
        );

        notice.onclick = (e) => {
            if (e.target.closest(".gcv-open-settings")) this.openSetting();
        };

        grid.onclick = async (e) => {
            const card = e.target.closest(".gcv-card");
            if (!card) return;
            const item = results.find((r) => String(r.id) === card.getAttribute("data-id"));
            if (!item) return;

            const btn = e.target.closest("button[data-act]");
            card.classList.add("busy");
            try {
                if (btn && btn.getAttribute("data-act") === "docicon") {
                    // 悬停按钮：设为文档图标
                    const ok = await this.applyIcon(targetId, item);
                    if (ok) dialog.destroy();
                    return;
                }
                // 卡片本体：插入到正文光标处
                const ok = await this.insertToBody(item);
                if (ok) {
                    showMessage(this.i18n.inserted.replace("$1", item.title), 2000, "info");
                    dialog.destroy();
                } else {
                    showMessage(this.i18n.insertFailed);
                }
            } finally {
                card.classList.remove("busy");
            }
        };

        grid.oncontextmenu = (e) => {
            const card = e.target.closest(".gcv-card");
            if (!card) return;
            e.preventDefault();
            const item = results.find((r) => String(r.id) === card.getAttribute("data-id"));
            if (!item) return;
            const menu = new Menu("gcv-menu");
            menu.addItem({
                icon: "iconImage",
                label: this.i18n.insertBody,
                click: async () => {
                    const ok = await this.insertToBody(item);
                    if (ok) {
                        showMessage(this.i18n.inserted.replace("$1", item.title), 2000, "info");
                        dialog.destroy();
                    } else {
                        showMessage(this.i18n.insertFailed);
                    }
                },
            });
            menu.addItem({
                icon: "iconDoc",
                label: this.i18n.setAsDocIcon,
                click: async () => {
                    if (await this.applyIcon(targetId, item)) dialog.destroy();
                },
            });
            menu.open({ x: e.clientX, y: e.clientY });
        };

        this.bindSearchInput(input, {
            // 不在输入时发请求：打字过程疯狂请求会打断输入法候选框
            onQuery: () => {},
            onEnter: async () => {
                // 已有当前词的结果，回车 = 插入第一个；否则先查询
                if (results.length && input.value.trim() === lastQuery) {
                    await insertFirst();
                    return;
                }
                await doSearch();
            },
            onEscape: () => {
                if (input.value) {
                    input.value = "";
                    reset();
                } else {
                    dialog.destroy();
                }
            },
        });

        reset();
        setTimeout(() => input.focus(), 60);
    }

    /* ── 表情面板 tab ────────────────────────────── */

    /**
     * 把游戏封面做成表情面板里的一个真正 tab。
     *
     * 思源表情面板的结构：
     *   .emojis__tabheader  里一排 [data-type="tab-xxx"] 图标
     *   .emojis__tabbody    里对应一排 <div data-type="tab-xxx">，非当前的加 fn__none
     */
    watchEmojiDialog() {
        const inject = () => {
            document.querySelectorAll(".emojis__tabheader").forEach((header) => {
                if (header.querySelector(".gcv-emoji-tab")) return;
                const dialog = header.closest(".b3-dialog");
                const body = dialog && dialog.querySelector(".emojis__tabbody");
                const linkTab = header.querySelector('[data-type="tab-link"]');
                if (!body || !linkTab) return;

                // ── tab 图标 ──
                const tab = document.createElement("div");
                tab.className = "gcv-emoji-tab ariaLabel block__icon block__icon--show";
                tab.setAttribute("data-type", "tab-game");
                tab.setAttribute("aria-label", this.i18n.topbarTitle);
                tab.innerHTML = '<svg><use xlink:href="#iconGameCovers"></use></svg>';

                // ── tab 内容 ──
                const pane = document.createElement("div");
                pane.className = "fn__none gcv-ep";
                pane.setAttribute("data-type", "tab-game");
                pane.innerHTML = `
                    <div class="fn__hr"></div>
                    <div class="fn__flex">
                        <span class="fn__space"></span>
                        <label class="b3-form__icon fn__flex-1" style="overflow:initial;">
                            <svg class="b3-form__icon-icon"><use xlink:href="#iconSearch"></use></svg>
                            <input spellcheck="false" class="b3-form__icon-input b3-text-field fn__block gcv-ep-search" placeholder="${this.esc(this.i18n.searchPlaceholder)}">
                        </label>
                        <span class="fn__space"></span>
                    </div>
                    <div class="fn__hr"></div>
                    <div class="gcv-ep-chips"></div>
                    <div class="gcv-ep-grid"></div>`;

                const input = pane.querySelector(".gcv-ep-search");
                const chips = pane.querySelector(".gcv-ep-chips");
                const grid = pane.querySelector(".gcv-ep-grid");
                let dim = "600x900";
                let results = [];
                let lastQuery = "";

                /**
                 * 这个表情面板是"设置图标"还是"插入正文"打开的？
                 *
                 * 思源内部用 B 变量区分（doc / notebook / insert），但没暴露给我们。
                 * 可观察的差异：垃圾桶按钮只在非 insert 模式下显示
                 * （源码里是 `${B==="insert"?" fn__none":""}`）。
                 */
                const isIconMode = () => {
                    const rm = dialog.querySelector('[data-action="remove"]');
                    return !!rm && !rm.classList.contains("fn__none");
                };

                /** 用一张封面：标头模式设图标，插入模式插正文 */
                const useItem = async (item, el) => {
                    if (el) el.style.opacity = "0.45";
                    let ok = false;
                    if (isIconMode()) {
                        ok = await this.applyIcon(this.activeDocId(), item);
                    } else {
                        ok = await this.insertToBody(item);
                    }
                    if (el) el.style.opacity = "";
                    if (ok) dialog.remove();
                    return ok;
                };

                const showNotice = (html) => {
                    grid.innerHTML = `<div class="gcv-ep-empty">${html}</div>`;
                };

                const renderNeedKey = () => {
                    showNotice(`${this.esc(this.i18n.needKey)}<br><a href="${KEY_URL}" target="_blank" rel="noopener">${this.esc(this.i18n.keyHelp)}</a><br><a class="b3-button b3-button--outline gcv-ep-apply" href="${KEY_URL}" target="_blank" rel="noopener">${this.esc(this.i18n.goApply)}</a> <button class="b3-button b3-button--outline gcv-ep-settings">${this.esc(this.i18n.goSettings)}</button>`);
                };

                const doSearch = async () => {
                    const kw = input.value.trim();
                    if (!kw) {
                        showNotice(this.esc(this.i18n.emptyKeyword));
                        return;
                    }
                    if (!this.sgdbKey) {
                        renderNeedKey();
                        return;
                    }
                    grid.innerHTML = `<div class="gcv-ep-empty">${this.esc(this.i18n.searching)}</div>`;
                    try {
                        results = await this.searchGames(kw, dim);
                        lastQuery = kw;
                        if (!results.length) {
                            showNotice(this.esc(this.i18n.noResult));
                            return;
                        }
                        grid.innerHTML = results.map((it) => this.coverCard(it, { small: true })).join("");
                    } catch (err) {
                        const msg = err && err.message === "AUTH"
                            ? this.i18n.authFailed
                            : this.i18n.searchFailed;
                        showNotice(this.esc(msg));
                    }
                };

                this.bindDimChips(
                    chips,
                    "gcv-ep-chip",
                    () => dim,
                    (v) => {
                        dim = v;
                    },
                    () => {
                        if (input.value.trim()) doSearch();
                    }
                );

                grid.addEventListener("click", async (e) => {
                    if (e.target.closest(".gcv-ep-settings")) {
                        this.openSetting();
                        return;
                    }
                    const el = e.target.closest(".gcv-ep-item");
                    if (!el) return;
                    const item = results.find((r) => String(r.id) === el.getAttribute("data-id"));
                    if (!item) return;
                    await useItem(item, el);
                });

                this.bindSearchInput(input, {
                    onQuery: () => {},
                    onEnter: async () => {
                        if (results.length && input.value.trim() === lastQuery) {
                            const first = grid.querySelector(".gcv-ep-item");
                            if (first) await useItem(results[0], first);
                            return;
                        }
                        await doSearch();
                    },
                    onEscape: () => {
                        if (input.value) {
                            input.value = "";
                            results = [];
                            lastQuery = "";
                            if (!this.sgdbKey) renderNeedKey();
                            else grid.innerHTML = "";
                        }
                    },
                });

                const activate = () => {
                    header.querySelectorAll('[data-type^="tab-"]').forEach((t) => {
                        t.classList.toggle("block__icon--active", t === tab);
                    });
                    [...body.children].forEach((c) => c.classList.add("fn__none"));
                    pane.classList.remove("fn__none");
                    if (!grid.innerHTML && !this.sgdbKey) renderNeedKey();
                    setTimeout(() => input.focus(), 30);
                };

                tab.addEventListener("click", (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    activate();
                });

                // 点到别的 tab 时把我的内容收起来
                header.addEventListener(
                    "click",
                    (e) => {
                        const t = e.target.closest('[data-type^="tab-"]');
                        if (t && t !== tab) tab.classList.remove("block__icon--active");
                    },
                    true
                );

                const space = linkTab.nextElementSibling;
                if (space && space.classList.contains("fn__space")) {
                    space.insertAdjacentElement("afterend", tab);
                } else {
                    linkTab.insertAdjacentElement("afterend", tab);
                }
                body.appendChild(pane);
            });
        };

        inject();
        this.emojiObserver = new MutationObserver(() => inject());
        this.emojiObserver.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * 绑定搜索框：处理好中文输入法。
     *
     * 关键点：用 IME 组词时按回车是「确认候选词」，不是「提交」。
     * 不做判断的话，输入 "elden" 再回车会直接插入半截结果，用户根本没机会确认。
     * - 组词中（isComposing / keyCode 229）不响应回车
     */
    bindSearchInput(input, { onQuery, onEnter, onEscape }) {
        let composing = false;

        input.addEventListener("compositionstart", () => {
            composing = true;
        });
        input.addEventListener("compositionend", () => {
            composing = false;
            // 组词结束后再按最终文本回调一次（本插件查询走回车，这里仅同步状态）
            if (onQuery) onQuery(input.value);
        });
        input.addEventListener("input", () => {
            if (composing) return;
            if (onQuery) onQuery(input.value);
        });
        input.addEventListener("keydown", (e) => {
            // 输入法正在组词，任何键都交给输入法处理
            if (e.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") {
                e.preventDefault();
                if (onEnter) onEnter();
            } else if (e.key === "Escape") {
                if (onEscape) onEscape(e);
            }
        });
    }

    esc(s) {
        return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
            ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
        );
    }
};
