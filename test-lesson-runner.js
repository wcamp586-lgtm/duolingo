const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { step } = require('./lesson-runner.js');

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    for (const type of ['speak', 'listenTap']) {
      await page.setContent(`
        <div data-test="challenge challenge-${type}">原题仍显示</div>
        <button data-test="player-skip"
          onclick="this.remove(); document.querySelector('#feedback').hidden = false">
          暂时跳过
        </button>
        <div id="feedback" hidden>
          <button data-test="player-next"
            onclick="document.querySelector('[data-test^=challenge]').remove(); this.remove()">
            继续
          </button>
        </div>
      `);
      const result = await step(page, {});
      assert.deepEqual(result, { status: 'skipped', type });
      assert.equal(await page.locator('[data-test^="challenge"]').count(), 0);
      console.log('  ✓ ' + type + ' advances through the skip feedback');
    }
    await page.setContent(`
      <div data-test="challenge challenge-readComprehension">提交后的旧题仍在页面上</div>
      <button data-test="player-next" aria-busy="true" disabled>...</button>
    `);
    assert.deepEqual(await step(page, {}), { status: 'waiting' });
    await page.locator('[data-test="player-next"]').evaluate(button => {
      button.removeAttribute('aria-busy');
      button.disabled = false;
      button.textContent = '继续';
      button.onclick = () => document.querySelector('[data-test^="challenge"]').remove();
    });
    const advanced = await step(page, {});
    assert.equal(advanced.status, 'answered', '继续点掉后进入下一屏算进展');
    assert.equal(advanced.evidence, 'left');
    assert.equal(await page.locator('[data-test^="challenge"]').count(), 0);
    console.log('  ✓ waits for settlement feedback without answering the old question again');

    await page.setContent(`
      <div data-test="challenge challenge-select">
        <p>哪个是“茶”？</p>
        <button onclick="this.dataset.clicked='1'">Tee</button>
        <button onclick="this.dataset.clicked='1'">Kaffee</button>
        <button onclick="this.dataset.clicked='1'">Zucker</button>
      </div>
      <button data-test="player-next"
        onclick="document.querySelector('[data-test^=challenge]').insertAdjacentHTML('beforeend','<p>下一题</p>')">检查</button>
    `);
    const select = await step(page, {
      challenges: [{ id: 'sel1', type: 'select', prompt: '哪个是“茶”？', correctIndex: 0,
        choices: [{ phrase: 'Tee' }, { phrase: 'Kaffee' }, { phrase: 'Zucker' }] }],
    });
    assert.equal(select.status, 'answered');
    assert.equal(select.evidence, 'changed', '提交后换题才算作答进展');
    assert.equal(select.type, 'select');
    assert.equal(select.n, 1);
    assert.equal(await page.locator('button[data-clicked="1"]').innerText(), 'Tee');
    console.log('  ✓ select clicks the {phrase} choice');

    await page.setContent(`
      <div data-test="challenge challenge-match">
        <button data-test="咖啡-challenge-tap-token" onclick="this.dataset.clicked='1'"><span data-test="challenge-tap-token-text">咖啡</span></button>
        <button data-test="请-challenge-tap-token" onclick="this.dataset.clicked='1'"><span data-test="challenge-tap-token-text">请</span></button>
        <button data-test="Kaffee-challenge-tap-token" onclick="this.dataset.clicked='1'"><span data-test="challenge-tap-token-text">Kaffee</span></button>
        <button data-test="bitte-challenge-tap-token" onclick="this.dataset.clicked='1'"><span data-test="challenge-tap-token-text">bitte</span></button>
      </div>
      <button data-test="player-next"
        onclick="document.querySelector('[data-test^=challenge]').insertAdjacentHTML('beforeend','<p>下一题</p>')">检查</button>
    `);
    const match = await step(page, {
      challenges: [{ id: 'm1', type: 'match', pairs: [
        { learningToken: '咖啡', fromToken: 'Kaffee' }, { learningToken: '请', fromToken: 'bitte' },
      ] }],
    });
    assert.equal(match.status, 'answered');
    assert.equal(match.evidence, 'changed');
    assert.equal(match.type, 'match');
    assert.equal(match.n, 4);
    assert.equal(await page.locator('button[data-clicked="1"]').count(), 4);
    console.log('  ✓ match clicks both tokens of every pair');

    await page.setContent(`
      <div data-test="challenge challenge-translate">
        <p>用英语写出这句话 这座图书馆非常旧。</p>
        <textarea></textarea>
      </div>
      <button data-test="player-next"
        onclick="document.querySelector('[data-test^=challenge]').insertAdjacentHTML('beforeend','<p>下一题</p>')">检查</button>
    `);
    const fill = await step(page, {
      challenges: [{ id: 't1', type: 'translate', prompt: '这座图书馆非常旧。',
        correctSolutions: ['this library is very old'] }],
    });
    assert.equal(fill.status, 'answered');
    assert.equal(fill.evidence, 'changed');
    assert.equal(fill.type, 'translate');
    assert.equal(await page.locator('textarea').inputValue(), 'this library is very old');
    console.log('  ✓ fill types correctSolutions into the input');

    // 回归（2026-11-20 s2u42l7）：同一 name 题、检查按钮无反应 → 必须 nochange，不能算 answered
    await page.setContent(`
      <div data-test="challenge challenge-name">
        <p>用英语写出这个名字 安娜。</p>
        <input type="text" />
      </div>
      <button data-test="player-next">检查</button>
    `);
    const stuck = await step(page, {
      challenges: [{ id: 'n1', type: 'name', prompt: '用英语写出这个名字 安娜。', correctSolutions: ['Anna'] }],
    });
    assert.equal(stuck.status, 'nochange');
    assert.equal(stuck.footerLabel, '检查');
    assert.ok(stuck.click && stuck.click.clicked === 1, '点过一次检查');
    console.log('  ✓ same name question with no feedback is nochange (not answered)');

    // 反馈延迟到达：第一步 nochange/等，第二步看到「继续」才算推进
    await page.setContent(`
      <div data-test="challenge challenge-name">
        <p>用英语写出这个名字 安娜。</p>
        <input type="text" />
      </div>
      <button data-test="player-next"
        onclick="const b=this; setTimeout(()=>{b.textContent='继续'; b.onclick=()=>{document.querySelector('[data-test^=challenge]').remove(); b.remove();};}, 1200)">检查</button>
    `);
    const firstStep = await step(page, {
      challenges: [{ id: 'n2', type: 'name', prompt: '用英语写出这个名字 安娜。', correctSolutions: ['Anna'] }],
    });
    assert.equal(firstStep.status, 'nochange', '反馈还没到时不能算作答成功');
    await page.waitForTimeout(1500);
    const secondStep = await step(page, {
      challenges: [{ id: 'n2', type: 'name', prompt: '用英语写出这个名字 安娜。', correctSolutions: ['Anna'] }],
    });
    assert.equal(secondStep.status, 'answered', '反馈到了就走正常继续');
    assert.ok(['left', 'feedback', 'changed'].includes(secondStep.evidence), '继续后要有真实变化证据');
    console.log('  ✓ delayed feedback resolves on the next tick via 继续');
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
