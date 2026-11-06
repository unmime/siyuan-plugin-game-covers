# 思源插件开发流程与规范

> 适用范围：本系列思源插件（LLM Icons / iTunes Cover Get / App Store 图标 / Steam Games Cover Get …）
> 配套实例：`siyuan-plugin-game-covers`（v0.1.1，已上集市流程全通）
> 最后更新：2026-11-07

---

## 一、工程硬规范（不符会打包失败或集市被拒）

1. **零构建链**：`index.js` 就是手写源码，单文件 CommonJS，浏览器直跑，`require("siyuan")` 由宿主注入。**禁止** webpack / vite / TypeScript / 任何运行时依赖（axios、lodash 之类一律不引）。
2. **必备文件**：`plugin.json`、`index.js`、`index.css`、`i18n/zh_CN.json`、`i18n/en_US.json`、`icon.png`（≤64KB）、`preview.png`（≤512KB）、`README.md`、`README_zh_CN.md`、`LICENSE`（MIT）、`.gitignore`、`package.json`（devDep 只许 jsdom）、`scripts/`（package.mjs / smoke-test.mjs / ui-test.mjs）。
3. **plugin.json**：
   - `name` 必须与**目录名逐字一致**，打包脚本直接 exit(1)；
   - `displayName` / `description` / `readme` 三个字段必须**同时写 `default` + `zh_CN` + `zh-CN`**，其中 zh_CN 与 zh-CN 两键值完全相同（思源不同代码路径分别读这两个键，只写一个会在部分界面回落英文）；
   - `description` 必须开头点明使用门槛（如需要 API Key），否则用户装完发现不能用直接差评。
4. **命名体系**（全小写、一一对应）：

   ```
   插件 ID / 目录名     siyuan-plugin-xxx
   图标组名             xxx        （data/emojis/<组>/）
   assets 目录          /assets/xxx/
   CSS 前缀             xxx 缩写-   （每个插件独立，如 lmi- / itc- / asi- / gcv-）
   ```

   多插件同时加载，共用类名会互相污染——前缀必须独立。
5. **i18n**：`zh_CN.json` 与 `en_US.json` **key 集合必须完全一致**（测试里有对齐断言）；占位符用 `$1` 手动 `.replace()`；**进 HTML 的文本一律过 `esc()`**。
6. **key / 密钥只存本地 petal**（`data/storage/petal/<插件名>/`），不硬编码、不上传、不进 README。

## 二、必抄机制清单（血泪换来的，不要重新发明）

| 机制 | 正确做法 | 错误做法的后果 |
|---|---|---|
| 当前文档 id | `getAllEditor()` 拿 protyle 读 `block.rootID` | `.protyle-title[data-node-id]` 选择器永远为空 |
| 设图标后刷新 | `background.ial.icon = v; background.render(ial, rootID)` + `model.parent.setDocIcon(v)` | 只写数据界面不更新，看着像没生效 |
| 图标属性值 | `<组>/<文件>`，如 `game-covers/xxx.png` | 带 `/emojis/` 前缀不生效 |
| assets 上传 | `assetsDirPath` 以 `/` 结尾 | 不带尾斜杠上传失败 |
| 表情面板注入 | MutationObserver 在 `onunload` 必须 `disconnect()` | 插件重载后注入两个 tab |
| 表情面板模式判断 | `isIconMode()`：`[data-action="remove"]` 是否可见（思源内部 B 变量未暴露） | 点错动作：设图标/插正文颠倒 |
| 搜索框 | `bindSearchInput`：`isComposing` / `keyCode 229` 时回车不提交；组词中不触发筛选 | 中文输入法回车插入半截结果、候选框被打断 |
| 查询时机 | **回车才查**，输入过程不发请求 | 每击键都请求，疯狂请求 + 打断输入法 |
| HTML 文本 | 一律 `esc()` | XSS / 布局炸裂 |
| 插入正文 | 图片落盘 `/assets/<目录>/`（上传接口），失败兜底 `/api/block/insertBlock`；按内容 id 缓存避免重复上传 | 导出后断图、重复上传堆积副本 |

## 三、数据源接入规范（以 SteamGridDB 为例）

