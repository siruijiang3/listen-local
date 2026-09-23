# Qwen 0.6B 电脑实时实验

入口：`http://127.0.0.1:4173/?realtime=1`。首页的原版 0.6B / 1.7B 样音、已有审核记录均保留。

## 运行

当前机器已安装独立 `.qa/qwen-fast-env`，不要与原版 `.qa/qwen-env` 混装。

在另一台具备 CUDA 的 Windows 电脑首次安装时，先创建独立环境并下载固定版本权重；当前机器不需要重复执行：

```powershell
py -3.12 -m venv .qa/qwen-fast-env
.qa/qwen-fast-env/Scripts/python.exe -m pip install -r scripts/requirements-realtime.txt
.qa/qwen-fast-env/Scripts/python.exe scripts/download-qwen.py --size 0.6B
```

下载脚本在没有本机元数据时使用下述固定提交，已有元数据时复用其中提交。不会在新电脑上悄悄改用模型仓库最新版本。

```powershell
./scripts/start-realtime.ps1
# 另一个终端
npm run build
npm run preview -- --port 4173
```

固定 Faster Qwen3-TTS 0.4.0、qwen-tts-hf 0.1.1.post1、Transformers 5.15.1、Torch 2.6.0+cu124。完整当前依赖见 `scripts/requirements-realtime-lock.txt`。5.17.0 实测在 Mimi RoPE 配置加载时报错，因此固定 5.15.1；原版环境未改变。

本地模式复用官方 `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice`，revision `85e237c12c027371202489a0ec509ded67b5e4b5`，BF16 / SDPA。Serena、Uncle_Fu、Aiden 共用一套权重。temperature 0.9、top-k 50、top-p 1、repetition penalty 1.05，subtalker 保持默认采样。没有量化、变速或音高修正。实时 PCM 没有等待整段响度归一化；原版预录样音曾做整段 RMS 调整，比较音量时需注意此区别。

服务仅监听回环 8765，检查精确 Origin，只允许一个页面持有模型。关闭页面或切换模式释放 CUDA。独立线程拥有全部模型 / 图状态；网络收发、停止、播放反馈与推理分开运行。模型准备阶段单独完成加载、图捕获和解码预热。

## 播放与存储

- AudioWorklet 固定 32 秒 PCM 环形缓冲；首次至少 0.5 秒，生产端在约 29 秒处等待播放反馈，最大在途块不超过约 1 秒。
- 暂停只暂停消费；继续从原位置读。停止或换声音会重置任务编号，拒绝迟到音频及不连续序号。
- 所有正文字符按原顺序保留；正常文本按自然句段组织。不翻译、不重写。达到生成上限会报错，不能以“完成”掩盖截断。
- PCM16 分块写入 OPFS 的 `qwen-realtime-v1/<runId>/`。WAV 导出逐块复制到 OPFS 文件，不拼接全书 JS 数组。导出过程中新增片段留待下一次导出。
- 当前页可导出本次记录和已完成音频；没有实现刷新后的任务续转。“本机测量记录”可重新读取 OPFS 中已保存的完成记录并查看 JSON。测量轨迹最多保留最近 3600 个每秒样本；音频缓存可在页内清理。

## 计时定义

首个块：浏览器收到首个 PCM 包。可播放：累计达到 0.5 秒（短于该值的最终音频在结束时释放）。首次输出：AudioWorklet 首个非零样本映射到 AudioContext 输出时钟的估计；没有声卡回录，不声称是麦克风测得的扬声器首声。

页面同时报告“请求至首次输出”（从推理请求派发计时）及“启动至首次输出”（包含该次 AudioContext 恢复、OPFS 目录准备和旧任务收尾）。自动短文批测在批次开始时初始化音频设备，不能替代首次手动点击的冷音频初始化测量。导出保留两个字段及 `setupSeconds`。

RTF = 实际生成耗时 / 音频时长，小于 1 为供给快于播放。主动等待缓冲的时间单独列出并从生成耗时扣除。最大包间隔包含主动背压，不能直接当成卡顿；卡顿由 Worklet 缓冲不足计数。CUDA allocated / reserved / peak、Python RSS 分开记录；`gpu-monitor.jsonl` 是全显卡占用，含浏览器和桌面。浏览器显存不可用，未用 JS heap 冒充。

