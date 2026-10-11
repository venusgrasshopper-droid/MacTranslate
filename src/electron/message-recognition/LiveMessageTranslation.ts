import type { Input, WebContents } from 'electron';
import {
  type GoogleSentence,
  googleTranslateWithAlternatives,
  type TranslationResult,
  translateWithGoogle,
} from '../../helpers/google-translate';

// Live translation for chat webviews: incoming messages get a translation box
// under the bubble, and the composer text is translated before it is sent.

interface ScannedMessage {
  key?: string;
  text?: string;
  hasTranslation?: boolean;
}

interface ComposerState {
  text?: string;
  direction?: string;
  isComposing?: boolean;
  translationReady?: boolean;
  pendingSend?: boolean;
}

interface ComposerApplyResult {
  send?: 'click' | 'enter' | false;
  outgoing?: string;
  x?: number;
  y?: number;
}

type ComposerSentence = GoogleSentence & {
  choices: Array<{ text: string; meaning: string }>;
};

type ComposerTranslation = TranslationResult & {
  engine?: string;
  sentences?: ComposerSentence[];
};

interface LiveTarget {
  contents: WebContents;
  messageTimer: NodeJS.Timeout | null;
  composerTimer: NodeJS.Timeout | null;
  messageBusy: boolean;
  composerBusy: boolean;
  composerQueued: boolean;
  composerKickTimer: NodeJS.Timeout | null;
  inputListener: ((event: Electron.Event, input: Input) => void) | null;
  cache: Map<string, TranslationResult>;
  failedUntil: Map<string, number>;
  composerText: string;
  composerTextAt: number;
}

const liveTargets = new Map<number, LiveTarget>();
const globalTranslations = new Map<string, TranslationResult>();
const GLOBAL_TRANSLATION_LIMIT = 4000;
const SCAN_LIMIT = 40;
const BATCH_LIMIT = 12;
const MESSAGE_POLL_MS = 650;
const COMPOSER_POLL_MS = 16;
const COMPOSER_KICK_DELAY_MS = 0;
// Wait until typing pauses before asking Google, so it is not hit per keystroke.
const COMPOSER_SETTLE_MS = 500;

