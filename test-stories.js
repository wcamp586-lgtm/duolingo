// Browser regressions for stories. Offline HTML only, no persistent profile.
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const core = require('./core.js');
const story = require('./story-runner.js');
const sample = require('./stories-session.json');
let passed=0;
async function test(name, fn) { await fn(); passed++; console.log('  ✓ '+name); }

(async()=>{
  await test('SELECT_PHRASE accepts string answers',()=>{
    // stories-session.json 会被运行时覆盖成别的故事，缺题型时用内置样本，保证测试不随运行数据漂移
    const q=sample.elements.find(e=>e.type==='SELECT_PHRASE')
      || {type:'SELECT_PHRASE',answers:['what to do','go home','sit down'],correctAnswerIndex:0};
    assert.deepEqual(core.storiesPlan(q),[{text:q.answers[q.correctAnswerIndex],order:0}]);
  });
  await test('MATCH preserves the actual phrase and translation pairs',()=>{
    const q=sample.elements.find(e=>e.type==='MATCH')
      || {type:'MATCH',matches:[{phrase:'Hey',translation:'嘿'},{phrase:'eggs',translation:'蛋'}]};
    assert.deepEqual(core.storiesPlan(q).map(p=>p.text),q.matches.flatMap(p=>[p.phrase,p.translation]));
  });
  await test('POINT_TO_PHRASE indices refer only to selectable parts',()=>{
    const q={type:'POINT_TO_PHRASE',correctAnswerIndex:1,transcriptParts:[{text:'(',selectable:false},{text:'too',selectable:true},{text:',',selectable:false},{text:'nervous',selectable:true}]};
    assert.equal(core.storiesPlan(q)[0].text,'nervous');
  });
  await test('active options select the current question, independently of answer order',()=>{
    const q=sample.elements.find(e=>e.type==='MULTIPLE_CHOICE');
    const dom={choices:q.answers.map(a=>a.text).reverse(),tokens:[]};
    assert.equal(story.matchQuestion(sample,dom).q,q);
    assert.equal(story.matchQuestion(sample,{choices:['unknown'],tokens:[]}),null);
  });
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();
    await page.route('**/*',route=>route.abort());
    await test('clicks the empty stories-choice button beside the correct label, not hidden duplicates',async()=>{
      const q={type:'MULTIPLE_CHOICE',answers:[{text:'wrong'},{text:'right'}],correctAnswerIndex:1};
      await page.setContent('<div style="display:none"><li>right<button data-test="stories-choice"></button></li></div><ul><li><button data-test="stories-choice" onclick="window.wrong=true"></button>wrong</li><li><button data-test="stories-choice" onclick="document.querySelector(\'[data-test=stories-player-continue]\').disabled=false"></button><div>right</div></li></ul><button data-test="stories-player-continue" disabled>继续</button>');
      await story.answer(page,{q,index:0});
      assert.equal(await page.locator('[data-test="stories-player-continue"]').isEnabled(),true);
      assert.equal(await page.evaluate(()=>!!window.wrong),false);
    });
    await test('sorting reads the text label when data-test contains words after challenge-tap-token',async()=>{
      const q={type:'ARRANGE',selectablePhrases:['have','You','the same shoes'],phraseOrder:[1,0,2]};
      await page.setContent('<div id="tokens"></div><button data-test="stories-player-continue" disabled>继续</button>');
      await page.evaluate(()=>{
        window.answer=[];
        for(const [i,text] of ['the same shoes','have','You'].entries()){
          const button=document.createElement('button');
          button.dataset.test=i===0?'same shoes-challenge-tap-token the':text+'-challenge-tap-token';
          const label=document.createElement('span');label.dataset.test='challenge-tap-token-text';label.textContent=text;
          button.appendChild(label);button.onclick=()=>{window.answer.push(text);button.disabled=true;if(window.answer.length===3)document.querySelector('[data-test="stories-player-continue"]').disabled=false;};
          document.querySelector('#tokens').appendChild(button);
        }
      });
      assert.equal(story.matchQuestion({elements:[q]},await story.snapshot(page)).q,q);
      await story.answer(page,{q,index:0});
      assert.deepEqual(await page.evaluate(()=>window.answer),['You','have','the same shoes']);
    });
    await test('numbered match tokens pair correctly and final Continue stays manual',async()=>{
      const q={type:'MATCH',lineIndex:22,matches:[{phrase:'now',translation:'现在'},{phrase:'Yes',translation:'是啊'}]};
      await page.setContent('<div id="tokens"></div><button data-test="stories-player-continue" disabled onclick="window.finalClicked=true">继续</button>');
      await page.evaluate(()=>{
        window.answer=[];let first=null;
        const links={now:'现在','现在':'now',Yes:'是啊','是啊':'Yes'};
        for(const [i,text] of ['现在','是啊','Yes','now'].entries()){
          const button=document.createElement('button');button.dataset.test=text+'-challenge-tap-token';
          const number=document.createElement('span');number.textContent=i+1;
          const label=document.createElement('span');label.dataset.test='challenge-tap-token-text';label.textContent=text;
          button.append(number,label);button.onclick=()=>{
            window.answer.push(text);
            if(!first){first={text,button};return;}
            if(links[first.text]===text){first.button.disabled=true;button.disabled=true;}
            first=null;
            if([...document.querySelectorAll('#tokens button')].every(b=>b.disabled))document.querySelector('[data-test="stories-player-continue"]').disabled=false;
          };
          document.querySelector('#tokens').appendChild(button);
        }
      });
      const sess={elements:[q]};
      assert.equal((await story.step(page,sess)).status,'answered');
      assert.equal((await story.step(page,sess)).status,'done');
      assert.equal((await story.step(page,sess)).status,'done');
      assert.deepEqual(await page.evaluate(()=>window.answer),['now','现在','Yes','是啊']);
      assert.equal(await page.evaluate(()=>!!window.finalClicked),false);
    });
  } finally { await browser.close(); }
  console.log(`结果: ${passed} 通过, 0 失败`);
})().catch(error=>{console.error(error);process.exitCode=1;});
