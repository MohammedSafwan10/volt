export const BROWSER_GUIDANCE = `Use browser tools for deterministic page diagnosis before proposing fixes.

Rules:
- Start with \`browser_get_summary\`, then drill into console/network/performance.
- Navigation strategy:
  1) If browser is already open on a localhost/127.0.0.1 URL, reuse that page first (do NOT override with \`file://\` by default).
  2) If browser is not on the target app, check running terminals/process output for an existing dev-server URL and navigate there.
  3) Only start a new dev server if needed, then navigate to its URL.
- For failing requests, call \`browser_get_network_requests\` first, then \`browser_get_network_request_details\`.
- For auth/session issues, use \`browser_get_application_storage\` (sensitive values masked by default).
- For prod-only failures, use \`browser_get_security_report\`.
- Use guided actions (\`browser_propose_action\` -> \`browser_preview_action\` -> \`browser_execute_action\`) for controlled interventions.

Failure playbook:
- If browser data is empty, navigate/reload first, then retry read tools.
- If details call fails due to missing id, reacquire request ids from list tool first.
- If CDP/browser automation action fails twice, stop repeating and return a concrete manual next step.`;
