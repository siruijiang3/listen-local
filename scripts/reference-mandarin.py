import json
from importlib.metadata import version
from misaki.zh import ZHG2P
texts = [
'雨停的时候，天还没有完全亮。',
'林安推开书店的木门，闻到纸张和潮湿木头混在一起的气味。',
'窗边那把椅子空着，桌上却多了一封信。',
'他没有立刻拆开，只是把信轻轻放进口袋，像是把一个尚未发生的故事，暂时留给了明天。',
'四十不是十四，事实需要仔细核实。',
'南方的蓝天很明亮，老师正在认真讲课。',
'你好，请问图书馆什么时候开门？',
'一把雨伞，一年一次，不是所有的故事都一样。',
'重庆银行的行长重新读了一遍这份报告。',
'今天是2026年9月22日，气温23摄氏度。'
]
frontends = {'v1':ZHG2P(), 'v11':ZHG2P(version='1.1')}
result={'generator':'scripts/reference-mandarin.py','packages':{p:version(p) for p in ['misaki','pypinyin','jieba','cn2an','pypinyin-dict']},'cases':[]}
for text in texts:
  result['cases'].append({'text':text,**{key:g2p(text)[0] for key,g2p in frontends.items()}})
with open('src/fixtures/mandarin-reference.json','w',encoding='utf-8') as f: json.dump(result,f,ensure_ascii=False,indent=2)
print('Reference fixtures:',len(texts),result['packages'])
