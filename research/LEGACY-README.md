# 听见 · 本地语音试听室

Qwen3-TTS 1.7B 和 0.6B 原版已获用户试听认可。新增 `/?realtime=1` 电脑端实时实验：本地 BF16 CUDA 加速和纯浏览器 FP16 / FP32 WebGPU 两个独立引擎；原版样音仍在首页。PDF/EPUB、整本转换、MP3/ZIP 和刷新续转不属于本轮。

实时运行与测量边界见 [QWEN-REALTIME.md](QWEN-REALTIME.md)。本地模式先在一个终端运行 `./scripts/start-realtime.ps1`，另一个终端运行下面的网页预览。首次安装用 `.qa/qwen-fast-env/Scripts/python.exe -m pip install -r scripts/requirements-realtime.txt`，依赖与原版 Python 环境隔离。本地服务只监听 `127.0.0.1:8765`，仅接受本项目 4173 / 5173 端口的来源。

## 第二轮：Qwen3-TTS 试听

首页默认显示 Qwen3-TTS 0.6B 官方原版预生成试听，并可切换 1.7B 对照。中文 Serena / Uncle_Fu，英文 Aiden，每个版本都共用一套模型。网页提供原文、WAV 播放下载、评价保存和导出；需要本机 Python 重新生成任意新文本。0.6B 配置见 [QWEN-06B-AUDITIONS.md](QWEN-06B-AUDITIONS.md)，1.7B 实测见 [QWEN-AUDITIONS.md](QWEN-AUDITIONS.md)。

之前的浏览器 Kokoro / Piper 实验保留在 `/?legacy=1`。以下有关浏览器实时推理与离线缓存的说明适用于旧版页面。

## 运行

需要 Node.js 22+ 和现代电脑浏览器（建议 Chrome / Edge）。

```sh
npm ci
npm run dev
```

正式构建及本地预览：

```sh
npm test
npm run build
npm run preview -- --port 4173
```

打开 http://127.0.0.1:4173 。静态托管时发布 `dist/` 到 HTTPS 根路径，保留 `.wasm`、`.mjs` 和 `sw.js`。目前未绑定托管账号或发布公网地址。

## 审核流程

1. 选择中文或英文，选内置短文、约五分钟长文，或粘贴自己的文本。
2. 单独生成或按顺序生成所选候选。各候选读取同一原文快照；同一时间仅一个模型运行。
3. 手动播放对比，核对原文并记录自然度、准确性、舒适度及问题。不会自动判定胜者。
4. 下载 WAV 或导出 JSON 审核记录；原文、版本、设备、计时、逐段信息和偏好保存在本机 IndexedDB。
5. 刷新可找回完成音频及评价；中断的试听保留已完成部分，需要重新生成。试听页不实现整本断点续转。

## 候选与限制

- 中文目标为**无明显地方口音的标准普通话**，所有新候选听感仍待审核。已按用户反馈移除晓北、晓妮，禁止继续生成；历史音频保留并标记为已否决。
- Kokoro v1.0：晓晓、云扬两款待审中文声音及两款英语女声，使用同一 FP32 权重；不默认勾选中文 v1.0。
- Kokoro v1.1-zh：默认只选择 001 女声，另有 010 男声。两者均有官方参考样音，但不把有参考等同于普通话通过验收。
- Piper：中文 Huayan medium、英文 Lessac high，两个独立权重。
- **Huayan 的模型卡将训练数据许可列为 Unknown；当前只是试听候选，尚不满足正式发布的许可验收。** Lessac 也有单独数据条款。来源见 `public/THIRD_PARTY.txt`。
- Kokoro 浏览器发音前端与官方 Python 实现并非逐字等价。v1.0 的中文适配使用 Misaki 音素映射、pinyin-pro 和 Intl 分词；v1.1-zh 使用固定提交的 uzen 前端。因此本页评估的是「模型 + 浏览器前端」，不能把发音错误直接归因于权重。
- 中文英文通过后，才审核法语、西语、俄语实际样音；此版未宣称支持或验收这些语言。

页面提供 v1.1-zh 官方预录样音链接（打开 Hugging Face 官方页面，不上传文本）。这些参考使用不同原文、动态速度及段间补静音，只用于核对音色/口音，不参与公平速度比较。核实依据和修复边界见 [MANDARIN-AUDIT.md](MANDARIN-AUDIT.md)。

## 推理、计时与缓存

文本只在本机 Worker 中处理，不发送到语音 API。权重从 Hugging Face 匿名下载，固定在 `src/model-manifest.json` 的提交版本。首次使用约下载 63–339 MB 权重，另有运行库、词典和约 0.5 MB/声音的向量。不会预先加载全部模型。

Kokoro 自动优先 WebGPU，初始化失败回退 WASM；运行中 GPU 错误可在设置中改 CPU 后重试。Piper 使用 WASM。所有模型原速、FP32。没有 API key、个人免费额度或云推理依赖；网站流量和用户本地算力仍有成本。

下载时间、包含下载的总加载时间、文本发音转换与推理时间、首段可听总等待分别记录。生成/音频时长 < 1 表示快于实时。JS 内存指标若浏览器不支持则明确显示不可用，不把它冒充总进程内存；长时间内存需另用浏览器任务管理器核对。

响度按段用有效声音 RMS 目标 −20 dBFS、峰值上限 0.94 统一，不是完整 LUFS 标准。试听与导出是相同 PCM，保留模型采样率。分段超长会再拆分；未支持的音素和无效音频会明确报错，不静默截断。

模型使用 Cache API 缓存；正式构建通过 Service Worker 缓存页面、脚本和按需运行库。**首次联网完成一次生成，再刷新页面后**，相同已缓存模型和声音可离线使用；新声音仍需下载。开发模式不缓存页面。不提供后台下载/存储永久性保证，浏览器可能回收站点数据。

发布更新后，关闭该站点的旧标签再打开，以启用新的完整缓存版本。旧版页面资源暂时保留，避免运行中的任务引用失效脚本；如需回收它们，可在浏览器站点设置清除缓存（不要清除 IndexedDB，除非也要删除试听记录）。

此版最长 12,000 字符，音频片段及合并 WAV 位于浏览器内存和 IndexedDB，适合试听，不是整本书的内存方案。完整网站阶段将改 OPFS 流式保存和 Worker 编码。

## 源码结构

`App.tsx` 试听和审核界面；`engine.worker.ts` 下载、加载、分段推理和释放；`audio.ts` 分段/响度/WAV；`storage.ts` 历史；`catalog.ts` 候选；`samples.ts` 原创样本。

`scripts/prepare-assets.mjs` 从已锁定 npm 包复制 WASM 文件，不依赖运行时 CDN。`scripts/vendor-frontends.mjs` 可重现上游前端来源；`scripts/resolve-models.mjs` 仅在有意更新候选版本时运行（会改变固定提交）。

应用源码 GPL-3.0-or-later。上游代码、语音权重、语料和二进制保留各自许可证；参阅 LICENSE、THIRD_PARTY 和上游构建来源。
