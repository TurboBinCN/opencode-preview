# opencode-preview — NAS opencode V2 插件部署与安装测试任务卡

> 给 NAS 侧 agent / 维护者。目标：把 opencode-preview 作为 **opencode V2** 插件装进 NAS 生产 opencode（`/volume2/opencode-v2`，端口 4096），并在真实 V2 进程里完成"插件加载 → preview 工具可调 → Preview URL 渲染 200"的安装测试。**本卡允许自行修改插件源码来修复问题**；改完以本卡第 5/6 节的全绿与冒烟通过为验收。

## 1. 仓库下载地址（本项目即是本体）

- fork 仓库：**https://github.com/TurboBinCN/opencode-preview**
- **必用 `v2` 分支**（V2 插件 API；`main` 是 V1 别名补丁，NAS V2 不适用）
- GitHub 直连被墙时走 ghfast.top 速度代理（NAS 已知可用）：

```bash
git clone -b v2 https://ghfast.top/https://github.com/TurboBinCN/opencode-preview.git /volume2/opencode-v2/plugins/opencode-preview
# 或先 clone 再切分支：git clone .../opencode-preview.git <dir> && cd <dir> && git checkout v2
```

- 免密方式：NAS 侧 agent 的 git 若需要认证，本项目 clone 用 **public fork 即可匿名只读**；无需写权限。需要提 PR/改回时：把改动推自己的 fork 或可直接改本机主库后按 Conventional Commits 合入。

推荐落盘位置：`/volume2/opencode-v2/plugins/opencode-preview`（与 config 平级，便于 compose 挂载），或挂进已挂载的 workspace（`/workspace/opencode-preview`，无需改 compose 即可引用）。

## 2. 依赖 / 构建

- 需要 **bun ≥ 1.4**（`bun install` + `bun test` + `bun run dev` 都靠它）。NAS 容器定制镜像若无 bun：用 curl 装（`curl -fsSL https://bun.sh/install | bash`，装完 PATH 补 `~/.bun/bin`）；装好后 `export PATH="$HOME/.bun/bin:$PATH"` 再继续。
- 幂等安装 + 建产物（在仓库目录内）：

```bash
bun install
# bun test 应全绿（本机基线 44/44，Windows 平台无关断言；NAS Linux 上应同样 44 绿，此为基线，别低于它）
bun test
# 可选：V2 入口 src/index.ts 可被 bun 直接加载；如加载器要求 dist，再 bun run build
```

## 3. 插件引用（V2 原生 config）

- NAS V2 配置文件：`/volume2/opencode-v2/config/opencode.jsonc`
- `plugins` 数组加入**目录字符串**（V2 形态，与本机 `E:\AI-Agents\opencode-preview` 同理；若插件目录没挂进容器，先改 compose 加 volume 映射 + 重建）：

```jsonc
"plugins": [
  "/volume2/opencode-v2/plugins/opencode-preview"   // 或 /workspace/opencode-preview（已挂载）
]
```

- **V2 API 要点**（若遇"插件不加载 / 加载报错"先对照）：
  - 入口必须且只能一个 `export default Plugin.define({ id, setup })`；`@opencode/plugin` **无顶层 `define`**，必须 `import { Plugin } from "@opencode/plugin"`（≡ `@opencode/plugin` SDK）
  - 工具注册走 `ctx.tool.transform`；`setup(ctx)` 里 `ctx.register({ preview })`
  - 已文档在本仓库 `README.md`（V2 分支章节 + V1/V2 行为差异表），对照排查

## 4. 安装测试（冒烟，分两档）

**档 1 — 独立模式（不依赖 LLM，最快出硬证据，50s 内）**
```bash
cd /volume2/opencode-v2/plugins/opencode-preview
bun run dev            # 默认 PREVIEW_PORT=17890
# 另开窗口：
watch -n1 'ss -ltn | grep 17890'        # 直到 LISTEN
curl -s http://127.0.0.1:17890/api/projects   # 应含 seed 默认项目（注册表种子在 default）
```

**档 2 — 真实 V2 进程内加载（最终验收，需 LLM 端点在线）**
- 在 NAS opencode V2（4096）里发起会话，让 agent 调用 `preview` 工具（如 `preview(file=E:\...\README.md)`）
- 判定：工具返回 **Preview URL**（形如 `http://<host>:17890/preview?project=...&file=...`），且对该 URL `curl` 返回 **200 HTML 渲染页**
- 若需浏览器访问宿主：compose 需把 17890 映射/放行（参考 4096 的映射方式）

**关键背景（本机已交付的证据）**：bun test 44/44 全绿 + 独立模式 HTTP 冒烟通过（17890 LISTEN + `/api/projects` 种子 + `/api/files` 文件清单）。**唯一未在真实进程验证的 = "opencode V2 自己的插件加载器接受 Plugin.define 模块 + preview 工具真实可用"** —— 这正是档 2 要补的最后一块。若档 2 失败，优先看 src/index.ts 的 `Plugin.define` 定义是否过 V2 加载器 Schema（对照 node_modules/@opencode/plugin 的类型）。

## 5. 允许自行修复（改完必须重跑验证）

- 改源码 `src/index.ts` / `src/server.ts` 可自由；**验收门槛 = bun test 全绿（≥44）+ 档 1 + 档 2 冒烟过**
- 已知坑速查：
  - 双 `export default` 冲突 → V2 只允许一个 `Plugin.define` 默认导出
  - `path.resolve` 平台差异（Windows drive-relative）→ 实现已用 `path.resolve(rootDir)` 归一，测试断言用平台无关 `path.resolve`，改时保持
  - V2 `@opencode/plugin` 无顶层 define / serverUrl / client / `$` / ask → 项目注册走进程内注册表，外部文件预览无交互 ask（README 差异表）
- 改完在仓库内 `bun test` 全绿后再提交（Conventional Commits：`fix:` / `feat:` / `docs:` 前缀）

## 6. 完成判定与回写

- [ ] bun test ≥44 全绿（NAS 侧）
- [ ] 档 1 冒烟：17890 LISTEN + /api/projects 有项目
- [ ] 档 2 冒烟：真实 V2 会话里 preview 工具返回 Preview URL 且 curl 200
- 三项全过 → 部署完成；回写本机 `D:\Wiki` 的 opencode-preview 两篇文档 v2 节 + `AGENTS.md`（NAS 插件引用格式 / bun 安装 / 冒烟结论）

---
本卡由主库作者（TurboBin 本地机）于 2026-09-21 提供；fork `v2` 分支 HEAD 8b97c74 为移植基线。
