import './style.css';
import {initializeApp, SDK_VERSION} from 'firebase/app';
import {initializeAppCheck, ReCaptchaV3Provider, getToken, type AppCheck} from 'firebase/app-check';
import {getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, type AI} from 'firebase/ai';
import {fixtures, buildPrompt, allowRun, assess} from './policy.mjs';

type ModelDownloadMonitor = {
 addEventListener(type: 'downloadprogress', listener: (event: ProgressEvent) => void): void;
};
type LM = {
 availability(options?: unknown): Promise<string>;
 create(options?: { monitor: (monitor: ModelDownloadMonitor) => void }): Promise<{ destroy(): void }>;
};
declare global {interface Window {LanguageModel?:LM; FIREBASE_APPCHECK_DEBUG_TOKEN?:boolean|string}}
const el = <T extends HTMLElement>(id:string)=>document.getElementById(id) as T;
const consent=()=>el<HTMLInputElement>('cloud').checked;
const records:Record<string,unknown>[]=[];
let ai:AI|undefined, appCheck:AppCheck|undefined;
let appCheckVerified=false;
let initialized=false;
const status=(s:string)=>{el('status').textContent=s;};
function record(r:Record<string,unknown>){records.push({at:new Date().toISOString(),sdk:SDK_VERSION,...r});el('result').textContent=JSON.stringify(records,null,2);}
function safeError(e:unknown){const code=(e as {code?:unknown})?.code;return typeof code==='string' && /^[a-zA-Z0-9/_-]{1,100}$/.test(code)?code:(e instanceof Error?e.name:'UnknownError');}
function action(id:string, fn:()=>Promise<void>){
 el(id).onclick=async()=>{document.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=true);
 const timer=id==='download'?undefined:setTimeout(()=>status('Виконання триває понад 90 с. Зачекайте на результат.'),90000);
 try{await fn();}catch(e){record({step:id,status:'ERROR',errorCode:safeError(e)});status('Помилка. Перевірте README та Console локально; не копіюйте токени.');}
 finally{clearTimeout(timer);document.querySelectorAll<HTMLButtonElement>('button').forEach(b=>b.disabled=false);}
 };
}
if(import.meta.env.DEV&&import.meta.env.VITE_FIREBASE_CONFIG){el<HTMLTextAreaElement>('config').placeholder='Локальну конфігурацію підготовлено; натисніть Ініціалізувати Firebase.';el<HTMLTextAreaElement>('config').disabled=true;}
const sample=()=>{el('sample').textContent=fixtures[el<HTMLSelectElement>('fixture').value as keyof typeof fixtures];};
el('fixture').onchange=sample;sample();
action('availability',async()=>{
 const available=window.LanguageModel?await window.LanguageModel.availability():'API_ABSENT';
 record({step:'chrome',availability:available,online:navigator.onLine});status('Chrome: '+available);
});
action('download',async()=>{
 if(!window.LanguageModel)throw new Error('Prompt API absent');
 status('Chrome перевіряє модель. Очікую на початок завантаження…');
 const session=await window.LanguageModel.create({
  monitor(monitor) {
   monitor.addEventListener('downloadprogress', event => {
    const percent=Math.min(100,Math.max(0,Math.round(event.loaded*100)));
    status(percent===100?'Chrome завантажив пакет. Готує модель…':`Завантаження моделі Chrome: ${percent}%`);
   });
  }
 });
 session.destroy();
 record({step:'chrome-model',availability:await window.LanguageModel.availability()});status('Модель підготовлена; це ще не перевірка Firebase SDK.');
});
action('setup',async()=>{
 if(initialized)throw new Error('Reload to change configuration');
 if(!['localhost','127.0.0.1','[::1]'].includes(location.hostname))throw new Error('Local debug build only');
 const saved=import.meta.env.DEV?import.meta.env.VITE_FIREBASE_CONFIG:undefined;
 const raw=JSON.parse(saved||el<HTMLTextAreaElement>('config').value);
 const config:Record<string,string>={};
 for(const key of ['apiKey','projectId','appId']){if(typeof raw[key]!=='string'||!raw[key].trim())throw new Error('Missing config');config[key]=raw[key].trim();}
 window.FIREBASE_APPCHECK_DEBUG_TOKEN=import.meta.env.DEV?(import.meta.env.VITE_APPCHECK_DEBUG_TOKEN||true):true;
 const app=initializeApp(config);initialized=true;
 appCheck=initializeAppCheck(app,{provider:new ReCaptchaV3Provider('local-debug-only'),isTokenAutoRefreshEnabled:false});
 ai=getAI(app,{backend:new GoogleAIBackend()});
 el<HTMLTextAreaElement>('config').value='';
 record({step:'setup',status:'READY_NOT_VERIFIED'});status('Firebase готовий. Дозвольте синтетичний тест і перевірте App Check.');
});
action('appcheck',async()=>{
 if(!appCheck||!consent())throw new Error('Initialize and consent first');
 const token=await getToken(appCheck,false);
 appCheckVerified=Boolean(token.token);record({step:'appcheck',status:appCheckVerified?'PASS':'FAIL'});status('App Check: '+(appCheckVerified?'PASS':'FAIL'));
});
async function run(mode:InferenceMode){
 allowRun(mode,consent());
 if(!ai)throw new Error('Initialize Firebase first');
 if(mode!==InferenceMode.ONLY_ON_DEVICE&&!appCheckVerified)throw new Error('Verify App Check first');
 const fixture=el<HTMLSelectElement>('fixture').value as keyof typeof fixtures;
 const model=getGenerativeModel(ai,{mode});
 const started=performance.now();
 const beforePromise=window.LanguageModel?window.LanguageModel.availability():Promise.resolve('API_ABSENT');
 let init='NOT_NEEDED';
 if(mode!==InferenceMode.ONLY_IN_CLOUD){
  status('Ініціалізація локальної моделі через Firebase SDK…');
  try{await model.initializeDeviceModel();init='READY';}
  catch(e){init=safeError(e);if(mode===InferenceMode.ONLY_ON_DEVICE)throw e;}
 }
 const prompt=buildPrompt(fixture);
 status('Виконую '+mode+'…');
 const result=await model.generateContent(prompt);
 const source=result.response.inferenceSource;
 const output=result.response.text();
 const verdict=assess(mode,source,output);
 record({step:'inference',mode,fixture,source:source??'UNKNOWN',status:verdict,elapsedMs:Math.round(performance.now()-started),availabilityBefore:await beforePromise,deviceInitialization:init,online:navigator.onLine,appCheckVerified,output});
 status(verdict+' · '+(source??'UNKNOWN'));
}
action('local',()=>run(InferenceMode.ONLY_ON_DEVICE));
action('remote',()=>run(InferenceMode.ONLY_IN_CLOUD));
action('hybrid',()=>run(InferenceMode.PREFER_ON_DEVICE));
el('export').onclick=()=>{
 const report={schemaVersion:1,createdAt:new Date().toISOString(),scope:'synthetic-only manual browser preflight',records};
 const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
 const a=document.createElement('a');a.href=url;a.download='browser-preflight-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
};
