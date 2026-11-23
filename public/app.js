const token = decodeURIComponent(location.hash.slice(1));
const $ = (id) => document.getElementById(id);
let state;
let selected;
let formOpen = false;
let busy = false;
let modalUrl;
let lastError = '';

async function api(path, method = 'GET', data) {
  const response = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
    body: data ? JSON.stringify(data) : undefined,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return response.headers.get('content-type')?.includes('application/json') ? response.json() : response;
}

function text(node, value) {
  node.textContent = value == null ? '' : String(value);
}
function element(tag, className, value) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (value != null) text(node, value);
  return node;
}
function notice(message) {
  lastError = message;
  showNotice(message);
}
function showNotice(message) {
  text($('notice'), message);
  $('notice').hidden = !message;
}
function selectedFlow() {
  return state?.flows.find((flow) => flow.id === selected);
}
function resultFor(id) {
  return state?.results.find((result) => result.flowId === id);
}

function describe(step) {
  if (step.type === 'checkText') return `Visible text: “${step.text}”`;
  const target = step.label || step.locator?.value || 'Element';
  if (step.type === 'fill') return `${target} ← ${step.env ? `$${step.env}` : `“${step.value || ''}”`}`;
  if (step.type === 'select') return `${target} ← “${step.value || ''}”`;
  if (step.type === 'press') return `${target} ← ${step.value}`;
  return target;
}

function renderSteps(container, steps, results = []) {
  container.replaceChildren();
  steps.forEach((step, index) => {
    const result = results.find((item) => item.index === index);
    const row = element('div', `step-row${result?.status === 'fail' ? ' failed' : ''}`);
    row.append(element('span', 'step-num', String(index + 1).padStart(2, '0')));
    row.append(element('span', 'step-kind', step.type === 'checkText' ? 'check' : step.type));
    row.append(element('span', 'step-detail', describe(step)));
    row.append(
      element(
        'span',
        `step-state ${result?.status || ''}`,
        result?.status || (results.length ? 'skipped' : 'saved'),
      ),
    );
    if (step.after)
      row.append(
        element(
          'span',
          'step-after',
          `${step.after.path}${step.after.headings[0] ? ` · ${step.after.headings[0]}` : ''}`,
        ),
      );
    if (result?.status === 'fail') row.append(element('span', 'step-error', result.message));
    container.append(row);
  });
  if (!steps.length) container.append(element('p', 'step-after', 'No actions yet. Use browser window.'));
}

function renderFlows() {
  const list = $('flow-list');
  list.replaceChildren();
  for (const flow of state.flows) {
    const result = resultFor(flow.id);
    const button = element('button', `flow-link${selected === flow.id ? ' active' : ''}`);
    button.type = 'button';
    button.setAttribute('aria-current', selected === flow.id ? 'page' : 'false');
    button.append(element('span', `status-dot ${result?.status || ''}`));
    button.append(element('strong', '', flow.name));
    button.append(element('small', '', String(flow.steps.length).padStart(2, '0')));
    button.addEventListener('click', () => {
      selected = flow.id;
      formOpen = false;
      render();
    });
    list.append(button);
  }
  text($('flow-count'), state.flows.length);
}

function renderDetail(flow) {
  const result = resultFor(flow.id);
  text($('detail-id'), flow.id);
  text($('detail-name'), flow.name);
  text($('detail-meta'), `${flow.startUrl}  ·  ${new Date(flow.createdAt).toLocaleDateString()}`);
  text($('step-count'), `${flow.steps.length} STEP${flow.steps.length === 1 ? '' : 'S'}`);
  const tag = $('detail-status');
  tag.className = `status-tag ${result?.status || ''}`;
  text(tag, result ? result.status.toUpperCase() : 'NOT RUN');
  renderSteps($('detail-steps'), flow.steps, result?.steps);
  const banner = $('result-banner');
  banner.hidden = !result;
  banner.replaceChildren();
  if (result) {
    banner.className = `result-banner ${result.status}`;
    banner.append(element('strong', '', result.status === 'pass' ? 'Flow passed.' : 'Flow failed.'));
    banner.append(
      document.createTextNode(
        ` ${result.steps.filter((step) => step.status === 'pass').length}/${flow.steps.length} passed · ${result.durationMs} ms`,
      ),
    );
    if (result.screenshot) {
      const button = element('button', '', 'View screenshot');
      button.type = 'button';
      button.addEventListener('click', () => {
        void showScreenshot(flow.id);
      });
      banner.append(button);
    }
  }
  const area = $('error-area');
  area.hidden = !result?.errors.length;
  area.replaceChildren();
  if (result?.errors.length) {
    area.append(element('h3', '', 'BROWSER SIGNALS'));
    result.errors.forEach((error) => area.append(element('p', '', error)));
  }
}

