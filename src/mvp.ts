import './mvp.css';
import { initializeApp, SDK_VERSION, type FirebaseApp, type FirebaseOptions } from 'firebase/app';
import {
  initializeAppCheck, ReCaptchaV3Provider, getToken, type AppCheck
} from 'firebase/app-check';
import {
  getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, InferenceSource, type AI
} from 'firebase/ai';
import { allowRun, assess, buildPrompt, fixtures } from './policy.mjs';

type Fixture = keyof typeof fixtures;
type Route = 'local' | 'hybrid';
type Result = {
  at: string;
  sdk: string;
  fixture: Fixture;
  mode: InferenceMode;
  source: InferenceSource;
  elapsedMs: number;
  onlineBefore: boolean;
  onlineAfter: boolean;
  output: string;
};

const id = <T extends HTMLElement>(name: string) => document.getElementById(name) as T;
const scenarioButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-fixture]'));
const routeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[name="route"]'));
const runButton = id<HTMLButtonElement>('run');
const prepareButton = id<HTMLButtonElement>('prepare');
const exportButton = id<HTMLButtonElement>('export');
const consent = id<HTMLInputElement>('cloud-consent');
const status = id('run-status');
const outputPanel = id('analysis-panel');
const names: Record<Fixture, string> = {
  disk: 'Disk pressure',
  dns: 'DNS timeout',
  injection: 'Untrusted input'
};

const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const localDevelopment = import.meta.env.DEV && loopback;
const rawConfig = localDevelopment
  ? import.meta.env.VITE_FIREBASE_CONFIG
  : import.meta.env.VITE_PUBLIC_FIREBASE_CONFIG;
const debugToken = localDevelopment ? import.meta.env.VITE_APPCHECK_DEBUG_TOKEN : undefined;
const siteKey = import.meta.env.VITE_APPCHECK_SITE_KEY;
const config = parseConfig(rawConfig);

let selectedFixture: Fixture = 'disk';
let route: Route = 'local';
let availability = 'checking';
let modelPoll: ReturnType<typeof setTimeout> | undefined;
let busy = false;
let appCheck: AppCheck | undefined;
let hybridApp: FirebaseApp | undefined;
let localAI: AI | undefined;
let hybridAI: AI | undefined;
let lastResult: Result | undefined;

function parseConfig(raw: unknown): FirebaseOptions | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const config: Record<string, string> = {};
    for (const key of ['apiKey', 'projectId', 'appId']) {
      const value = parsed?.[key];
      if (typeof value !== 'string' || !value.trim()) return undefined;
      config[key] = value.trim();
    }
    return config;
  } catch {
    return undefined;
  }
}

function showStatus(message: string, isError = false): void {
  status.textContent = message;
  status.dataset.error = String(isError);
}

function showSignal(target: HTMLElement, text: string, state: string): void {
  target.textContent = text;
  target.dataset.state = state;
}

function syncControls(): void {
  const isHybrid = route === 'hybrid';
  id('consent-row').hidden = !isHybrid;
  consent.disabled = busy;
  for (const input of routeInputs) input.disabled = busy;
  for (const button of scenarioButtons) button.disabled = busy;

  prepareButton.hidden = !['downloadable', 'downloading'].includes(availability);
  prepareButton.disabled = busy || availability === 'downloading';
  exportButton.disabled = busy || !lastResult;
  const cloudReady = navigator.onLine && consent.checked && Boolean(debugToken || siteKey);
  runButton.disabled = busy || !config || (isHybrid ? !cloudReady : availability !== 'available');

  showSignal(id('network-state'), navigator.onLine ? 'Network online' : 'Network offline', navigator.onLine ? 'good' : 'warn');
  if (busy) return;
  if (!config) showStatus('Set the Firebase web app configuration before running an incident.', true);
  else if (isHybrid && !navigator.onLine) showStatus('Device first needs a network connection. Device only works offline.');
  else if (isHybrid && !debugToken && !siteKey) showStatus('Configure Firebase App Check to enable cloud fallback.', true);
  else if (isHybrid && !consent.checked) showStatus('Confirm cloud fallback for this sample to continue.');
  else if (!isHybrid && availability === 'checking') showStatus('Checking the local model…');
  else if (!isHybrid && availability === 'unavailable') showStatus('The local model is unavailable on this device.');
  else if (!isHybrid && availability === 'downloadable') showStatus('Prepare the local model once before running Device only.');
  else if (!isHybrid && availability === 'downloading') showStatus('Chrome is downloading the local model.');
  else showStatus('');
}

