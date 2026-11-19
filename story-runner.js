const fs = require('node:fs');
const path = require('node:path');
const core = require('./core.js');
const states = new WeakMap();
const normalize = s => (s || '').replace(/\s+/g, ' ').trim();
const exact = s => new RegExp('^\\s*' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+') + '\\s*$');

async function snapshot(page) {
  return page.evaluate(() => {
    const text = s => (s || '').replace(/\s+/g, ' ').trim();
    const visible = e => { const r=e.getBoundingClientRect(),s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'; };
    const choices = [...document.querySelectorAll('li')].filter(visible)
      .filter(e => e.querySelector('[data-test="stories-choice"]'))
      .map(e => text(e.innerText));
    const tokens = [...document.querySelectorAll('button[data-test*="challenge-tap-token"]')].filter(visible)
      .map(e => ({ text:text(e.querySelector('[data-test="challenge-tap-token-text"]')?.textContent||e.innerText),disabled:e.disabled||e.getAttribute('aria-disabled')==='true' }));
    const buttons = [...document.querySelectorAll('button')].filter(visible)
      .map(e => ({text:text(e.innerText),test:e.dataset.test||'',disabled:e.disabled||e.getAttribute('aria-disabled')==='true'}));
    const next=document.querySelector('[data-test="stories-player-continue"]');
    return {text:document.body.innerText||'',choices,tokens,buttons,
      story:!!next&&visible(next),nextEnabled:!!next&&visible(next)&&!next.disabled,
      nextText:next?text(next.innerText):''};
  });
}

function optionsFor(e) {
  if(e.type==='MULTIPLE_CHOICE'||e.type==='SELECT_PHRASE')return (e.answers||[]).map(core.tx);
  if(e.type==='POINT_TO_PHRASE')return (e.transcriptParts||[]).filter(p=>p.selectable).map(p=>p.text);
  if(e.type==='ARRANGE')return e.selectablePhrases||[];
  if(e.type==='GAP_FILL')return (e.choices||[]).map(core.tx);
  if(e.type==='MATCH')return (e.matches||[]).flatMap(p=>[p.phrase,p.translation]);
  return [];
}

function matchQuestion(sess, dom, completed = new Set()) {
  const options = dom.choices.length ? dom.choices : dom.tokens.map(t=>t.text);
  if(!options.length)return null;
  const observed = core.multiset(options.map(normalize));
  const hits = (sess.elements||[]).map((q,index)=>({q,index})).filter(({q,index})=>
    !completed.has(index)&&core.sameMultiset(observed,core.multiset(optionsFor(q).map(normalize))));
  if(hits.length!==1)return null;
  return hits[0];
}

async function enabledNext(page) {
  await page.waitForFunction(() => {
    const e=document.querySelector('[data-test="stories-player-continue"]');
    return !!e&&!e.disabled;
  },null,{timeout:6000});
}

async function saveFailure(page, state, error) {
  const key=error.message;
  if(state.failure===key)return;
  state.failure=key;
  const dir=path.join(__dirname,'story-debug','failure-'+Date.now());
  fs.mkdirSync(dir,{recursive:true});
  await fs.promises.writeFile(path.join(dir,'page.html'),await page.content());
  await page.screenshot({path:path.join(dir,'page.png'),fullPage:true});
  fs.writeFileSync(path.join(dir,'state.json'),JSON.stringify({error:key,completed:[...state.completed],dom:await snapshot(page)},null,2));
  console.log('STORY_BLOCKED '+key+' evidence='+dir);
}

async function chooseToken(page, text, check) {
  const buttons = page.locator('button[data-test*="challenge-tap-token"]:visible:not([disabled]):not([aria-disabled="true"])');
  const label = page.locator('[data-test="challenge-tap-token-text"]').filter({hasText:exact(normalize(text))});
  let token = buttons.filter({has:label});
  if(!await token.count())token=buttons.filter({hasText:exact(normalize(text))});
  if(await token.count()!==1)throw new Error('Expected one active story token: '+text);
  await check();
  await token.click({timeout:3000});
}

async function answer(page, question, check = async () => {}) {
  const {q}=question;
  const plan=core.storiesPlan(q);
  if(!plan.length)throw new Error('No story plan for '+q.type);
  if(q.type==='MULTIPLE_CHOICE'||q.type==='SELECT_PHRASE') {
    // stories-choice has no text. The answer label is a sibling inside this li.
    const row=page.locator('li:visible').filter({hasText:exact(normalize(plan[0].text))});
    if(await row.count()!==1)throw new Error('Expected one story answer row: '+plan[0].text);
    await check();
    await row.locator('[data-test="stories-choice"]').click({timeout:3000});
  } else if(q.type==='MATCH') {
    for(const pair of q.matches||[]) {
      await chooseToken(page,pair.phrase,check);
      await chooseToken(page,pair.translation,check);
      await page.waitForFunction(({a,b}) => {
        const norm=s=>(s||'').replace(/\s+/g,' ').trim();
        const active=[...document.querySelectorAll('button[data-test*="challenge-tap-token"]')].filter(e=>{
          const r=e.getBoundingClientRect();
          const t=norm(e.querySelector('[data-test="challenge-tap-token-text"]')?.textContent||e.innerText);
          return (t===a||t===b)&&r.width>0&&r.height>0&&!e.disabled&&e.getAttribute('aria-disabled')!=='true';
        });
        return active.length===0;
      },{a:normalize(pair.phrase),b:normalize(pair.translation)},{timeout:5000});
      console.log('STORY_PAIR_VERIFIED '+JSON.stringify([pair.phrase,pair.translation]));
    }
  } else {
    for(const p of plan)await chooseToken(page,p.text,check);
  }
  await enabledNext(page);
  return plan;
}

async function step(page,sess,check = async () => {}) {
  let state=states.get(page);
  if(!state||state.session!==sess){state={session:sess,completed:new Set(),failure:'',done:false};states.set(page,state);}
  if(state.done)return {status:'done'};
  const dom=await snapshot(page);
  if(!dom.story)return {status:'outside'};
  const last=(sess.elements||[]).map((q,index)=>({q,index})).filter(x=>optionsFor(x.q).length).at(-1);
  if(last&&state.completed.has(last.index)) {
    state.done=true;
    console.log('STORY_DONE  (全部故事题已完成，最后结束课程由你点)');
    return {status:'done'};
  }
  if(dom.nextEnabled) {
    await check();
    await page.locator('[data-test="stories-player-continue"]').click({timeout:3000});
    console.log('STORY_NEXT_VERIFIED');
    return {status:'next'};
  }
  const question=matchQuestion(sess,dom,state.completed);
  if(!question)return {status:'waiting'};
  if(state.failure)return {status:'blocked',error:state.failure};
  try {
    const plan=await answer(page,question,check);
    state.completed.add(question.index);
    console.log('STORY_VERIFIED '+question.q.type+' line='+question.q.lineIndex+' '+JSON.stringify(plan.map(p=>p.text)));
    return {status:'answered',type:question.q.type,index:question.index,plan};
  } catch(error) {
    await saveFailure(page,state,error);
    return {status:'blocked',error:error.message};
  }
}

function resetDone(page){const s=states.get(page);if(s)s.done=false;}

module.exports={step,snapshot,matchQuestion,optionsFor,answer,resetDone};