浏览器轨迹中的 `jsMainThreadHeapBytes` 仅是主页面 JavaScript 堆的近似值，不包含 Worker、ORT WASM、GPU 和全部浏览器进程内存；不支持时为 null。只能用于发现页面堆增长，不能单独证明浏览器总内存有界。

## 纯浏览器路线

Worker 只加载静态 ONNX 文件；没有 WebSocket 或服务端推理回退。使用单独 ORT Web 1.30.0，旧候选继续使用原 1.22.0。每个神经网络图都设置 `session.disable_cpu_ep_fallback=1`。主权重 FP16、解码器 FP32，未量化；文本投影、注意力累加、残差预测器 SwiGLU 乘积和 down projection 使用 FP32 稳定性处理。全 FP16 预测器在官方 Python 中也出现溢出，本实现不会把非有限结果继续送去播放。

官方特殊标记、语言、声音映射来自固定配置；12 篇原文逐条验证 token ID 与官方 Python 一致；三声的 prefill、预测器及下一步 logits 与独立官方 FP32 结果校验。FP16 近似不承诺逐位相等，前处理采用相对 RMS / cosine 门槛，logits cosine 至少 0.999、主生成器 argmax 一致。优化图校验失败时只保留已验证的浏览器计算路径，并记录失败原因。

固定 37 帧解码图使用预分配 GPU 缓冲与图捕获；残差预测器使用 16 槽 KV 缓存，top-50 / temperature 0.9 采样在 GPU 内完成，每帧只读取一次结果；采样启用前与 JavaScript 参考逐项对照。主生成器测试 2048 槽静态 KV，同时保留动态图用于 prefill 和参考。位置编码常量在导出精度对照后按原 dtype 与数值恢复。

重建资源：使用原版 Python 只读取模型代码；额外 ONNX 工具安装于 `.qa/onnx-tools`，不改动原版环境。

```powershell
.qa/qwen-env/Scripts/python.exe -m pip install --target .qa/onnx-tools --no-deps onnx==1.17.0 onnxconverter-common==1.14.0
.qa/qwen-env/Scripts/python.exe scripts/prepare-qwen-tokenizer.py
.qa/qwen-env/Scripts/python.exe scripts/export-qwen-prefill-reference.py
.qa/qwen-env/Scripts/python.exe scripts/export-qwen-step-reference.py
# 对 decoder / embeddings / cache / predictor / residual 分别执行；均在 CPU 导出
.qa/qwen-env/Scripts/python.exe scripts/export-qwen-webgpu.py --component decoder
.qa/qwen-env/Scripts/python.exe scripts/export-qwen-webgpu.py --component embeddings
.qa/qwen-env/Scripts/python.exe scripts/export-qwen-webgpu.py --component cache
.qa/qwen-env/Scripts/python.exe scripts/export-qwen-webgpu.py --component step
.qa/qwen-env/Scripts/python.exe scripts/export-qwen-webgpu.py --component predictor
.qa/qwen-env/Scripts/python.exe scripts/export-qwen-webgpu.py --component predictor-step
.qa/qwen-env/Scripts/python.exe scripts/export-qwen-webgpu.py --component residual
.qa/qwen-env/Scripts/python.exe scripts/finalize-webgpu-manifest.py
node scripts/verify-browser-tokenizer.mjs
```

导出清单含来源、字节数、SHA-256、CPU 数值误差。目前实验资源约 3.60 GB，另有运行库；其中包含基线与优化图的重复权重，未做最终包体去重。Cache API 按版本缓存，跨版本复用前验证 SHA-256。界面“本次下载”仅计传输量，缓存命中不会伪装成下载。加载计时不含资源读取；预热包含校验与图捕获，另列资源读取、传输及准备总时长。

## 验收记录

按用户要求已停止进一步测试，现有结果及未完成项见 `REALTIME-RESULTS.md`。本机本地加速的速度和 30 分钟播放已通过；浏览器当前持续速度未达标。用户反馈已试听对照音频没有问题，不等于所有长文已逐句核对。没有自动续测任务。