function selectFixture(fixture: Fixture): void {
  selectedFixture = fixture;
  consent.checked = false;
  for (const button of scenarioButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.fixture === fixture));
  }
  const lines = fixtures[fixture].split('\n').slice(1);
  const items = lines.map(line => {
    const item = document.createElement('li');
    item.textContent = line;
    return item;
  });
  id('events').replaceChildren(...items);
  id('event-count').textContent = `${items.length} events`;
  syncControls();
}

async function inspectModel(): Promise<void> {
  try {
    availability = await window.LanguageModel?.availability() ?? 'unavailable';
  } catch {
    availability = 'unavailable';
  }
  const messages: Record<string, [string, string]> = {
    available: ['Local model ready', 'good'],
    downloadable: ['Local model available to download', 'warn'],
    downloading: ['Local model downloading', 'wait'],
    unavailable: ['Local model unavailable', 'warn']
  };
  const [label, signal] = messages[availability] ?? messages.unavailable;
  showSignal(id('device-state'), label, signal);
  clearTimeout(modelPoll);
  if (availability === 'downloading' && !document.hidden) {
    modelPoll = setTimeout(() => { void inspectModel(); }, 4000);
  }
  syncControls();
}

function localClient(): AI {
  if (!config) throw new Error('missing-config');
  localAI ??= getAI(initializeApp(config, 'incident-device'), { backend: new GoogleAIBackend() });
  return localAI;
}

async function authorizedHybridClient(): Promise<AI> {
  if (!config || !navigator.onLine) throw new Error('offline or missing configuration');
  if (!appCheck) {
    if (debugToken) window.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;
    if (!debugToken && !siteKey) throw new Error('missing-app-check');
    hybridApp ??= initializeApp(config, 'incident-hybrid');
    appCheck = initializeAppCheck(hybridApp, {
      provider: new ReCaptchaV3Provider(siteKey || 'local-debug-only'),
      isTokenAutoRefreshEnabled: false
    });
  }
  const check = await getToken(appCheck);
  if (!check.token || !hybridApp) throw new Error('missing-app-check');
  // The SDK captures App Check when its AI client is created.
  hybridAI ??= getAI(hybridApp, { backend: new GoogleAIBackend() });
  return hybridAI;
}

function setBusy(next: boolean): void {
  busy = next;
  outputPanel.setAttribute('aria-busy', String(next));
  syncControls();
}

