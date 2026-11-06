# Steam Games Cover Get

思源笔记插件。搜 [SteamGridDB](https://www.steamgriddb.com/) 上的游戏封面，
插进正文，或者设成文档图标。

![预览](preview.png)

## 先配 API Key（不配用不了）

SteamGridDB 全站鉴权，没有匿名接口，所以你需要一个自己的免费 key。四步：

1. 打开 https://www.steamgriddb.com/ ，用 Steam 账号或邮箱注册登录
2. 进 https://www.steamgriddb.com/profile/preferences/api
   （也可以走右上角头像菜单 → Preferences → API）
3. 页面上有 API Key 一栏，生成后复制整串
4. 思源 → 设置 → 第三方插件 → Steam Games Cover Get → 粘贴 → 保存

key 只存在你本地的工作区数据里，不会发给任何人，也不会上传到我这边。

## 怎么用

顶栏、面包屑、表情面板都有入口，快捷键 `⌥⌘G`。

打开面板直接打字搜游戏名，回车查询。搜到之后：

- 左键点封面 → 插到光标处
- 悬停卡片右上角按钮 → 设为文档图标
- 右键 → 两个选项都有

## 关于封面尺寸

默认取 `600x900` 竖版，适合当封面和文档图标。面板顶部的 chips 可以切横版（460×215）和方形（512×512）。

SteamGridDB 是社区库，同一个游戏有几十张不同风格的图，质量参差。默认按评分排序，往前的通常是好的。

## 数据来源

封面全部来自 [SteamGridDB](https://www.steamgriddb.com/)，版权归各上传者和原游戏厂商。
本插件只做检索和插入，不存储、不再分发这些图片。
