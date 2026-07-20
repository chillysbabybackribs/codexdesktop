# Custom Task Capsule

Use this only when the built-in research and browser tools cannot express an exact structured API or repeated extraction.

```text
/tmp/codexdesktop-tasks/<task-id>/
  intent.json
  run.mjs
  evidence.jsonl
  metrics.json
```

`intent.json` records the question, target version/date, evidence fields, source lanes, and stopping rule. `run.mjs` owns fetching or extraction, normalization, verification, and artifact writes. It prints only a compact envelope:

```json
{"ok":true,"records":8,"gaps":[],"artifacts":{"evidence":".../evidence.jsonl","metrics":".../metrics.json"},"durationMs":1840}
```

Write JSONL through Node serialization rather than shell quoting. Cap arrays and strings and return an explicit `verified` field so an empty shell, login wall, or challenge cannot be mistaken for evidence.

For browser-backed scripts, use the inherited `CODEX_BROWSER_SOCK`. Call `GET /tabs` first and target an explicit existing tab id. Available routes are `GET /tabs`, `POST /tabs`, `POST /eval`, and `POST /cdp`; do not call `POST /tabs` unless the user explicitly requested a new tab.

```js
import http from 'node:http';

export function browserRequest(path, { method = 'GET', body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: process.env.CODEX_BROWSER_SOCK, path, method }, response => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { raw += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(raw)); }
        catch { reject(new Error(`invalid browser response: ${raw.slice(0, 300)}`)); }
      });
    });
    request.on('error', reject);
    request.end(body);
  });
}
```