const translatableText = (value: string): boolean => {
  const text = value.trim();
  if (!text || text.length > 20_000) return false;
  return /[A-Za-z\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(text);
};

const rememberGlobal = (text: string, result: TranslationResult) => {
  globalTranslations.delete(text);
  globalTranslations.set(text, result);
  if (globalTranslations.size <= GLOBAL_TRANSLATION_LIMIT) return;
  const oldest = globalTranslations.keys().next().value;
  if (oldest) globalTranslations.delete(oldest);
};

const scanScript = (service: string) => String.raw`
(() => {
  const service=${JSON.stringify(service)};
  const LIMIT=${SCAN_LIMIT};
  if(document.visibilityState==='hidden')return [];
  const clean=value=>String(value??'')
    .replace(/\u200b/g,'')
    .replace(/\u00a0/g,' ')
    .replace(/\r\n?/g,'\n')
    .replace(/\n{3,}/g,'\n\n')
    .trim();
  const visible=node=>{
    if(!node?.isConnected)return false;
    const rect=node.getBoundingClientRect?.();
    return Boolean(rect&&rect.width>0&&rect.height>0&&rect.bottom>=0&&rect.top<=innerHeight);
  };
  const textFrom=(source,removeSelectors=[])=>{
    if(!source)return '';
    const clone=source.cloneNode(true);
    for(const selector of ['.mactranslate-live-translation',...removeSelectors]){
      for(const node of clone.querySelectorAll?.(selector)||[])node.remove();
    }
    for(const image of clone.querySelectorAll?.('img[alt]')||[])image.replaceWith(document.createTextNode(image.getAttribute('alt')||''));
    for(const br of clone.querySelectorAll?.('br')||[])br.replaceWith(document.createTextNode('\n'));
    return clean(clone.innerText||clone.textContent);
  };
  const result=[];
  const push=(row,key,text,direction)=>{
    if(!row||!visible(row)||!text||!key)return;
    result.push({
      key:clean(key).slice(0,4096),
      text:clean(text).slice(0,20000),
      direction:direction==='outgoing'?'outgoing':'incoming',
      hasTranslation:[...(row.querySelectorAll?.('.mactranslate-live-translation')||[])].some(box=>box.dataset.mactranslateSource===clean(text).slice(0,20000)),
    });
  };

  if(service==='telegram'){
    const rows=[...document.querySelectorAll('.Message.message-list-item[data-message-id]')].filter(visible).slice(-LIMIT);
    for(const row of rows){
      const source=row.querySelector('.text-content')||row.querySelector('.message-content-wrapper');
      const text=textFrom(source,['.MessageMeta','.message-time','.message-signature','.message-replies-wrapper','.message-action-buttons-container','.message-action-buttons','.Reactions','.message-select-control','.InlineButtons','.inline-buttons','button']);
      const id=clean(row.getAttribute('data-message-id')||row.dataset?.messageId);
      push(row,'id:'+id,text,row.classList.contains('own')?'outgoing':'incoming');
    }
  } else if(service==='signal'){
    const rows=[...document.querySelectorAll('[data-message-id][role="listitem"]')].filter(visible).slice(-LIMIT);
    for(const row of rows){
      const message=row.querySelector('.module-message');
      const source=message?.querySelector('.module-message__text');
      const text=textFrom(source,['.module-message__metadata','[class*="module-message__metadata"]','button','[role="button"]']);
      const id=clean(row.getAttribute('data-message-id'));
      push(row,'id:'+id,text,message?.classList.contains('module-message--outgoing')?'outgoing':'incoming');
    }
  } else if(service==='teams'){
    const selector=['[data-tid="chat-pane-message"]','[data-tid="message-list-item"]','[data-tid="message-group-container"]','div[role="listitem"]','div[data-tid^="message-"]','div[data-mid]'].join(',');
    const sourceSelectors=['[id^="message-body-"] [id^="content-"]','[id^="content-"]','[data-tid="message-content"]','[data-tid="message-body"]','[data-tid="bubble-text"]','[data-tid^="message-content-"]','[data-tid^="messageBody"]','[role="document"]','.ts-message-content','.message-body','.ui-chat__messagecontent'];
    const rows=[...document.querySelectorAll(selector)].filter(visible).slice(-LIMIT);
    for(const row of rows){
      let source=null;
      for(const sourceSelector of sourceSelectors){source=row.querySelector(sourceSelector);if(source)break;}
      const text=textFrom(source,['button','[role="button"]','[data-tid*="reaction" i]','[data-tid*="timestamp" i]','time']);
      const mid=clean(row.getAttribute('data-mid'));
      const idNode=row.querySelector('[id^="message-body-"],[id^="content-"],[id^="timestamp-"],[id^="author-"]');
      const raw=clean(mid||idNode?.id||row.id||'');
      const id=clean(raw.replace(/^(?:message-body-|content-|timestamp-|author-)/,''));
      push(row,'id:'+(id||text.slice(0,200)),text,row.matches('[data-is-self="true"],.own')||Boolean(row.querySelector('[data-is-self="true"]'))?'outgoing':'incoming');
    }
  } else if(service==='whatsapp'){
    const nodes=[...document.querySelectorAll('[data-pre-plain-text]')].filter(visible).slice(-LIMIT);
    for(const node of nodes){
      const row=node.closest('[data-id],[role="row"],.message-in,.message-out')||node;
      const source=node.querySelector('.selectable-text.copyable-text')||node.querySelector('.selectable-text')||node;
      const text=textFrom(source,['.mactranslate-live-translation','button','[role="button"]','[data-testid="msg-meta"]']);
      const dataId=clean(row.getAttribute?.('data-id'));
      const pre=clean(node.getAttribute('data-pre-plain-text'));
      const direction=row.classList?.contains('message-out')||Boolean(row.querySelector?.('.message-out'))?'outgoing':'incoming';
      push(row,dataId?'id:'+dataId:'wa:'+pre+'\u001f'+text.slice(0,300),text,direction);
    }
  }

  const dedupe=new Map();
  for(const item of result)dedupe.set(item.key,item);
  return [...dedupe.values()].slice(-LIMIT);
})()
`;

const applyScript = (
  service: string,
  wanted: ScannedMessage,
  translated: TranslationResult,
) => String.raw`
(() => {
  const service=${JSON.stringify(service)};
  const wanted=${JSON.stringify(wanted)};
  const translated=${JSON.stringify(translated)};
  const clean=value=>String(value??'').replace(/\u200b/g,'').replace(/\u00a0/g,' ').replace(/\r\n?/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  const cssEscape=value=>globalThis.CSS?.escape?CSS.escape(value):String(value).replace(/["\\]/g,'\\$&');
  const visible=node=>{const r=node?.getBoundingClientRect?.();return Boolean(r&&r.width>0&&r.height>0&&r.bottom>=0&&r.top<=innerHeight);};
  const textFrom=source=>{
    if(!source)return '';
    const clone=source.cloneNode(true);
    for(const node of clone.querySelectorAll?.('.mactranslate-live-translation,button,[role="button"],[data-testid="msg-meta"],time,[data-tid*="reaction" i],[data-tid*="timestamp" i]')||[])node.remove();
    for(const image of clone.querySelectorAll?.('img[alt]')||[])image.replaceWith(document.createTextNode(image.getAttribute('alt')||''));
    for(const br of clone.querySelectorAll?.('br')||[])br.replaceWith(document.createTextNode('\n'));
    return clean(clone.innerText||clone.textContent);
  };
  let row=null;
  let anchor=null;
  const id=wanted.key.startsWith('id:')?wanted.key.slice(3):'';

  if(service==='telegram'&&id){
    row=document.querySelector('.Message.message-list-item[data-message-id="'+cssEscape(id)+'"]');
    anchor=row?.querySelector('.text-content')||row?.querySelector('.message-content-wrapper')||row;
  } else if(service==='signal'&&id){
    row=document.querySelector('[data-message-id="'+cssEscape(id)+'"][role="listitem"]');
    anchor=row?.querySelector('.module-message__text')||row?.querySelector('.module-message')||row;
  } else if(service==='teams'){
    if(id){
      row=document.querySelector('[data-mid="'+cssEscape(id)+'"],#message-body-'+cssEscape(id)+',#content-'+cssEscape(id));
      row=row?.closest?.('[data-tid="chat-pane-message"],div[data-mid],[data-tid="message-list-item"],div[role="listitem"],[data-tid="message-group-container"]')||row;
    }
    if(!row){
      const candidates=[...document.querySelectorAll('[data-tid="chat-pane-message"],[data-tid="message-list-item"],[data-tid="message-group-container"],div[role="listitem"],div[data-mid]')].filter(visible);
      row=candidates.reverse().find(candidate=>clean(candidate.innerText||candidate.textContent).includes(wanted.text))||null;
    }
    const selectors=['[id^="message-body-"] [id^="content-"]','[id^="content-"]','[data-tid="message-content"]','[data-tid="message-body"]','[data-tid="bubble-text"]','[role="document"]','.ts-message-content','.message-body','.ui-chat__messagecontent'];
    for(const selector of selectors){anchor=row?.querySelector?.(selector);if(anchor)break;}
    anchor=anchor||row;
  } else if(service==='whatsapp'){
    if(id)row=document.querySelector('[data-id="'+cssEscape(id)+'"]');
    if(!row){
      const candidates=[...document.querySelectorAll('[data-pre-plain-text]')].filter(visible);
      const source=candidates.reverse().find(candidate=>{
        const textNode=candidate.querySelector('.selectable-text.copyable-text')||candidate.querySelector('.selectable-text')||candidate;
        return textFrom(textNode)===wanted.text;
      });
      row=source?.closest('[data-id],[role="row"],.message-in,.message-out')||source||null;
    }
    anchor=row?.querySelector('[data-pre-plain-text] .selectable-text.copyable-text')||row?.querySelector('[data-pre-plain-text] .selectable-text')||row?.querySelector('[data-pre-plain-text]')||row;
  }

  if(!row||!anchor||!visible(row))return false;
  let box=row.querySelector('.mactranslate-live-translation[data-mactranslate-key="'+cssEscape(wanted.key)+'"]');
  if(!box){
    box=document.createElement('div');
    box.className='mactranslate-live-translation';
    box.setAttribute('data-mactranslate-key',wanted.key);
    box.style.cssText='display:block;box-sizing:border-box;margin:4px 6px 2px;padding:4px 8px;border-left:2px solid #0a84ff;border-radius:3px;background:rgba(10,132,255,.08);color:inherit;font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;max-width:520px;pointer-events:none;user-select:text;';
    const label=document.createElement('div');
    label.className='mactranslate-live-translation-label';
    label.style.cssText='opacity:.58;font-size:10px;line-height:1.25;margin-bottom:2px;';
    box.appendChild(label);
    const value=document.createElement('div');
    value.className='mactranslate-live-translation-text';
    box.appendChild(value);
    try{anchor.insertAdjacentElement('afterend',box);}catch{row.appendChild(box);}
  }
  box.dataset.mactranslateSource=wanted.text;
  const label=box.querySelector('.mactranslate-live-translation-label');
  const value=box.querySelector('.mactranslate-live-translation-text');
  if(label)label.textContent=(translated.sourceLanguage||'auto')+' → '+(translated.targetLanguage||'')+' · Google';
  if(value)value.textContent=translated.status==='ok'?(translated.translatedText||''):(translated.message||'翻译失败');
  box.style.borderLeftColor=translated.status==='ok'?'#0a84ff':'#ff9f0a';
  return true;
})()
`;

const composerBridgeScript = (service: string) =>
  String.raw`
(() => {
  const service=${JSON.stringify(service)};
  const clean=value=>String(value??'')
    .replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g,'')
    .replace(/\u00a0/g,' ')
    .replace(/\r\n?/g,'\n')
    .trim();
  const isComposer=node=>Boolean(node&&node.matches?.('textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"]'));
  const composer=()=>{
    const selectors=service==='telegram'
      ? ['#editable-message-text']
      : service==='signal'
        ? ['.module-composition-input .ql-editor[contenteditable="true"]','.module-composition-input [contenteditable="true"]']
        : service==='whatsapp'
          ? ['footer [contenteditable="true"][role="textbox"]','footer [contenteditable="true"]','[data-testid="conversation-compose-box-input"] [contenteditable="true"]']
          : ['[data-tid="ckeditor"] [contenteditable="true"]','[data-tid="message-compose-box"] [contenteditable="true"]','[data-tid="compose-box"] [contenteditable="true"]','form [contenteditable="true"][role="textbox"]'];
    for(const selector of selectors){const node=document.querySelector(selector);if(isComposer(node))return node;}
    const candidates=[...document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]')]
      .filter(node=>isComposer(node)&&!node.closest?.('.mactranslate-composer-translation'))
      .filter(node=>{const r=node.getBoundingClientRect?.();const st=getComputedStyle(node);return r&&r.width>80&&r.height>16&&r.bottom>innerHeight*.45&&st.visibility!=='hidden'&&st.display!=='none';});
    candidates.sort((a,b)=>{
      const score=node=>{const r=node.getBoundingClientRect();const role=node.getAttribute?.('role')||'';const aria=(node.getAttribute?.('aria-label')||'').toLowerCase();const ph=(node.getAttribute?.('data-placeholder')||node.getAttribute?.('placeholder')||'').toLowerCase();let x=r.bottom/Math.max(1,innerHeight)*100; if(role==='textbox')x+=40; if(aria.includes('message')||aria.includes('chat')||aria.includes('type'))x+=35; if(ph.includes('message')||ph.includes('chat')||ph.includes('type'))x+=35; if(node.closest?.('footer,form,[class*=composition],[class*=compose],[data-tid*=compose],[data-testid*=compose]'))x+=45; return x;};
      return score(b)-score(a);
    });
    return candidates[0]||null;
  };
  const read=node=>clean('value' in node?node.value:(node.innerText||node.textContent));
  const directionFor=text=>{
    if(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(text))return 'zh-en';
    if(/[A-Za-z]/u.test(text))return 'en-zh';
    return '';
  };
  const directionLabel=direction=>direction==='zh-en'?'中文 → English':'English → 中文';
  const sendButton=()=>{
    const selectors=service==='telegram'
      ? ['button.Button.send','button[aria-label="Send"]','button[aria-label*="Send" i]','.send-button']
      : service==='signal'
        ? ['.module-composition-area__send-button','button[aria-label*="Send" i]']
        : service==='whatsapp'
          ? ['button[aria-label="Send"]','button[aria-label*="Send" i]','span[data-icon="send"]']
          : ['button[data-tid="send-button"]','button[data-tid*="send" i]','button[aria-label*="Send" i]'];
    for(const selector of selectors){
      const node=document.querySelector(selector);
      if(!node)continue;
      return node.matches?.('button')?node:(node.closest?.('button')||node);
    }
    return null;
  };
  const positionPreview=(preview,node)=>{
    const rect=node?.getBoundingClientRect?.();
    if(!rect||rect.width<=0||rect.height<=0)return;
    const width=Math.max(220,Math.min(rect.width,innerWidth-16));
    const left=Math.max(8,Math.min(rect.left,innerWidth-width-8));
    preview.style.left=left+'px';
    preview.style.top=Math.max(8,rect.top-5)+'px';
    preview.style.width=width+'px';
    preview.style.display='block';
  };
  const ensurePreview=node=>{
    let preview=document.querySelector('.mactranslate-composer-translation');
    if(!preview?.isConnected){
      preview=document.createElement('div');
      preview.className='mactranslate-composer-translation';
      preview.style.cssText='position:fixed;box-sizing:border-box;margin:0;padding:6px 9px;border-left:2px solid #0a84ff;border-radius:4px;background:rgba(10,132,255,.08);color:inherit;font:12px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;white-space:pre-wrap;overflow-wrap:anywhere;max-height:45vh;overflow:auto;z-index:2147483647;transform:translateY(-100%);';
      const header=document.createElement('div');
      header.style.cssText='display:flex;align-items:center;gap:8px;margin-bottom:3px;';
      const label=document.createElement('div');
      label.className='mactranslate-composer-translation-label';
      label.style.cssText='opacity:.58;font-size:10px;line-height:1.25;flex:1;';
      header.appendChild(label);
      preview.appendChild(header);
      const value=document.createElement('div');
      value.className='mactranslate-composer-translation-text';
      value.contentEditable='true';
      value.spellcheck=true;
      value.style.cssText='outline:none;min-height:18px;user-select:text;cursor:text;';
      value.addEventListener('input',()=>{
        const active=composer();
        const activeSource=active?read(active):'';
        preview.dataset.mactranslateAppliedText=clean(value.innerText||value.textContent);
        preview.dataset.mactranslateAppliedSource=activeSource;
      });
      preview.appendChild(value);
      (document.body||document.documentElement).appendChild(preview);
    }
    positionPreview(preview,node);
    return preview;
  };
  const updatePreview=(node,text,state='ready',direction='',replaceValue=false)=>{
    const preview=ensurePreview(node);
    if(!preview)return;
    const label=preview.querySelector('.mactranslate-composer-translation-label');
    const value=preview.querySelector('.mactranslate-composer-translation-text');
    const base=direction?directionLabel(direction):'中英自动翻译';
    const engine=preview.dataset.mactranslateEngine||'Google';
    if(label)label.textContent=state==='busy'?base+' · 翻译中…':base+' · '+engine+(direction==='zh-en'?' · 点击句子可换其他译法，检查无误后按回车发送':'');
    if(value&&replaceValue)value.textContent=text;
  };
  // The user must have seen the translation of exactly this text before it can be sent.
  const previewShowing=(node,text)=>{
    const preview=document.querySelector('.mactranslate-composer-translation');
    return node.dataset.mactranslateTranslatedSource===text&&preview?.style.display!=='none'&&preview?.dataset.mactranslateAppliedSource===text&&Boolean(preview?.dataset.mactranslateAppliedText);
  };
  const clearPreview=()=>{const preview=document.querySelector('.mactranslate-composer-translation');if(preview)preview.style.display='none';};
  const closeChoices=()=>document.querySelector('.mactranslate-choices')?.remove();
  const commitPreview=value=>{
    const preview=value.closest('.mactranslate-composer-translation');
    const active=composer();
    if(preview){
      preview.dataset.mactranslateAppliedText=clean(value.innerText||value.textContent);
      preview.dataset.mactranslateAppliedSource=active?read(active):'';
    }
    closeChoices();
    active?.focus();
  };
  // Google Translate style: the clicked sentence's alternative translations,
  // each with its Chinese meaning.
  const openChoices=(value,sentence,x,y)=>{
    closeChoices();
    if(!sentence)return;
    const choices=JSON.parse(sentence.dataset.choices||'[]');
    if(!choices.length)return;
    const current=sentence.textContent.trim();
    const popup=document.createElement('div');
    popup.className='mactranslate-choices';
    popup.style.cssText='position:fixed;z-index:2147483647;max-width:440px;max-height:50vh;overflow:auto;padding:4px 0;border-radius:8px;background:#fff;color:#111;box-shadow:0 6px 24px rgba(0,0,0,.25);font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;';
    for(const choice of choices){
      const selected=choice.text.trim()===current;
      const item=document.createElement('div');
      item.className='mactranslate-choice';
      item.style.cssText='padding:6px 12px;cursor:pointer;'+(selected?'background:rgba(10,132,255,.10);':'');
      const english=document.createElement('div');
      english.textContent=(selected?'✓ ':'')+choice.text;
      const meaning=document.createElement('div');
      meaning.textContent=choice.meaning||'';
      meaning.style.cssText='font-size:12px;color:#666;margin-top:1px;';
      item.append(english,meaning);
      item.addEventListener('mouseenter',()=>{item.style.background='rgba(10,132,255,.16)';});
      item.addEventListener('mouseleave',()=>{item.style.background=selected?'rgba(10,132,255,.10)':'';});
      item.addEventListener('mousedown',event=>{
        event.preventDefault();
        event.stopPropagation();
        const trailing=sentence.textContent.endsWith(' ')?' ':'';
        sentence.textContent=choice.text.trim()+trailing;
        commitPreview(value);
      });
      popup.appendChild(item);
    }
    (document.body||document.documentElement).appendChild(popup);
    const rect=popup.getBoundingClientRect();
    popup.style.left=Math.max(8,Math.min(x,innerWidth-rect.width-8))+'px';
    popup.style.top=(y+16+rect.height<innerHeight?y+16:Math.max(8,y-rect.height-8))+'px';
  };
  if(!window.__MACTRANSLATE_CHOICES_R31__){
    window.__MACTRANSLATE_CHOICES_R31__=true;
    document.addEventListener('mousedown',event=>{
      if(event.target.closest?.('.mactranslate-choices'))return;
      const value=event.target.closest?.('.mactranslate-composer-translation-text');
      if(!value){closeChoices();return;}
      const sentence=event.target.closest?.('.mactranslate-sentence');
      const {clientX,clientY}=event;
      setTimeout(()=>openChoices(value,sentence,clientX,clientY),0);
    },true);
    document.addEventListener('keydown',event=>{if(event.key==='Escape')closeChoices();},true);
  }
  // Hard rule: no text containing Chinese leaves through any send path
  // (captions, Cmd/Ctrl+Enter, other send buttons). The main composer's plain
  // Enter/Send goes through the translate-then-send flow instead.
  const isSearchField=field=>field.matches?.('input[type="search"],[role="searchbox"]')||/search|搜索/i.test((field.getAttribute?.('aria-label')||'')+' '+(field.getAttribute?.('placeholder')||'')+' '+(field.getAttribute?.('data-placeholder')||'')+' '+(field.getAttribute?.('title')||''));
  const editableFrom=node=>node?.closest?.('textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"]')||null;
  const hasChinese=text=>directionFor(text)==='zh-en';
  const warnChinese=field=>{
    document.querySelector('.mactranslate-chinese-blocked')?.remove();
    const rect=field.getBoundingClientRect?.();
    const note=document.createElement('div');
    note.className='mactranslate-chinese-blocked';
    note.textContent='内容含中文，禁止发送';
    note.style.cssText='position:fixed;z-index:2147483647;padding:4px 10px;border-radius:6px;background:#ff3b30;color:#fff;font:12px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;pointer-events:none;';
    note.style.left=Math.max(8,rect?.left||8)+'px';
    note.style.top=Math.max(8,(rect?.top||40)-30)+'px';
    (document.body||document.documentElement).appendChild(note);
    setTimeout(()=>note.remove(),3000);
  };
  if(!window.__MACTRANSLATE_CHINESE_GUARD_R32__){
    window.__MACTRANSLATE_CHINESE_GUARD_R32__=true;
    document.addEventListener('keydown',event=>{
      if(window.__MACTRANSLATE_SEND_BYPASS_R14__)return;
      if(event.key!=='Enter'||event.shiftKey||event.isComposing||window.__MACTRANSLATE_COMPOSING_R14__)return;
      const field=editableFrom(event.target);
      if(!field||isSearchField(field)||!hasChinese(read(field)))return;
      if(field===composer()&&!event.altKey&&!event.ctrlKey&&!event.metaKey)return;
      event.preventDefault();
      event.stopImmediatePropagation();
      warnChinese(field);
    },true);
    document.addEventListener('click',event=>{
      if(window.__MACTRANSLATE_SEND_BYPASS_R14__)return;
      const button=event.target.closest?.('button,[role="button"],span[data-icon]');
      if(!button)return;
      const name=((button.getAttribute('aria-label')||'')+' '+(button.getAttribute('data-icon')||'')+' '+(button.getAttribute('data-tid')||'')+' '+(button.getAttribute('data-testid')||'')+' '+(button.getAttribute('title')||'')+' '+String(button.className||'')).toLowerCase();
      if(!/send|发送/.test(name))return;
      const main=composer();
      if(main&&hasChinese(read(main)))return;
      const scope=button.closest('[role="dialog"],[aria-modal="true"]')||document;
      const field=[...scope.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"]')]
        .find(item=>!isSearchField(item)&&!item.closest('.mactranslate-composer-translation')&&item.getClientRects().length&&hasChinese(read(item)));
      if(!field)return;
      event.preventDefault();
      event.stopImmediatePropagation();
      warnChinese(field);
    },true);
  }
  if(!window.__MACTRANSLATE_COMPOSER_BRIDGE_R14__){
    window.__MACTRANSLATE_COMPOSER_BRIDGE_R14__=true;
    window.__MACTRANSLATE_PENDING_SEND_R14__=null;
    window.__MACTRANSLATE_SEND_BYPASS_R14__=false;
    window.__MACTRANSLATE_COMPOSING_R14__=false;
    document.addEventListener('compositionstart',event=>{
      const node=composer();
      if(node&&(event.target===node||node.contains?.(event.target)))window.__MACTRANSLATE_COMPOSING_R14__=true;
    },true);
    document.addEventListener('compositionend',event=>{
      const node=composer();
      if(node&&(event.target===node||node.contains?.(event.target)))window.__MACTRANSLATE_COMPOSING_R14__=false;
    },true);
    document.addEventListener('keydown',event=>{
      if(window.__MACTRANSLATE_SEND_BYPASS_R14__)return;
      if(event.key!=='Enter'||event.shiftKey||event.altKey||event.ctrlKey||event.metaKey||event.isComposing||window.__MACTRANSLATE_COMPOSING_R14__)return;
      const node=composer();
      if(!node||!(event.target===node||node.contains?.(event.target)))return;
      const text=read(node);
      const direction=directionFor(text);
      if(direction!=='zh-en')return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if(!previewShowing(node,text)){updatePreview(node,'','busy',direction,false);return;}
      window.__MACTRANSLATE_PENDING_SEND_R14__={mode:'keyboard',source:text};
    },true);
    document.addEventListener('click',event=>{
      if(window.__MACTRANSLATE_SEND_BYPASS_R14__)return;
      const button=sendButton();
      if(!button||!(event.target===button||button.contains?.(event.target)))return;
      const node=composer();
      if(!node)return;
      const text=read(node);
      const direction=directionFor(text);
      if(direction!=='zh-en')return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if(!previewShowing(node,text)){updatePreview(node,'','busy',direction,false);return;}
      window.__MACTRANSLATE_PENDING_SEND_R14__={mode:'click',source:text};
    },true);
  }
  const node=composer();
  if(!node){clearPreview();return {text:'',direction:'',isComposing:false,translationReady:false,pendingSend:''};}
  const text=read(node);
  const direction=directionFor(text);
  const isComposing=Boolean(window.__MACTRANSLATE_COMPOSING_R14__);
  if(!text||!direction){
    delete node.dataset.mactranslateTranslatedSource;
    delete node.dataset.mactranslateTranslatedText;
    window.__MACTRANSLATE_PENDING_SEND_R14__=null;
    clearPreview();
  }else{
    const preview=ensurePreview(node);
    const ready=node.dataset.mactranslateTranslatedSource===text&&Boolean(node.dataset.mactranslateTranslatedText);
    if(preview?.dataset.mactranslateBlockedSource===text){
      const blockedLabel=preview.querySelector('.mactranslate-composer-translation-label');
      if(blockedLabel)blockedLabel.textContent=directionLabel(direction)+' · 翻译失败，不能发送';
    }
    else if(!ready)updatePreview(node,'','busy',direction,false);
    else updatePreview(node,'','ready',direction,false);
    if(preview&&preview.dataset.mactranslateAppliedSource!==text&&ready){
      const value=preview.querySelector('.mactranslate-composer-translation-text');
      if(value)value.textContent=node.dataset.mactranslateTranslatedText||'';
      preview.dataset.mactranslateAppliedText=node.dataset.mactranslateTranslatedText||'';
      preview.dataset.mactranslateAppliedSource=text;
    }
  }
  const pending=window.__MACTRANSLATE_PENDING_SEND_R14__;
  if(pending?.source!==text)window.__MACTRANSLATE_PENDING_SEND_R14__=null;
  const preview=document.querySelector('.mactranslate-composer-translation');
  const appliedReady=preview?.dataset.mactranslateAppliedSource===text&&Boolean(preview?.dataset.mactranslateAppliedText);
  const activePending=window.__MACTRANSLATE_PENDING_SEND_R14__;
  return {
    text:text.slice(0,20000),
    direction,
    isComposing,
    translationReady:node.dataset.mactranslateTranslatedSource===text&&Boolean(node.dataset.mactranslateTranslatedText)&&Boolean(appliedReady),
    pendingSend:activePending?.source===text?String(activePending.mode||''):'',
  };
})()
`;

// Chinese in the composer comes with Google's sentence alternatives, like
// translate.google.com; English only gets a reference translation.
const translateComposer = async (
  text: string,
  direction: string,
): Promise<ComposerTranslation> => {
  if (direction !== 'zh-en') {
    const response = await translateWithGoogle([{ id: 'composer', text }]);
    return { ...response.results[0], engine: 'Google' };
  }
  const google = await googleTranslateWithAlternatives(text);
  if (!google.ok) {
    return {
      id: 'composer',
      status: 'translationError',
      message: `谷歌翻译不可用：${google.message ?? ''}`,
    };
  }
  // Back-translate every alternative so each choice shows its Chinese meaning.
  const alternatives = [
    ...new Set(google.sentences.flatMap(item => item.alternatives)),
  ];
  const meanings = await translateWithGoogle(
    alternatives.map((alternative, index) => ({
      id: String(index),
      text: alternative,
    })),
  );
  const meaningOf = new Map(
    alternatives.map((alternative, index) => {
      const result = meanings.results[index];
      return [alternative, result?.status === 'ok' ? result.translatedText ?? '' : ''];
    }),
  );
  return {
    id: 'composer',
    originalText: text,
    status: 'ok',
    translatedText: google.sentences.map(item => item.translation).join(''),
    sourceLanguage: 'zh-Hans',
    targetLanguage: 'en',
    engine: 'Google',
    sentences: google.sentences.map(item => ({
      ...item,
      choices: item.alternatives.map(alternative => ({
        text: alternative,
        meaning: meaningOf.get(alternative) ?? '',
      })),
    })),
  };
};

const composerApplyScript = (
  service: string,
  sourceText: string,
  translated: ComposerTranslation,
) => String.raw`
(() => {
  const service=${JSON.stringify(service)};
  const sourceText=${JSON.stringify(sourceText)};
  const translated=${JSON.stringify(translated)};
  const clean=value=>String(value??'').replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g,'').replace(/\u00a0/g,' ').replace(/\r\n?/g,'\n').trim();
  const isComposer=node=>Boolean(node&&node.matches?.('textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"]'));
  const composer=()=>{
    const selectors=service==='telegram'
      ? ['#editable-message-text']
      : service==='signal'
        ? ['.module-composition-input .ql-editor[contenteditable="true"]','.module-composition-input [contenteditable="true"]']
        : service==='whatsapp'
          ? ['footer [contenteditable="true"][role="textbox"]','footer [contenteditable="true"]','[data-testid="conversation-compose-box-input"] [contenteditable="true"]']
          : ['[data-tid="ckeditor"] [contenteditable="true"]','[data-tid="message-compose-box"] [contenteditable="true"]','[data-tid="compose-box"] [contenteditable="true"]','form [contenteditable="true"][role="textbox"]'];
    for(const selector of selectors){const node=document.querySelector(selector);if(isComposer(node))return node;}
    const candidates=[...document.querySelectorAll('textarea,input,[contenteditable="true"],[contenteditable="plaintext-only"],[role="textbox"]')]
      .filter(node=>isComposer(node)&&!node.closest?.('.mactranslate-composer-translation'))
      .filter(node=>{const r=node.getBoundingClientRect?.();const st=getComputedStyle(node);return r&&r.width>80&&r.height>16&&r.bottom>innerHeight*.45&&st.visibility!=='hidden'&&st.display!=='none';});
    candidates.sort((a,b)=>{
      const score=node=>{const r=node.getBoundingClientRect();const role=node.getAttribute?.('role')||'';const aria=(node.getAttribute?.('aria-label')||'').toLowerCase();const ph=(node.getAttribute?.('data-placeholder')||node.getAttribute?.('placeholder')||'').toLowerCase();let x=r.bottom/Math.max(1,innerHeight)*100; if(role==='textbox')x+=40; if(aria.includes('message')||aria.includes('chat')||aria.includes('type'))x+=35; if(ph.includes('message')||ph.includes('chat')||ph.includes('type'))x+=35; if(node.closest?.('footer,form,[class*=composition],[class*=compose],[data-tid*=compose],[data-testid*=compose]'))x+=45; return x;};
      return score(b)-score(a);
    });
    return candidates[0]||null;
  };
  const read=node=>clean('value' in node?node.value:(node.innerText||node.textContent));
  const sendButton=()=>{
    const selectors=service==='telegram'
      ? ['button.Button.send','button[aria-label="Send"]','button[aria-label*="Send" i]','.send-button']
      : service==='signal'
        ? ['.module-composition-area__send-button','button[aria-label*="Send" i]']
        : service==='whatsapp'
          ? ['button[aria-label="Send"]','button[aria-label*="Send" i]','span[data-icon="send"]']
          : ['button[data-tid="send-button"]','button[data-tid*="send" i]','button[aria-label*="Send" i]'];
    for(const selector of selectors){const node=document.querySelector(selector);if(node)return node.matches?.('button')?node:(node.closest?.('button')||node);}
    return null;
  };
  const preview=document.querySelector('.mactranslate-composer-translation');
  const node=composer();
  if(!node||read(node)!==sourceText)return {applied:false};
  const value=preview?.querySelector('.mactranslate-composer-translation-text');
  const label=preview?.querySelector('.mactranslate-composer-translation-label');
  const chineseSource=/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(sourceText);
  const direction=chineseSource?'中文 → English':'English → 中文';
  const failed=translated.status!=='ok'||!translated.translatedText;
  // English is sent as typed; only Chinese has to come out as clean English.
  const blocked=!chineseSource?'':failed
    ? (translated.message||'翻译失败')
    : /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(translated.translatedText) ? '译文仍含中文' : '';
  if(failed&&!chineseSource){
    if(label)label.textContent=direction+' · Google';
    if(value)value.textContent='参考译文失败：'+(translated.message||'翻译失败');
    window.__MACTRANSLATE_PENDING_SEND_R14__=null;
    return {applied:true};
  }
  if(blocked){
    if(label)label.textContent=direction+' · Google';
    if(value)value.textContent='无法发送：'+blocked;
    if(preview){preview.style.borderLeftColor='#ff9f0a';preview.dataset.mactranslateBlockedSource=sourceText;}
    // Only English may be sent: Chinese that cannot be fully translated is blocked.
    window.__MACTRANSLATE_PENDING_SEND_R14__=null;
    return {applied:true};
  }
  node.dataset.mactranslateTranslatedSource=sourceText;
  node.dataset.mactranslateTranslatedText=translated.translatedText;
  if(label)label.textContent=direction+' · '+(translated.engine||'Google');
  if(preview){
    preview.style.borderLeftColor='#0a84ff';
    delete preview.dataset.mactranslateBlockedSource;
    preview.dataset.mactranslateEngine=translated.engine||'Google';
    if(preview.dataset.mactranslateAppliedSource!==sourceText){
      if(value){
        value.textContent='';
        if(Array.isArray(translated.sentences)&&translated.sentences.length){
          for(const sentence of translated.sentences){
            const span=document.createElement('span');
            span.className='mactranslate-sentence';
            span.dataset.choices=JSON.stringify(sentence.choices||[]);
            span.textContent=sentence.translation;
            value.appendChild(span);
          }
        }else value.textContent=translated.translatedText;
      }
      preview.dataset.mactranslateAppliedText=translated.translatedText;
      preview.dataset.mactranslateAppliedSource=sourceText;
    }
  }
  const pendingState=window.__MACTRANSLATE_PENDING_SEND_R14__;
  const pending=pendingState?.source===sourceText?String(pendingState.mode||''):'';
  if(!pending)return {applied:true};
  const outgoing=preview?.dataset.mactranslateAppliedSource===sourceText&&preview?.dataset.mactranslateAppliedText
    ? preview.dataset.mactranslateAppliedText
    : translated.translatedText;
  if(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/u.test(outgoing)){
    if(value)value.textContent='无法发送：译文仍含中文';
    if(preview){preview.style.borderLeftColor='#ff9f0a';preview.dataset.mactranslateBlockedSource=sourceText;}
    window.__MACTRANSLATE_PENDING_SEND_R14__=null;
    return {applied:true};
  }
  const replaceText=text=>{
    node.focus();
    if(node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement){
      const proto=node instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const setter=Object.getOwnPropertyDescriptor(proto,'value')?.set;
      if(setter)setter.call(node,text);else node.value=text;
      node.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
      return;
    }
    const selection=getSelection();
    const range=document.createRange();
    range.selectNodeContents(node);
    selection?.removeAllRanges();
    selection?.addRange(range);
    let inserted=false;
    try{inserted=Boolean(document.execCommand?.('insertText',false,text));}catch{}
    if(!inserted){
      node.textContent=text;
      node.dispatchEvent(new InputEvent('input',{bubbles:true,inputType:'insertText',data:text}));
    }
    const end=document.createRange();
    end.selectNodeContents(node);
    end.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(end);
  };
  // Telegram's native composer already accepts the existing execCommand path,
  // so keep that proven behavior unchanged. WhatsApp (Lexical), Teams (CKEditor)
  // and Signal (Quill) keep their own editor model outside the DOM; direct DOM
  // replacement can look correct while Enter still sends the old source text.
  // For those editors, select the source here and let Electron insert the
  // translation as a real native text-input operation in the main process.
  if(service==='telegram'){
    replaceText(outgoing);
  }else{
    node.focus();
    if(node instanceof HTMLInputElement||node instanceof HTMLTextAreaElement){
      node.select();
    }else{
      const selection=getSelection();
      const range=document.createRange();
      range.selectNodeContents(node);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }
  window.__MACTRANSLATE_PENDING_SEND_R14__=null;
  window.__MACTRANSLATE_SEND_BYPASS_R14__=true;
  setTimeout(()=>{window.__MACTRANSLATE_SEND_BYPASS_R14__=false;},900);
  const nativeOutgoing=service==='telegram'?undefined:outgoing;
  if(pending==='click'){
    const button=sendButton();
    const rect=button?.getBoundingClientRect?.();
    if(rect&&rect.width>0&&rect.height>0)return {applied:true,send:'click',outgoing:nativeOutgoing,x:rect.left+rect.width/2,y:rect.top+rect.height/2};
  }
  return {applied:true,send:'keyboard',outgoing:nativeOutgoing};
})()
`;

const scheduleComposer = (
  service: string,
  contents: WebContents,
  delay = COMPOSER_KICK_DELAY_MS,
) => {
  const target = liveTargets.get(contents.id);
  if (!target || contents.isDestroyed()) return;
  if (target.composerKickTimer) clearTimeout(target.composerKickTimer);
  target.composerKickTimer = setTimeout(() => {
    const current = liveTargets.get(contents.id);
    if (current) current.composerKickTimer = null;
    void processComposer(service, contents);
  }, delay);
};

const processComposer = async (service: string, contents: WebContents) => {
  const target = liveTargets.get(contents.id);
  if (!target || contents.isDestroyed()) return;
  if (target.composerBusy) {
    target.composerQueued = true;
    return;
  }
  target.composerBusy = true;
  try {
    const state: ComposerState | null = await contents.executeJavaScript(
      composerBridgeScript(service),
      true,
    );
    const text = String(state?.text ?? '').trim();
    if (!text || !state?.direction) return;
    if (text !== target.composerText) {
      target.composerText = text;
      target.composerTextAt = Date.now();
    }
    if (!state.pendingSend && Date.now() - target.composerTextAt < COMPOSER_SETTLE_MS) {
      return;
    }
    // Signal's IME composition must finish before we touch its composer.
    if (service === 'signal' && state.isComposing) return;
    if (state.translationReady && !state.pendingSend) return;

    const result = await translateComposer(text, state.direction);
    if (!result || contents.isDestroyed()) return;

    const applied: ComposerApplyResult | null = await contents.executeJavaScript(
      composerApplyScript(service, text, result),
      true,
    );
    if (!applied?.send || contents.isDestroyed()) return;

    if (typeof applied.outgoing === 'string' && applied.outgoing.trim()) {
      await new Promise(resolve => setTimeout(resolve, 8));
      contents.insertText(applied.outgoing);
      await new Promise(resolve => setTimeout(resolve, 32));
    } else {
      await new Promise(resolve => setTimeout(resolve, 20));
    }

    if (
      applied.send === 'click' &&
      typeof applied.x === 'number' &&
      Number.isFinite(applied.x) &&
      typeof applied.y === 'number' &&
      Number.isFinite(applied.y)
    ) {
      const x = Math.max(0, Math.round(applied.x ?? 0));
      const y = Math.max(0, Math.round(applied.y ?? 0));
      contents.sendInputEvent({ type: 'mouseMove', x, y });
      contents.sendInputEvent({
        type: 'mouseDown',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
      contents.sendInputEvent({
        type: 'mouseUp',
        x,
        y,
        button: 'left',
        clickCount: 1,
      });
    } else {
      contents.sendInputEvent({ type: 'keyDown', keyCode: 'ENTER' });
      contents.sendInputEvent({ type: 'keyUp', keyCode: 'ENTER' });
    }
  } catch {
    // The page may navigate or reload mid-flight; the next poll retries.
  } finally {
    const current = liveTargets.get(contents.id);
    if (current) {
      current.composerBusy = false;
      if (current.composerQueued) {
        current.composerQueued = false;
        scheduleComposer(service, contents, 0);
      }
    }
  }
};

const processTarget = async (service: string, contents: WebContents) => {
  const target = liveTargets.get(contents.id);
  if (!target || target.messageBusy || contents.isDestroyed()) return;
  target.messageBusy = true;
  try {
    const scanned = await contents.executeJavaScript(scanScript(service), true);
    const messages: ScannedMessage[] = Array.isArray(scanned) ? scanned : [];
    if (!messages.length) return;

    const waiting = new Map<string, ScannedMessage[]>();
    for (const message of messages) {
      const text = String(message?.text ?? '').trim();
      if (!translatableText(text) || message.hasTranslation) continue;
      const known = target.cache.get(text) ?? globalTranslations.get(text);
      if (
        known?.status === 'ok' ||
        known?.status === 'languagePackRequired' ||
        known?.status === 'unsupportedSystem'
      ) {
        await contents.executeJavaScript(
          applyScript(service, message, known),
          true,
        );
        continue;
      }
      if ((target.failedUntil.get(text) ?? 0) > Date.now()) continue;
      const group = waiting.get(text) ?? [];
      group.push(message);
      waiting.set(text, group);
    }

    const texts = [...waiting.keys()].slice(0, BATCH_LIMIT);
    if (!texts.length) return;
    const response = await translateWithGoogle(
      texts.map((text, index) => ({ id: String(index), text })),
    );
    const byId = new Map(
      (response.results ?? []).map(result => [String(result.id), result]),
    );
    for (let index = 0; index < texts.length; index += 1) {
      const text = texts[index];
      const result = byId.get(String(index));
      if (!result) {
        target.failedUntil.set(text, Date.now() + 5000);
        continue;
      }
      target.cache.set(text, result);
      rememberGlobal(text, result);
      if (
        result.status !== 'ok' &&
        result.status !== 'languagePackRequired' &&
        result.status !== 'unsupportedSystem'
      ) {
        target.failedUntil.set(text, Date.now() + 15_000);
        continue;
      }
      for (const message of waiting.get(text) ?? []) {
        if (contents.isDestroyed()) return;
        await contents.executeJavaScript(
          applyScript(service, message, result),
          true,
        );
      }
    }
  } catch {
    // Ignore transient page errors; the next poll retries.
  } finally {
    const current = liveTargets.get(contents.id);
    if (current) current.messageBusy = false;
  }
};

export const armLiveMessageTranslation = (
  service: string,
  contents: WebContents,
) => {
  if (contents.isDestroyed()) return;
  let target = liveTargets.get(contents.id);
  if (!target) {
    target = {
      contents,
      messageTimer: null,
      composerTimer: null,
      messageBusy: false,
      composerBusy: false,
      composerQueued: false,
      composerKickTimer: null,
      inputListener: null,
      cache: new Map(),
      failedUntil: new Map(),
      composerText: '',
      composerTextAt: 0,
    };
    liveTargets.set(contents.id, target);
  }
  if (!target.messageTimer) {
    void processTarget(service, contents);
    target.messageTimer = setInterval(() => {
      void processTarget(service, contents);
    }, MESSAGE_POLL_MS);
  }
  if (!target.composerTimer) {
    void processComposer(service, contents);
    target.composerTimer = setInterval(() => {
      void processComposer(service, contents);
    }, COMPOSER_POLL_MS);
  }
  if (!target.inputListener) {
    const listener = () => scheduleComposer(service, contents);
    target.inputListener = listener;
    contents.on('before-input-event', listener);
  }
};

export const stopLiveMessageTranslation = (contentsId: number) => {
  const target = liveTargets.get(contentsId);
  if (target?.messageTimer) clearInterval(target.messageTimer);
  if (target?.composerTimer) clearInterval(target.composerTimer);
  if (target?.composerKickTimer) clearTimeout(target.composerKickTimer);
  if (target?.inputListener && !target.contents.isDestroyed()) {
    target.contents.removeListener('before-input-event', target.inputListener);
  }
  liveTargets.delete(contentsId);
};