1. **成功判断看 body 的 `success` 字段，不看 HTTP 状态码**——鉴权失败也返回 HTTP 200 + `{"success": false}`。
2. 请求参数最小集一次带全：`mimes=image/jpeg,image/png`、`nsfw=false`、`humor=false`（少一个都会出脏数据或格式不兼容）。
3. **列表展示用 `thumb`，下载落盘用 `url`**——几十张原图同时加载会把面板卡死。
4. 多候选游戏**优先 `verified: true`**——首条经常是同名 DLC / 试玩版。
5. 一次搜索固定请求数（本系列约定 2 个：autocomplete + grids），只对选中的那一个取数据。
6. 没填 key：**零请求**，面板显示引导页（主按钮「去申请」直达申请页 + 次按钮「打开设置」），不弹错误框。
7. key 的读写要**归一化**（见坑 16）。
8. 宣传图素材可走站点公开端点（无需 key）：`POST https://www.steamgriddb.com/api/public/search/main/games`，body `{"term":"…","asset_type":"grid"}`。

## 四、日常开发流程（每轮迭代都走这一遍）

```bash
cd <项目目录>

# 1. 改代码（index.js / index.css / i18n …）

# 2. 测试必须全绿（详见第五节）
npm test                      # = smoke-test.mjs + ui-test.mjs

# 3. 打包（自动校验 name=目录名、icon≤64KB、preview≤512KB）
npm run package               # 产出 package.zip

# 4. 安装进思源工作区
unzip -o -q package.zip -d ~/Documents/思源笔记/data/plugins/siyuan-plugin-xxx/

# 5. 让运行中的思源重新加载（不重启）
curl -s -X POST "http://127.0.0.1:6806/api/system/reloadUI" -H "Content-Type: application/json" -d "{}"

# 6. 实机验证清单
#    □ 面板能开（顶栏 / ⌥⌘G / 表情面板 tab / 面包屑）
#    □ 搜索出结果、尺寸 chips 生效
#    □ 左键插入正文（图片在 /assets/ 下）
#    □ 悬停按钮设为文档图标（标题图标真的变了）
#    □ 无 key 时引导页正确、零请求
#    □ IME 组词回车不误触
```

## 五、测试规范

两份测试都是**无头**的，不依赖思源运行：

- **`scripts/smoke-test.mjs`（vm 桩）**：语法解析、生命周期注册数（1 command / 1 topBar / 1 icon symbol / 快捷键避开 ⌥⌘I/J/C）、纯逻辑（清洗/转义/ext 推断）、**失败路径**（no key / success:false）、**loadData 各种返回形态**、i18n key 对齐、README 关键内容、plugin.json 字段。
- **`scripts/ui-test.mjs`（jsdom 真实 DOM）**：面板结构、无 key 零请求、请求时序与参数、点卡片=插正文（断言没调 setBlockAttrs）、悬停按钮=设图标（icon 值格式 + ial.icon 刷新）、IME 两条、右键菜单、Esc 分层、表情面板注入一次不重复、垃圾桶可见/隐藏两种模式分流、onunload 断连。

纪律：

1. 两个文件全绿才能打包；`npm test` 一条命令跑完。
2. **修任何 bug 必须先补一个能复现它的回归用例**（例：loadData 返回字符串形态导致 key 读不出 → smoke 里加四种形态断言）。
3. 新功能先写断言再实现，验收点从需求文档里逐条对编号搬。
4. 改 i18n 必跑测试（key 对齐 + 数量断言会兜底）。

## 六、发布流程

```bash
# 1. 版本号双升（plugin.json + package.json 保持一致，semver）
# 2. npm test 全绿
# 3. npm run package
# 4. 提交推送（作者身份 unmime）
git add -A && git commit -m "feat: …" && git push
# 5. 发 Release 并挂包（集市按 release 取版本）
gh release create vX.Y.Z package.zip --title "vX.Y.Z" --notes "…"
# 6. 确认仓库 topic（集市爬虫按 topic 收录）
gh repo edit unmime/<name> --add-topic siyuan-plugins
```

- 仓库 `url`（plugin.json）必须指向真实 GitHub 仓库；仓库名与插件 ID 一致。
- 集市索引由 siyuan-note/bazaar 的 CI 周期性扫描 **topic `siyuan-plugins`**，收录延迟几分钟到几小时。
- 发布后验证：`curl https://raw.githubusercontent.com/<owner>/<name>/main/plugin.json` 字段无误；release 资产里有 package.zip。
- gh CLI 注意：`gh auth status` 显示的账号名可能是 keyring 陈旧标签，**以 `gh api user` 为准**。

