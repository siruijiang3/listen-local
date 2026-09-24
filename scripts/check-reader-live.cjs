/* Functional browser check against the real packaged core and real CUDA model.
 * Start `npm run dev` first; install Playwright separately on NODE_PATH.
 * node scripts/check-reader-live.cjs <core> <isolated-home> <runtime-python> <model>
 * Native uninterrupted playback is measured by check-reader-playback.cjs.
 */
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const [core, homeArg, runtime, model] = process.argv.slice(2);
const home = path.resolve(homeArg);
fs.mkdirSync(home, { recursive: true });
const result = { passed: false, checks: [] };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function run() {
  const log = fs.openSync(path.join(home, 'core.log'), 'w');
  const child = spawn(path.resolve(core), ['--home', home], { windowsHide: true, stdio: ['ignore', 'pipe', log] });
  const connection = await new Promise((resolve, reject) => {
    let text = '';
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('\n')) resolve(JSON.parse(text.split('\n')[0])); });
    child.on('error', reject); child.on('exit', code => reject(Error(`Core exited before connection: ${code}`)));
  });
  const base = `http://127.0.0.1:${connection.port}/v1/`;
  const api = async (action, body) => {
    const response = await fetch(base + action, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert(response.ok, await response.clone().text()); return response.json();
  };
  let browser;
  try {
    await api('settings', { runtimePython: path.resolve(runtime), model: path.resolve(model) });
    const paragraphs = [
      '清晨，林岚沿着河岸走向图书馆。她经过一座石桥，看见桥下的水面映着天空。街角的早餐店刚刚开门，蒸笼里冒出白色的热气。她停下来买了一杯豆浆，然后继续向前走。',
      '图书馆二楼很安静。她找到靠窗的位置，打开昨天借来的那本书。书页里夹着一张旧车票，背面写着一个陌生的地名。她把车票放在桌上，准备读完这一章再仔细看看。',
      '午后的雨来得很突然。她收好笔记，站在门口等雨变小。一个孩子撑着蓝色雨伞跑过台阶，把手里的信交给门卫。风吹动门边的树叶，她忽然想起了很久没有联系的朋友。',
      '傍晚回到家，窗台上的花已经开了。她给朋友写了一封短信，说起今天的石桥、车票和那场雨。厨房里传来水烧开的声音，她放下手机，起身泡了一杯热茶。',
    ];
    const book = await api('save_book', { title: 'Live reader validation', chapters: [{ title: '四个自然段', text: paragraphs.join('\n\n') }] });
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
    const errors = []; page.on('pageerror', e => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:1420/?port=${connection.port}&token=${connection.token}`);
    await page.getByRole('button', { name: /Live reader validation/ }).click();
    await page.getByRole('button', { name: '开始生成', exact: true }).click();
    const slider = page.getByRole('slider', { name: '播放位置' });
    await slider.waitFor({ timeout: 120000 });
    await page.locator('.reader-segment.pending').last().click();
    await page.locator('.banner').filter({ hasText: '这部分尚未生成' }).waitFor();
    result.checks.push('Pending text does not interrupt live playback');
    const row = (await api('state')).jobs.find(j => j.book_id === book.id);
    assert.equal(row.mode, 'live');
    const box = await slider.boundingBox();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2); await page.mouse.down();
    const max = await slider.getAttribute('max'); const preview = await slider.inputValue();
    await wait(1400);
    assert.equal(await slider.getAttribute('max'), max);
    assert.equal(await slider.inputValue(), preview);
    await page.mouse.up();
    result.checks.push('Growing audio does not change an active drag range or preview');
    await page.getByRole('button', { name: '暂停播放', exact: true }).click();
    const before = (await api('state')).jobs.find(j => j.id === row.id);
    const position = Number(await slider.inputValue());
    await wait(2000);
    const after = (await api('state')).jobs.find(j => j.id === row.id);
    assert(after.samples > before.samples, 'Synthesis continues while playback is paused');
    assert(Math.abs(Number(await slider.inputValue()) - position) < 0.15);
    result.checks.push('Pausing playback preserves its position while synthesis continues');
    const deadline = Date.now() + 180000;
    let completed;
    do {
      completed = (await api('state')).jobs.find(j => j.id === row.id);
      assert.notEqual(completed.status, 'failed', completed.error);
      if (completed.status === 'done') break;
      await wait(700);
    } while (Date.now() < deadline);
    assert.equal(completed.status, 'done');
    const index = await api(`reader?job=${row.id}`);
    assert.equal(index.segments.length, 4);
    await page.waitForFunction(() => document.querySelectorAll('.reader-segment.pending').length === 0);
    for (const segment of index.segments) {
      await page.locator(`[data-segment="${segment.position}"]`).click();
      await wait(300);
      assert(Math.abs(Number(await slider.inputValue()) - segment.sampleStart / 24000) < 2);
      assert.equal(await page.locator('.reader-segment.current').getAttribute('data-segment'), String(segment.position));
      assert(!(await page.locator('.reader-range').innerText()).includes('跨'));
    }
    result.checks.push('All newly completed natural paragraphs become clickable with matching audio starts');
    await page.screenshot({ path: path.join(home, 'live-reader.png') });
    result.audioSeconds = completed.samples / 24000;
    result.generationSeconds = completed.generation_seconds;
    result.device = completed.actual_device;
    result.errors = errors;
    assert.equal(errors.length, 0);
    result.passed = true;
  } finally {
    if (browser) await browser.close();
    await api('shutdown', {});
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    fs.closeSync(log);
    fs.writeFileSync(path.join(home, 'result.json'), JSON.stringify(result, null, 2));
  }
}
run().then(() => console.log(JSON.stringify(result, null, 2))).catch(error => { console.error(error); process.exitCode = 1; });
