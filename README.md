# Hybrid Incident Analyzer

A read-only incident review workspace for support engineers. Start with a synthetic log, ask Firebase AI Logic for a working diagnosis, and review the evidence and suggested checks. The result shows where the SDK ran inference and how long it took.

## Run locally

1. Install Node.js 24 and dependencies with npm ci.
2. Create a Firebase web app and enable Firebase AI Logic with the Gemini Developer API.
3. Copy .env.example to .env.local. Set VITE_FIREBASE_CONFIG to the Firebase web configuration containing apiKey, projectId, and appId.
4. For local cloud tests, register a localhost App Check debug token for your Firebase web app and put it in VITE_APPCHECK_DEBUG_TOKEN in .env.local. Enable App Check enforcement for Firebase AI Logic.
5. Run npm run dev and open http://localhost:5173 in desktop Chrome.

The workspace can prepare Chrome's local model when Chrome reports that a download is available. See the official [Firebase web hybrid setup](https://firebase.google.com/docs/ai-logic/hybrid/web/get-started) and [Chrome Prompt API requirements](https://developer.chrome.com/docs/ai/prompt-api).

## Routing and data

| Route | Firebase SDK mode | What to expect |
| --- | --- | --- |
| Device only | ONLY_ON_DEVICE | Runs locally with a ready model. It can run offline once the page is loaded. |
| Device first | PREFER_ON_DEVICE | Prefers on-device inference, with cloud fallback when needed. Requires explicit consent for each run and Firebase App Check. |

The workspace accepts three built-in synthetic incidents. Model output is displayed as text. It proposes scoped, read-only checks and leaves execution to the engineer. Export JSON saves the current analysis locally. The displayed source comes from the SDK's inferenceSource field.

## Build and verify

- npm test runs the routing tests.
- npm run build checks types and builds the public site.
- For a hosted build set VITE_PUBLIC_FIREBASE_CONFIG and VITE_APPCHECK_SITE_KEY. Register the hosting domain for the App Check provider. Keep debug tokens in an untracked local file.
- The development-only preflight is at /preflight.html. The ordinary production build includes the main workspace.

For the #BuildHybridAI Web track, enable **Gemma 4 for Built-in AI** at `chrome://flags/#gemma4-for-built-in-ai` and restart Chrome. The [contest FAQ](https://firebasehybridaihackathon.devpost.com/details/faqs) identifies this as the Gemini Nano 4 setup. Back in the workspace, select **Prepare local model** if offered. Wait for **Local model ready**, then run **Device only** and verify the result says **On this device**. Chrome selects and downloads the model.

[New work and disclosures](NEW_WORK.md) · [License](LICENSE)
