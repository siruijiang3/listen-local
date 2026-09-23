# Qwen3-TTS 加速研究

核实日期：2026-09-23。范围：已获用户认可的 0.6B CustomVoice，优先保留 Serena / Uncle_Fu / Aiden 与原文听感，最终仍以纯浏览器生成有声书为目标。本轮做源码核查、原版离线诊断和资料研究，没有安装加速引擎或改动已审核音频。

## 结论

存在值得实测的加速路线。最具体的原生验证候选是 MIT 许可的 `andimarafioti/faster-qwen3-tts`：使用固定 KV 缓存和 CUDA Graphs，并支持 CustomVoice 的音频流式输出。优先用现有未量化权重验证它，可以把推理实现变化和量化质量变化分开。

原生加速成功不等于浏览器移植成功。纯浏览器路线应验证 ONNX Runtime Web 的 GPU 常驻张量、静态形状、WebGPU Graph Capture 和增量解码，再根据实际性能选择 FP16 或混合精度。原生 CUDA Graphs 不能直接运行于浏览器。

## 本机诊断证据

脚本：`scripts/profile-qwen-baseline.py`。复用现有 Python 环境与已缓存 0.6B 原版权重，官方 qwen-tts、BF16、SDPA、6 CPU 线程、seed 42、Serena。先预热，再诊断“雨停的时候，天还没有完全亮。”，没有更改系统设置。

| 项目 | 结果 |
| --- | ---: |
| 输出音频 | 2.72 秒 |
| 带 cProfile 的总运行 | 15.0606 秒 |
| 模型生成语音 codec token | 14.9380 秒 |
| codec 解码为波形 | 0.1173 秒 |
| Python profiler 记录的函数调用 | 1,188,562 次 |

原始记录：`.qa/qwen-baseline-profile.json`、`.qa/qwen-baseline-profile.pstats`。cProfile 会增加开销，此处用于定位阶段，不是新的速度成绩。Python 调用次数不等于 CUDA kernel 数量；异步 GPU 执行下，Python 函数的时间也不能直接解读为 GPU 计算时间。该诊断不能完全解释之前 0.6B 中文耗时波动。

可确认的是，这条短句的耗时主要集中在自回归 codec 生成，波形解码不是主要耗时。单独优化音频文件编码、网页播放器或 PDF 解析，无法解决此处的持续生成速度。

本地两个官方 config 显示：Talker 均为 28 层，0.6B hidden_size=1024，1.7B 为 2048；Code Predictor 都是 5 层、hidden_size=1024、16 个 code group。官方模型实现每步调用 Code Predictor 的 `generate(max_new_tokens=num_code_groups-1)`，即预测另外 15 个 token。因此缩小 Talker 不会同比消除所有串行生成工作；这些配置证据不代表两版本 Predictor 权重相同。

## 路线一：固定缓存与 CUDA Graphs，优先做原生验证