## 七、宣传图规范（集市详情页头部 + README 首图）

- **画幅 1024×768**，体积 ≤512KB。
- 两套已验证版式（源文件保留在 `/tmp/gcv-icon/`，建议迁到项目目录）：
  1. **iTunes 版**：浅灰渐变底 + 左侧文案区（蓝徽章 / 大标题 / 副标题 / 分隔线 / 灰色小字）+ 右侧封面拼贴 + 底部深色横幅白字标语；
  2. **App Store 版**：同底幅 + 背景**幽灵水印**（照片要低透明度，注意体积）+ 右侧**白底圆角卡片、整体 −12° 旋转**、出血 + 底部**白字阴影标语**（无深色条，用渐变压暗）。
- 照片类封面直出 PNG 会到 1MB——用 **sharp 调色板量化**：`sharp(in).png({palette:true, quality:92, effort:10})`，1024×768 可压到 ~265KB 且无可视劣化。
- 渲染：Chrome headless `--screenshot`；体积超限时用 `--force-device-scale-factor` 降栅格。
- 素材来自数据源官方/公开渠道，宣传图注明数据来源与版权归属。

## 八、坑清单（持续追加，动代码前扫一遍）

| # | 坑 | 对策 |
|---|---|---|
| 1 | 用 HTTP 状态码判断成功 | 看 body `success` 字段 |
| 2 | grids 不加 `mimes` | 返回 webp/ico，正文渲染异常 |
| 3 | 不加 `nsfw/humor` | 搜出不该出现在笔记里的图 |
| 4 | 列表直接用 `url` 原图 | 面板卡死，必须 `thumb` |
| 5 | 文件名只用游戏名 | 同游戏多图互相覆盖，加内容 id |
| 6 | 扩展名写死 `.jpg` | 按 mime/URL 推断 |
| 7 | 取 `data[0]` 当游戏 | 优先 `verified` |
| 8 | `assetsDirPath` 无尾斜杠 | 上传失败 |
| 9 | 没填 key 也发请求 | 控制台红色报错；无 key 零请求 |
| 10 | setBlockAttrs 后不刷新 UI | `background.render` + `setDocIcon` |
| 11 | 用标题元素选择器取文档 id | 走 `getAllEditor().block.rootID` |
| 12 | MutationObserver 不 disconnect | onunload 断连 |
| 13 | 图标值带 `/emojis/` 前缀 | 只写 `<组>/<文件>` |
| 14 | 每击键都请求 | 回车才查 |
| 15 | class 不加独立前缀 | 和其他插件撞样式 |
| 16 | **loadData 返回形态当固定** | 3.8.9 实测按 content-type 可能给对象或原始字符串，缺失时 resolve ""、生命周期结束 reject——**必须归一化**（对象 / JSON 字符串 / 裸值 / 空都兼容） |
| 17 | **设置确认后已开的面板不刷新** | confirmCallback 里回调面板的 reset（如 `_pickerReset`），Dialog destroyCallback 清引用 |
| 18 | **更新 preview.png 后集市/前端还是旧图** | `/plugins/*` 静态响应无 ETag/Cache-Control，前端启发式缓存数小时——**升版本号 + 清 Electron 缓存（`~/Library/Application Support/SiYuan-Electron/Cache*`）+ 重启** |
| 19 | **gh 显示的账号名不可信** | keyring 标签可能陈旧，以 `gh api user` 为准 |

## 九、本机环境备忘（速查）

```bash
# 思源
工作区        ~/Documents/思源笔记
插件安装位    ~/Documents/思源笔记/data/plugins/<name>/
petal 存储    ~/Documents/思源笔记/data/storage/petal/<name>/conf.json
内核          http://127.0.0.1:6806（token 在 conf/conf.json 的 api.token）
重载界面      curl -X POST http://127.0.0.1:6806/api/system/reloadUI
笔记 API      POST /api/notebook/lsNotebooks · /api/filetree/createDocWithMd

# 本插件
项目目录      iCloud Drive/项目/思源插件/siyuan-plugin-game-covers/（git 仓库）
发布仓库      https://github.com/unmime/siyuan-plugin-game-covers
恢复开发依赖  npm install（node_modules 不进 iCloud）

# 身份
GitHub        unmime（gh auth status 的标签名可能不准，以 gh api user 为准）
```