function renderResult(result: Result): void {
  const fromDevice = result.source === InferenceSource.ON_DEVICE;
  showSignal(id('result-source'), fromDevice ? 'On this device' : 'Firebase cloud', fromDevice ? 'good' : 'cloud');
  id('result-time').textContent = `${(result.elapsedMs / 1000).toFixed(1)} s`;
  id('result-network').textContent = !result.onlineBefore && !result.onlineAfter ? 'Offline at start and end' : '';
  id('result-caption').textContent = `Latest result · ${names[result.fixture]}`;
  id('result-meta').hidden = false;

  const heading = /^(?:#{1,6}\s+)?(?:\*\*)?(summary|likely cause|supporting (?:log )?evidence|uncertainty|(?:two )?(?:low[- ]cost )?(?:read[- ]only|non[- ]destructive) checks)(?:\s*\([^)]*\))?\s*:?(?:\*\*)?(?:\s*(.*))?$/i;
  const blocks: { title: string; lines: string[] }[] = [];
  let current = { title: 'Analysis', lines: [] as string[] };
  blocks.push(current);
  for (const line of result.output.split('\n')) {
    const match = heading.exec(line.trim());
    if (match) {
      const name = match[1];
      current = { title: name.charAt(0).toUpperCase() + name.slice(1), lines: [] };
      if (match[2]) current.lines.push(match[2]);
      blocks.push(current);
    } else {
      current.lines.push(line);
    }
  }
  const sections = blocks.filter(block => block.lines.join('').trim()).map(block => {
    const section = document.createElement('section');
    section.className = 'finding';
    const title = document.createElement('h3');
    title.textContent = block.title;
    const text = document.createElement('p');
    text.textContent = block.lines.join('\n').trim().replace(/\*\*([^*]+)\*\*/g, '$1');
    section.append(title, text);
    return section;
  });
  id('result').replaceChildren(...sections);
}

async function runAnalysis(): Promise<void> {
  if (busy || runButton.disabled) return;
  const fixture = selectedFixture;
  const mode = route === 'local' ? InferenceMode.ONLY_ON_DEVICE : InferenceMode.PREFER_ON_DEVICE;
  const onlineBefore = navigator.onLine;
  const started = performance.now();
  let failure: string | undefined;
  let checkedCloud = false;
  setBusy(true);

  try {
    allowRun(mode, consent.checked);
    let client: AI;
    if (mode === InferenceMode.PREFER_ON_DEVICE) {
      showStatus('Verifying App Check for permitted cloud fallback…');
      client = await authorizedHybridClient();
      checkedCloud = true;
    } else {
      client = localClient();
    }
    const model = getGenerativeModel(client, {mode}, {timeout: 45000});
    if (availability === 'available') {
      showStatus('Starting the local model…');
      try {
        await model.initializeDeviceModel();
      } catch (error) {
        if (mode === InferenceMode.ONLY_ON_DEVICE) throw error;
      }
    }
    showStatus(mode === InferenceMode.ONLY_ON_DEVICE ? 'Analyzing on this device…' : 'Running device-first analysis…');
    const { response } = await model.generateContent(buildPrompt(fixture));
    const source = response.inferenceSource;
    const output = response.text();
    if (!source || assess(mode, source, output) !== 'PASS') {
      throw new Error('unverified-result');
    }
    lastResult = {
      at: new Date().toISOString(), sdk: SDK_VERSION, fixture, mode, source,
      elapsedMs: Math.round(performance.now() - started),
      onlineBefore, onlineAfter: navigator.onLine, output
    };
    renderResult(lastResult);
  } catch {
    failure = mode === InferenceMode.ONLY_ON_DEVICE
      ? 'Device analysis failed. Check that the local model is ready and try again.'
      : checkedCloud
        ? 'Analysis failed. Check the network and try again, or use Device only.'
        : 'Cloud authorization failed. Check Firebase App Check or use Device only.';
  } finally {
    consent.checked = false;
    setBusy(false);
    if (failure) showStatus(failure, true);
    else if (lastResult) showStatus('Analysis complete.');
  }
}

prepareButton.addEventListener('click', async () => {
  if (!window.LanguageModel || busy) return;
  let failed = false;
  setBusy(true);
  showStatus('Waiting for Chrome to prepare the local model…');
  try {
    const session = await window.LanguageModel.create({
      monitor(monitor) {
        monitor.addEventListener('downloadprogress', event => {
          const percent = Math.round(Math.max(0, Math.min(1, event.loaded)) * 100);
          showStatus(percent === 100 ? 'Chrome is preparing the downloaded model…' : `Downloading local model · ${percent}%`);
        });
      }
    });
    session.destroy();
  } catch {
    failed = true;
  } finally {
    await inspectModel();
    setBusy(false);
    if (failed) showStatus('Chrome could not prepare the model. Check the device and try again.', true);
  }
});
for (const button of scenarioButtons) {
  button.addEventListener('click', () => selectFixture(button.dataset.fixture as Fixture));
}
for (const input of routeInputs) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    route = input.value as Route;
    consent.checked = false;
    syncControls();
  });
}
consent.addEventListener('change', syncControls);
runButton.addEventListener('click', runAnalysis);
exportButton.addEventListener('click', () => {
  if (!lastResult) return;
  const blob = new Blob([JSON.stringify({ schemaVersion: 1, result: lastResult }, null, 2)], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `incident-analysis-${lastResult.fixture}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('online', syncControls);
window.addEventListener('offline', syncControls);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !busy) void inspectModel();
});
selectFixture('disk');
void inspectModel();
