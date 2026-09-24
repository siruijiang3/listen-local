/* Native WebView2 regression harness. Requires Playwright on NODE_PATH and a
 * validation app launched with a loopback CDP port. Uses a copied test library;
 * saves/restores the user's settings. No hooks are shipped in the application.
 * Usage: node scripts/check-reader-playback.cjs <cdp-url> <copied-library> <output-dir> [minutes]
 */
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const [cdp, library, output, minutesArg = '30'] = process.argv.slice(2);
if (!cdp || !library || !output) throw Error('CDP URL, isolated library and output directory required');
fs.mkdirSync(output, { recursive: true });
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { started: new Date().toISOString(), checks: [], samples: [], errors: [] };
const save = () => fs.writeFileSync(path.join(output, 'reader-playback.json'), JSON.stringify(report, null, 2));
async function run() {
  const browser = await chromium.connectOverCDP(cdp);
  const page = browser.contexts()[0].pages()[0];
  page.on('pageerror', error => { report.errors.push(String(error)); save(); });
  await page.addInitScript(() => {
    window.__readerTelemetry = { session: 0, progress: null, history: [] };
    const Native = window.AudioWorkletNode;
    window.AudioWorkletNode = class extends Native {
      constructor(...args) {
        super(...args);
        const telemetry = window.__readerTelemetry;
        const session = ++telemetry.session;
        telemetry.progress = null;
        this.port.addEventListener('message', ({ data }) => {
          if (session !== telemetry.session) return;
          if (data.type === 'progress') telemetry.progress = data;
          else if (data.type !== 'first') telemetry.history.push({ session, ...data });
        });
      }
    };
  });
  const api = async (action, body) => page.evaluate(async ({ action, body }) => {
    const c = await window.__TAURI_INTERNALS__.invoke('connection');
    const response = await fetch(`http://127.0.0.1:${c.port}/v1/${action}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw Error(await response.text());
    return response.json();
  }, { action, body });
  const original = (await api('state')).settings;
  fs.writeFileSync(path.join(output, 'original-settings.json'), JSON.stringify(original, null, 2));
  try {
    await api('settings', { ...original, library: path.resolve(library) });
    const state = await api('state');
    const job = state.jobs.find(j => j.samples / 24000 > 2400 && j.status === 'done');
    assert(job, 'An existing completed recording longer than 40 minutes is required');
    await api('played', { id: job.id, seconds: 0 });
    await page.reload();
    await page.getByRole('button', { name: /生成任务/ }).click();
    await page.locator('.job').filter({ has: page.getByRole('heading', { name: job.title, exact: true }) }).getByRole('button', { name: /^▶ 收听$/ }).click();
    const slider = page.getByRole('slider', { name: '播放位置' });
    await page.waitForFunction(() => Number(document.querySelector('input[type=range]')?.value) > 0.5);
    const value = async () => Number(await slider.inputValue());
    const current = async () => page.locator('.reader-segment.current').getAttribute('data-segment');
    const check = (name, detail) => { report.checks.push({ name, detail }); save(); console.log(name); };
    const index = await api(`reader?job=${job.id}`);
    await page.getByRole('button', { name: '暂停播放', exact: true }).click();
    // Keyboard seek retains pause, including repeated keydown before a single keyup.
    await slider.focus();
    await page.keyboard.down('ArrowRight'); await page.keyboard.down('ArrowRight'); await page.keyboard.up('ArrowRight');
    const pausedAt = await value(); await wait(1200);
    assert(Math.abs(await value() - pausedAt) < 0.02);
    assert(await page.getByRole('button', { name: '继续播放', exact: true }).isVisible());
    check('paused keyboard seek', { pausedAt });
    // Mouse pointer capture: hold while progress messages arrive; commit on release outside.
    const box = await slider.boundingBox();
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2);
    await page.mouse.down(); await page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2);
    const held = await value(); await wait(1200); assert.equal(await value(), held);
    await page.mouse.move(box.x + box.width * 0.35, box.y - 50); await page.mouse.up();
    await wait(400); assert(Math.abs(await value() - held) < 0.1);
    check('drag holds preview and commits outside slider', { held });
    // Clicking an actual text fragment restarts playback at that fragment.
    const target = page.locator('.reader-segment.ready').nth(2);
    const segment = index.segments[Number(await target.getAttribute('data-segment'))];
    await target.click();
    await page.waitForFunction(start => Number(document.querySelector('input[type=range]').value) > start, segment.sampleStart / 24000);
    assert(Math.abs(await value() - segment.sampleStart / 24000) < 3);
    assert.equal(await current(), String(segment.position));
    check('text to audio mapping', { segment: segment.position, start: segment.sampleStart / 24000 });
    // Free browsing does not stop playback, and the return button restores following.
    await page.locator('.reader-text').hover(); await page.mouse.wheel(0, 500);
    await page.getByRole('button', { name: '回到正在朗读', exact: true }).waitFor();
    const beforeBrowse = await value(); await wait(600); assert(await value() > beforeBrowse);
    await page.getByRole('button', { name: '回到正在朗读', exact: true }).click();
    check('manual browsing and return to narration', {});
    // While playing, a pointer cancellation must not commit the preview.
    const beforeCancel = await value();
    const movingBox = await slider.boundingBox();
    await page.mouse.move(movingBox.x + movingBox.width * 0.65, movingBox.y + movingBox.height / 2);
    await page.mouse.down();
    await page.keyboard.press('Escape'); await page.mouse.up(); await wait(400);
    assert(Math.abs(await value() - beforeCancel) < 3);
    check('cancel preview while playing', {});
    // A normal playing seek retains playback and wins over progress updates.
    await page.mouse.click(movingBox.x + movingBox.width * 0.12, movingBox.y + movingBox.height / 2);
    const playingAt = await value(); await wait(600); assert(await value() > playingAt);
    check('playing mouse seek', { playingAt });
    // Existing long chapters only mount a bounded text window.
    assert(await page.locator('.reader-segment').count() <= 60);
    await page.getByRole('button', { name: '下一部分', exact: true }).click();
    assert(await page.locator('.reader-segment').count() <= 60);
    await page.getByRole('button', { name: '回到正在朗读', exact: true }).click();
    check('bounded long chapter window', {});
    // Selecting source text must not start a new playback session.
    const selectionSession = await page.evaluate(() => window.__readerTelemetry.session);
    await page.locator('.reader-segment.ready').first().evaluate(element => {
      const range = document.createRange(); range.selectNodeContents(element);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      element.click();
    });
    assert.equal(await page.evaluate(() => window.__readerTelemetry.session), selectionSession);
    await page.evaluate(() => window.getSelection().removeAllRanges());
    check('text selection does not seek', {});
    await page.getByRole('button', { name: /我的书库/ }).click();
    const away = await value(); await wait(400); assert(await value() > away);
    await page.getByRole('button', { name: /阅读与收听/ }).click();
    check('playback continues away from reader', {});
    const openJob = async (title) => {
      await page.getByRole('button', { name: /生成任务/ }).click();
      await page.locator('.job').filter({ has: page.getByRole('heading', { name: title, exact: true }) }).getByRole('button', { name: /^▶/ }).click();
      await page.locator('.reader-heading h2').filter({ hasText: title }).waitFor();
    };
    const pending = state.jobs.find(j => j.title === 'Reader fixture - pending');
    const chapters = state.jobs.find(j => j.title === 'Reader fixture - chapters');
    if (pending && chapters) {
      await openJob(pending.title);
      await page.getByRole('navigation', { name: '章节目录' }).getByRole('button', { name: /Second chapter/ }).click();
      const pendingBefore = await page.evaluate(() => window.__readerTelemetry.session);
      await page.locator('.reader-segment.pending').first().click();
      await page.locator('.banner').filter({ hasText: '这部分尚未生成，当前播放不变。' }).waitFor();
      assert.equal(await page.evaluate(() => window.__readerTelemetry.session), pendingBefore);
      assert.equal((await api('state')).jobs.find(j => j.id === pending.id).status, 'paused');
      check('pending text leaves playback and generation unchanged', {});
      await page.locator('.banner').getByRole('button', { name: '关闭', exact: true }).click();
      await openJob(chapters.title);
      await slider.focus(); await page.keyboard.press('Home');
      for (let i = 0; i < 9; i++) await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('.reader-body h3')?.textContent === 'Second chapter');
      assert.equal(await current(), '1');
      check('audio seek crosses chapter and selects source', {});
      await page.getByRole('navigation', { name: '章节目录' }).getByRole('button', { name: /First chapter/ }).click();
      await page.locator('.reader-segment.ready').first().click();
      await wait(300); assert(await value() < 3);
      check('text click switches back across chapters', {});
      await page.locator('footer.player').getByRole('button', { name: '关闭', exact: true }).click();
      await openJob(chapters.title);
      assert(await value() < 4);
      check('close and reopen preserves position', {});
      await openJob(job.title);
    }
    // Exact end remains at end, then restart for a continuous long run.
    await slider.focus(); await page.keyboard.press('End'); await wait(500);
    assert(Math.abs(await value() - job.samples / 24000) < 0.02);
    assert.equal(await current(), String(index.segments.filter(s => s.sampleEnd > s.sampleStart).at(-1).position));
    await page.getByRole('button', { name: '继续播放', exact: true }).click();
    await page.waitForFunction(() => Number(document.querySelector('input[type=range]').value) > 0.5 && Number(document.querySelector('input[type=range]').value) < 5);
    check('exact ending and explicit replay', {});
    await page.screenshot({ path: path.join(output, 'native-reader.png') });
    const longStarted = Date.now();
    let lastPosition = 0;
    while (Date.now() - longStarted < Number(minutesArg) * 60000) {
      await wait(30000);
      if (fs.existsSync(path.join(output, 'STOP'))) throw Error('Validation stopped by operator; no continuous-playback pass recorded');
      const telemetry = await page.evaluate(() => window.__readerTelemetry);
      const position = await value();
      const sample = { wallSeconds: (Date.now() - longStarted) / 1000, position, segment: await current(), telemetry };
      report.samples.push(sample); save();
      assert(position > lastPosition, 'Playback must advance');
      assert.equal(telemetry.progress?.stalls, 0, 'No playback underruns');
      const expected = index.segments.find(s => s.sampleStart <= Math.floor(position * 24000) && s.sampleEnd > Math.floor(position * 24000));
      assert.equal(sample.segment, String(expected.position), 'Audio must highlight its source fragment');
      lastPosition = position;
      console.log(JSON.stringify({ wallSeconds: sample.wallSeconds, position, segment: sample.segment, stalls: telemetry.progress.stalls }));
    }
    report.continuousSeconds = lastPosition;
    assert.equal(report.errors.length, 0, 'No JavaScript errors');
    report.passed = true;
    await page.screenshot({ path: path.join(output, 'native-reader-finish.png') });
  } catch (error) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    // Stop playback and restore the pre-test library, even after an assertion fails.
    await page.locator('footer.player').getByRole('button', { name: '关闭', exact: true }).click().catch(() => {});
    await api('settings', original);
    await page.reload();
    save();
    await browser.close();
  }
}
run().catch(error => { report.errors.push(String(error.stack || error)); save(); console.error(error); process.exitCode = 1; });
