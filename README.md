# 听见 · Listen Local

轻量 Windows 本地有声书客户端。React + Tauri 2 提供界面，独立 Python/PyTorch 进程使用 Qwen3-TTS 0.6B 生成语音。无需账户或云推理。

**0.1.1 为预览版。** 已完成本机 GPU/CPU 推理与安装包构建；手机实机、全新 Windows 和全部性能验收仍有未完成项目，详见 [验证记录](docs/VALIDATION.md)。

## 下载与使用

从 [GitHub Releases](https://github.com/siruijiang3/listen-local/releases) 下载 Windows x64 安装包。系统需要 WebView2；缺少时安装程序会下载补装。

1. 打开「设置与模型」，选择下载 CPU 或 NVIDIA GPU 运行包与模型。GPU 包自身支持 CPU 回退，无需同时安装两个包。
2. 导入 EPUB、UTF-8/GB18030 TXT、文本型 PDF，或粘贴正文。预览章节，可以修改或删除不需要的章节。
3. 选择 Serena（中文女声）、Uncle Fu（中文男声）或 Aiden（英文男声）。自动模式优先兼容的 NVIDIA GPU，初始化失败会显示原因并回退 CPU。
4. GPU 可以边生成边听。CPU 默认建议生成后播放，也可等待完整段落陆续播放。播放暂停不影响生成；任务单独暂停、恢复或取消。
5. 完成后导出带章节的 M4B/AAC 96 kbps，或分章 MP3 128 kbps / ZIP。点击「发送到手机」，在同一 Wi-Fi 扫码下载，导入手机现有播放器离线收听。

关闭窗口会收至托盘，继续生成。要完全退出，请使用托盘的「退出并保存任务」。下次启动后手动恢复未完成任务。模型完成任务后保留五分钟，也可在设置中立即释放。

手机只下载完整作品；不安装模型，不参与推理，不同步播放进度。分享期间电脑需开机；下载完成后电脑可以关机。局域网隔离或防火墙阻止访问时，可直接导出文件传输。

## 体积与硬件

软件、运行包和模型分开下载。首版 CPU 运行包约 430 MB，CUDA 运行包约 2.76 GB，模型约 2.50 GB，均为十进制下载体积，**不能把软件外壳大小当作总安装大小**。CUDA 包分成三个下载片段，由应用校验后合并。

| 设备 | 路径 | 状态 |
| --- | --- | --- |
| RTX 4060 Laptop 8 GB | CUDA / BF16 / CUDA Graphs，8 帧输出 | 本机三种声音已验证 |
| Intel i9-13900HX | CPU / FP32，多线程 | 三种声音已生成；明显慢于实时 |
| 其他支持 BF16 的 NVIDIA GPU | 自动检测，显存不足则显示错误 | 尚未逐卡实测 |
| AMD / Intel GPU | 首版使用 CPU | 不提供 GPU 后端 |
| Android / iPhone / iPad | 下载 M4B 或 MP3 后用现有播放器 | 实机兼容测试待完成 |

书库使用 SQLite 与普通音频文件，位置可选。更换书库目录是打开另一书库，不会自动搬移原文件。模型不常驻空闲进程；不使用 Electron、WebGPU、浏览器模型缓存、OCR、云服务或手机 App。

## 开发与开源

- [构建、打包与开发](docs/DEVELOPMENT.md)
- [架构、协议与持久化](docs/ARCHITECTURE.md)
- [实测记录与验收边界](docs/VALIDATION.md)
- [第三方来源与许可证](docs/THIRD_PARTY.md)

源码采用 **GPL-3.0-or-later**，第三方组件遵循各自许可证。模型从固定官方版本下载，权重不提交到仓库。Windows CI 检查 TypeScript、单元/集成测试和安装包构建，不替代真实 GPU 或手机测试。

`desktop/ui`、`desktop/backend`、`src-tauri` 是当前产品。旧浏览器实验保留于 `src`、研究文档和复现脚本中，不进入正式构建；旧 npm 依赖清单在 `research/`。请勿提交私人书籍、模型、生成音频、数据库、运行环境或凭证。
