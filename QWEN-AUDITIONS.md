# 第二轮试听：Qwen3-TTS 官方实现

后续用户反馈：本轮 1.7B 男女声及所试听条件已获认可。下文保留生成时的技术验收记录，文件校验本身不判定听感。当前正在审核 0.6B 原版，见 `QWEN-06B-AUDITIONS.md`。

本轮用本机官方 Python 实现预生成音频，静态网页只负责播放、下载和记录评价。没有将 Qwen 移植进浏览器，也没有调用云端推理。旧的浏览器实验和 IndexedDB 记录仍可通过 `/?legacy=1` 访问。

## 固定配置

- 模型：`Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice`
- 权重提交：`0c0e3051f131929182e2c023b9537f8b1c68adfe`
- 模型许可证：Apache-2.0；[官方仓库](https://github.com/QwenLM/Qwen3-TTS)、[模型卡](https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice)。
- 本机 RTX 4060 Laptop GPU，8 GB 显存；官方 qwen-tts 0.1.1，PyTorch 2.6.0+cu124，BF16 / SDPA。
- 中文 Serena、Uncle_Fu；英文 Aiden。没有使用官方标为北京/四川方言的 Dylan、Eric。
- 沿用 `src/samples.ts` 的原文。短文整段输入；长文只在原始空行处分段，拼接时不插入额外静音。每段 seed=42+段序号；空风格指令，官方默认采样参数，生成上限 4096 token。
- 整条音频统一有效声音 RMS 目标 −20 dBFS，峰值不超过 0.94；不调音高、不改播放速度、不删停顿。不是 LUFS 归一化。

每份音频的原文、分段、时间、采样率、校验值和运行信息写入 `public/auditions/qwen3/manifest.json`。网页不进行自动音质打分；用户评价保存在独立 localStorage 键中，并可导出 JSON。音素测试或生成完成都不能替代对普通话、自然度及漏读的人工审核。

## 本机复现（PowerShell）

使用 Python 3.12 创建项目专用虚拟环境。安装与此显卡驱动匹配的官方 PyTorch，然后安装 Qwen：

```powershell
python -m venv .qa/qwen-env
.qa/qwen-env/Scripts/python.exe -m pip install torch==2.6.0 torchaudio==2.6.0 --index-url https://download.pytorch.org/whl/cu124
.qa/qwen-env/Scripts/python.exe -m pip install -r scripts/qwen-requirements.txt
node scripts/export-qwen-inputs.mjs
.qa/qwen-env/Scripts/python.exe scripts/download-qwen.py
.qa/qwen-env/Scripts/python.exe -u scripts/generate-qwen-auditions.py
.qa/qwen-env/Scripts/python.exe scripts/verify-qwen-auditions.py
.qa/qwen-env/Scripts/python.exe scripts/package-qwen-auditions.py
npm run build
npm run preview -- --port 4173
```

第一次下载固定约 4.52 GB 的模型文件到 `.qa/models/`。下载后生成脚本强制离线模式，不发送文字。脚本按内容指纹跳过已完成音频，可重复运行续做未完成的样本。自定义文字需要修改输入并运行本地脚本；本轮没有开放网页任意文本合成接口。

## 文件与缓存

- 页面：`src/QwenAudition.tsx`；旧版：`src/App.tsx`。
- 本轮脚本：`scripts/*qwen*`。
- 音频文件名带内容指纹，避免修订后误听旧文件；清单及音频不进入旧版通用 Service Worker 缓存，避免缓存半截媒体响应或过期清单。
- Python 环境和权重在 `.qa/`，不随静态网站部署；发布 `dist/` 只包含页面和已生成的音频。
- 本轮页面不承诺浏览器离线缓存。下载的 WAV 可离线播放。
- 完成后提供全部样音 ZIP，内含 18 个 WAV、逐条原文 TXT 和可审计的清单，不包含个人审核记录。

内置浏览器之前点击播放会崩溃；本轮提供直接 WAV 下载作为独立审核途径。实际生成、WAV 解码与人工听感必须分别记录。

## 本轮实测与验收边界

18 条已生成：每个声音 5 段短文、1 段长文，共约 21.4 分钟音频。实际合成共约 35.7 分钟，不包含模型下载和加载。PyTorch 峰值已分配显存约 4.59 GiB；系统工具观察到的总显存占用约 7.1 GB，两者统计口径不同。

| 声音 | 语言 | 长文时长 | 长文生成用时 |
| --- | --- | --- | --- |
| Serena | 中文 | 320.48 秒 | 537.72 秒 |
| Uncle_Fu | 中文 | 360.00 秒 | 597.36 秒 |
| Aiden | 英文 | 245.52 秒 | 412.99 秒 |

- 通过：18 条原始输入及段落覆盖、唯一声音/文本组合、SHA-256、PCM16 单声道 WAV 头、采样率、时长、非静音及峰值边界；网页构建和格式检查。
- 浏览器验证：中英文切换、18/18 清单、长文时间范围、音频元数据、审核笔记刷新持久化、单条 WAV 与整套 ZIP 链接；HTTP 音频分段请求返回 206。
- 未通过的环境检查：内置浏览器点击播放后仍崩溃；未把加载成功视为播放通过。使用独立 Chrome/Edge 或下载到系统播放器审核。
- 尚未验收：实际读音、普通话口音、自然度、语义漏读/重复、跨段听感；未据此决定正式模型，也未验证其他语言或浏览器内 Qwen 推理。
- ZIP 共 44,863,726 字节，包含 18 个 WAV、18 个原文 TXT、清单及说明。
