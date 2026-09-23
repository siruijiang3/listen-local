# Qwen3-TTS 0.6B 原版试听

后续用户反馈：本轮 0.6B 听感也很好，情感表达不如 1.7B 充沛，但更自然。原版性能对照及下一阶段方案见 [QWEN-RUNTIME-PLAN.md](QWEN-RUNTIME-PLAN.md)。下文保留本轮生成时的审核边界，新的精度、运行引擎与语言仍需分别审核。

本轮用于判断 0.6B 原版能否保留用户认可的 1.7B 听感；不是量化版本，也不是浏览器内推理实验。所有新样音仍由用户审核，未自动继承 1.7B 的审核结果。

- 官方模型：`Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`
- 固定权重版本：`85e237c12c027371202489a0ec509ded67b5e4b5`
- 完整文件：2,498,388,392 字节；首次下载 47.78 秒。
- 官方 qwen-tts 0.1.1；PyTorch 2.6.0+cu124；RTX 4060 Laptop GPU；BF16、SDPA，未量化。
- 沿用 1.7B 测试原文、Serena / Uncle_Fu / Aiden、随机种子、默认语速、空风格指令、长文分段和整条音频响度处理。
- 每种声音五段短文、一段长文，共 18 条；长文按原始段落拼接，不额外插入静音。

网页默认显示 0.6B，可以切换到 1.7B 对照，保留当前原文。音频文件、清单、ZIP 分目录保存；评价仍使用音频指纹标识，两个版本互不覆盖。导出评价只包含当前模型的记录。

## 复现

复用上一轮 `.qa/qwen-env` 和 `.qa/qwen-inputs.json`：

```powershell
.qa/qwen-env/Scripts/python.exe scripts/download-qwen.py --size 0.6B
.qa/qwen-env/Scripts/python.exe -u scripts/generate-qwen-auditions.py --size 0.6B
.qa/qwen-env/Scripts/python.exe scripts/package-qwen-auditions.py --size 0.6B
npm run build
```

不传 `--size` 时，这些脚本仍默认使用 1.7B，兼容上一轮操作。生成阶段强制离线，原文不会上传。

## 审核入口

- 网页：`http://127.0.0.1:4173/`
- 0.6B 音频：`public/auditions/qwen3-0.6b/`
- 1.7B 对照：`public/auditions/qwen3/`

内置浏览器曾在点击播放时崩溃，本轮不重复该故障测试；可用独立 Chrome / Edge 或下载 WAV、ZIP 到系统播放器审核。文件验证不能替代对读音、口音、漏读及自然度的试听。

## 运行诊断

首次中文女声短样音（22.08 秒）在默认 6 个 CPU 线程下生成耗时 118.05 秒。随后以 1 个 CPU 线程独立重跑相同输入、权重、精度、种子，耗时 115.16 秒，生成 WAV 的 SHA-256 与原文件完全相同。该检查未显示显著提速，因此正式样音仍沿用 6 线程配置；诊断输出保留在 `.qa/qwen06-thread-probe/`，不替换试听音频。运行环境的波动尚未隔离，不能直接把跨轮耗时差异归因于模型大小。

## 本轮交付结果

- 已生成 18 / 18 条，合计 1,301.44 秒（21 分 41 秒）。
- 中文长文：Serena 314.00 秒，Uncle_Fu 386.00 秒；英文 Aiden 长文 250.32 秒。
- 各条实际生成耗时合计 2,387.74 秒（39 分 48 秒），不含下载、模型加载、诊断重跑和打包。受运行环境波动影响，不作为严格的跨模型速度评测。
- 最大 PyTorch 已分配显存 2.71 GiB；不含其他进程、CUDA 上下文和未分配缓存，不等于整卡占用或浏览器最低配置。
- 下载包 `public/auditions/qwen3-0.6b/qwen3-auditions.zip`：45,163,537 字节，包含 18 个 WAV、18 份对应原文、清单和说明。
- 验证通过：18 种原文与声音组合完整、输入段落无缺失或重复、文件 SHA-256、PCM 格式、采样率、音频时长、非静音及峰值范围。1.7B 的 18 个原有 WAV 也重新校验通过。
- 未自动判定：实际读音、口音、漏读、重复和自然度。文件完整不代表朗读内容通过审核。