[Faster Qwen3-TTS 上游](https://github.com/andimarafioti/faster-qwen3-tts)提供固定缓存、图捕获重放和流式输出。其关键作用是减少每个生成步骤中重复的 Python/GPU 调度，而不是训练更小的模型。[PyTorch 官方说明](https://pytorch.org/blog/accelerating-pytorch-with-cuda-graphs/)也将减少 CPU launch 开销列为 CUDA Graphs 的用途。

上游报告的 Windows RTX 4060 结果如下，均为作者数据、非本项目复现，也不应当认为与本机 Laptop GPU、中文文本和声音相同：

| 模型 | 生成速度：音频秒 / 墙钟秒 | 换算到本项目的 RTF：墙钟 / 音频 | 首个可播放块 |
| --- | ---: | ---: | ---: |
| 0.6B | 2.26 | 0.442 | 413 毫秒 |
| 1.7B | 1.83 | 0.546 | 460 毫秒 |

注意：该项目把音频时长/生成耗时称为 RTF，方向与本项目正好相反。不能把其 2.26 误读为比实时更慢。

该硬件表的首块数据使用 Base voice-clone streaming、chunk_size=8；不能直接宣称 Serena/Uncle_Fu/Aiden 已有同样成绩。上游另有 CustomVoice 流式模式及对照测试，足以支持把 0.6B CustomVoice 列为复现对象。当前结果支持“有明显加速希望”，不支持保证具体倍数、显存或中文质量。

测试时保留原始权重、BF16、相同文本、预设声音与采样设置，不先引入量化。静态缓存与不同 kernel 的浮点计算顺序可能改变生成输出，仍需试听；不宣称逐采样点相同。固定缓存和图捕获也可能增加保留显存，需记录预热与稳态峰值。

当前上游包版本在 pyproject 中为 0.4.0，依赖 `qwen-tts-hf` 和 Transformers 5，而现有试听环境使用官方 `qwen-tts`。上游明确不能把两个同名导入包混装在同一环境。应使用独立环境并固定提交/版本，复用只读模型目录，保留原版作为对照。[依赖文件](https://github.com/andimarafioti/faster-qwen3-tts/blob/main/pyproject.toml)、[Windows 指引](https://github.com/andimarafioti/faster-qwen3-tts/blob/main/WINDOWS_SETUP_GUIDE.md)。

## 路线二：把适用的优化用于纯浏览器

[ONNX Runtime Web 官方文档](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html)确认两项相关能力：

1. GPU IO binding：让前一步的输出、下一步输入与 KV 缓存留在 GPU，减少每步 GPU/CPU 往返。
2. WebGPU Graph Capture：固定形状且所有计算 kernel 在 WebGPU 执行时，尝试记录并复用运行命令。存在动态形状或 CPU fallback 时不能直接假设可用。

建议移植顺序：先建立普通 WebGPU 数值与听感对照 → 让缓存常驻 GPU → 为 decode 使用固定或分桶的缓存容量及预分配缓冲 → 验证图捕获 → 检查 15 步 Predictor 是否仍有过多 JavaScript 往返或 GPU readback → 优化图内采样/算子融合 → 接增量音频解码。

这是工程路线，不是已完成的 Qwen 浏览器性能结果。预填充和逐步解码的形状不同，需分别处理，不能对任意现成 ONNX 文件加一个选项便期待获得原生速度。

## 路线三：量化、融合和其他运行时

| 方法 | 价值与优先级 | 边界 |
| --- | --- | --- |
| FP16/BF16 权重下的静态缓存、图捕获 | 第一优先，先验证运行开销 | 无需先改权重精度，仍须听感复核 |
| 融合 RMSNorm、RoPE、线性等重复算子 | 减少 launch 与中间张量开销 | 需依后端能力验证，不只改模型格式 |
| INT8/INT4、混合精度 | 压缩下载与内存；之后衡量加速 | 解量化和 kernel 支持决定是否更快，必须重听 |
| FlashAttention / torch.compile | 可作为原生进一步优化候选 | 当前已有 SDPA；不能仅凭缺 flash-attn 警告认定是主因。图捕获候选不依赖 FlashAttention/Triton |
| 原生 C/C++ 引擎 | 更精简的本地运行组件候选 | 仍不等于浏览器；需逐后端验证声音、采样与流式行为 |
| 多段批处理 | 可能提高整本离线转换吞吐 | 增加显存、可能影响首段延迟；不是单用户即时播放首选 |

[ONNX Runtime 量化文档](https://onnxruntime.ai/docs/performance/model-optimizations/quantization.html)说明量化收益依赖硬件和算子，并存在量化/解量化开销。不会预设“INT4 一定比 FP16 快”或“量化完全不损失听感”。[原生 C 项目](https://github.com/gabriele-mastrapasqua/qwen3-tts)可作后备研究对象，本轮未运行该引擎。

## 怎样真正边听边生成

音频块与文本段分别设计：文本保留自然句段和语气上下文；模型在生成途中输出短音频块，不必等整段文本对应的声音全部完成。建议实测 4 / 8 / 12 帧配置的首块、吞吐与接缝，首块更小不一定总体验更好。初次模型加载、图捕获、预热单独显示；稳态常驻模型避免每段重载。

生成线程持续生产、播放队列独立消费；不能播完一块再请求下一块。浏览器 AudioWorklet 播放 PCM，并维护有限预读缓冲；已完成片段存 OPFS，MP3 导出不阻塞首声。增量解码保留必要上下文并裁剪重叠，避免人为重复和接缝。

## 建议的下一次实验

1. 独立环境固定 Faster Qwen3-TTS，原版 0.6B CustomVoice，Serena / Uncle_Fu / Aiden；不改听过的音频与环境。
2. 先测 3 种音频块大小：冷启动/预热时间、暖机首块 P50/P95、整段 RTF、图捕获后的实际显存、漏句/重复/尾部截断、接缝听感。重复运行并交错原版与加速版，避免单次波动当成模型差异。
3. 最优配置连续 30 分钟播放，记录最大供给间隙、缓冲不足次数与内存增长。目标沿用首声 ≤3 秒、RTF ≤0.7–0.8、1 倍速无卡顿；不是已经达成的指标。
4. 原生基准用于验证现有模型的可达性能及质量，不据此改变最终产品形态。浏览器原型另测 WebGPU；只有用户同意才采用需安装的本地组件。

研究判断：先验证不量化的执行优化，比立即降低精度更有针对性。纯浏览器仍是目标，但原生实时结果不能外推为所有浏览器与普通电脑都能实时。