function render() {
  if (!state) return;
  if (!selectedFlow() && state.flows.length) selected = state.flows[0].id;
  text($('project-path'), state.root);
  text($('workspace-label'), new URL(state.targetUrl).host.toUpperCase());
  $('watch-button').setAttribute('aria-pressed', String(state.watchEnabled));
  text($('watch-button').lastChild, state.watchEnabled ? ' Watching' : ' Watch changes');
  $('run-all-button').disabled =
    state.running || state.recording.active || state.recording.starting || !state.flows.length;
  $('run-one-button').disabled = state.running || state.recording.starting;
  $('new-button').disabled = state.running || state.recording.active || state.recording.starting;
  $('new-button').hidden = state.recording.active;
  $('save-button').disabled = state.recording.starting;
  $('discard-button').disabled = state.recording.starting;
  showNotice(lastError || state.message);
  renderFlows();
  const recording = state.recording.active;
  $('record-form').hidden = !formOpen || recording;
  $('recording-panel').hidden = !recording;
  $('empty-panel').hidden = recording || formOpen || Boolean(selectedFlow());
  $('detail-panel').hidden = recording || formOpen || !selectedFlow();
  if (recording) {
    text($('page-title'), 'Capture what works.');
    text($('recording-name'), state.recording.flow.name);
    renderSteps($('live-steps'), state.recording.flow.steps);
    if (state.recording.errors.length && !lastError) showNotice(state.recording.errors.at(-1));
  } else if (formOpen) {
    text($('page-title'), 'Start with one real path.');
  } else if (selectedFlow()) {
    text($('page-title'), 'Keep working paths working.');
    renderDetail(selectedFlow());
  } else {
    text($('page-title'), 'Keep working paths working.');
  }
}

async function refresh() {
  if (busy) return;
  busy = true;
  try {
    state = await api('/api/state');
    render();
  } catch (error) {
    notice(token ? error.message : 'Missing studio token. Open URL printed in terminal.');
  } finally {
    busy = false;
  }
}

async function action(path, method = 'POST', data) {
  try {
    notice('');
    const result = await api(path, method, data);
    await refresh();
    return result;
  } catch (error) {
    notice(error.message);
    return null;
  }
}

async function showScreenshot(id) {
  try {
    const response = await api(`/api/screenshot/${encodeURIComponent(id)}`);
    const blob = await response.blob();
    if (modalUrl) URL.revokeObjectURL(modalUrl);
    modalUrl = URL.createObjectURL(blob);
    $('failure-image').src = modalUrl;
    $('image-modal').hidden = false;
  } catch (error) {
    notice(error.message);
  }
}

function openForm() {
  formOpen = true;
  $('flow-url').value = state?.targetUrl || '';
  render();
  $('flow-name').focus();
}

$('new-button').addEventListener('click', openForm);
$('empty-record').addEventListener('click', openForm);
$('form-close').addEventListener('click', () => {
  formOpen = false;
  render();
});
$('start-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const result = await action('/api/record/start', 'POST', {
    name: $('flow-name').value,
    url: $('flow-url').value,
  });
  if (result) {
    formOpen = false;
    $('flow-name').value = '';
    await refresh();
  }
});
$('text-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const value = $('text-check').value;
  if (await action('/api/record/text', 'POST', { text: value })) $('text-check').value = '';
});
$('save-button').addEventListener('click', async () => {
  const result = await action('/api/record/stop');
  if (result?.flow) {
    selected = result.flow.id;
    await refresh();
  }
});
$('discard-button').addEventListener('click', () => {
  void action('/api/record/discard');
});
$('run-all-button').addEventListener('click', () => {
  void action('/api/run', 'POST', {});
});
$('run-one-button').addEventListener('click', () => {
  if (selected) void action('/api/run', 'POST', { id: selected });
});
$('watch-button').addEventListener('click', () => {
  void action('/api/watch', 'POST', { enabled: !state.watchEnabled });
});
$('delete-button').addEventListener('click', async () => {
  const flow = selectedFlow();
  if (!flow || !confirm(`Delete “${flow.name}”?`)) return;
  if (await action(`/api/flows/${encodeURIComponent(flow.id)}`, 'DELETE')) {
    selected = undefined;
    await refresh();
  }
});
$('image-close').addEventListener('click', () => {
  $('image-modal').hidden = true;
});
$('image-modal').addEventListener('click', (event) => {
  if (event.target === $('image-modal')) $('image-modal').hidden = true;
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') $('image-modal').hidden = true;
});
await refresh();
setInterval(() => {
  void refresh();
}, 1200);
// Kofu
