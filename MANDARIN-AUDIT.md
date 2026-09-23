# 普通话审核修正

2026-09-22。用户拒绝晓北、晓妮的地方口音；这两款声音已移出可选列表，Worker 同时拒绝调用，历史录音保留。此前将语言分类直接当成普通话口音合格是不成立的。

## 已核实的来源边界

- [Kokoro v1.0 官方声音表](https://huggingface.co/hexgrad/Kokoro-82M/blob/main/VOICES.md)把中文声音统一归在 Mandarin Chinese 下，没有逐声音的标准普通话保证。
- [微软官方语言支持表](https://learn.microsoft.com/zh-cn/azure/ai-services/speech-service/language-support?tabs=custom-keyword)中，同名 Xiaobei 对应辽宁/东北口音，Xiaoni 对应陕西口音，四川声音为 Yunxi。**同名不能证明 Kokoro 训练来源，也不能单靠目录鉴别本页合成音频的具体方言。**这不影响按用户反馈否决两个声音。
- [Kokoro v1.1-zh 官方模型卡](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh)说明新增 100 个中文声音；[官方生成样音脚本](https://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh/blob/01e7505bd6a7a2ac4975463114c3a7650a9f7218/samples/make_zh.py)使用 zf_001、zm_010。页面链接到该固定提交的原始 WAV。脚本包含动态速度和补静音，不能拿它直接比较本页耗时或时长。

## 代码修复

中文默认只有 v1.1-zh / 001；010 及 v1.0 晓晓、云扬是待审备选，Huayan 也不再标为已核实普通话。没有增加模型家族、调用付费服务或云端推理。

v1.0 原先按词计算拼音，导致上下文丢失且关闭了变调。现改为按完整汉字句段计算再分词，修复测试中的助词“了”和“一/不”变调。两个浏览器适配共用“行长”“时候”词典修正；v1.1 的叠词规则不再把“轻轻”变为轻声。本地补丁可通过 `scripts/vendor-frontends.mjs` 重现。

前端版本标记变为 `mandarin-fix-2`；试听卡不再把旧前端的缓存结果展示为新结果。旧音频仍保留在历史中，带原始前端版本，不能视为已修复的录音。

## 回归方法与局限

开发时用官方 Python 包 Misaki 0.9.4 生成 10 条原文的参考音素，保存于 `src/fixtures/mandarin-reference.json`；依赖版本也在文件中。复现方法（仅开发用，网站不依赖 Python）：

```sh
python -m pip install "misaki[zh]==0.9.4" "pypinyin==0.55.0" "jieba==0.42.1" "cn2an==0.5.24" "pypinyin-dict==0.9.0"
python scripts/reference-mandarin.py
npm test
```

测试比较 v1.1 的音节和声调，忽略分词分隔符及空格。Intl.Segmenter 和 jieba 的分词仍有差别，会影响韵律；**通过这 10 条测试不代表完整前端等价，更不代表普通话口音或自然度通过。**v1.0 的变调策略也与 Misaki legacy 的部分输出有差异，只测试明确的修复项，不宣称其参考等价。

最终仍需分别听官方参考与本页同一音色的实际生成，并按原文检查口音、错读和韵律。评分新增“地方口音不接受”。尚未获得用户对新声音的通过意见。
