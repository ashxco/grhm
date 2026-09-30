import { examples } from './examples.js';
import { agentExample } from './agent-example.js';

const root = document.querySelector('#app');
const arrow = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M4 10h12m-5-5 5 5-5 5" stroke="currentColor" stroke-width="1.5"/></svg>';
const escape = (value) => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const DEMO = examples[0].source;
function highlight(source) {
  return source.split(/("(?:\\.|[^"\\])*"|;[^\n]*|:[a-z][\w-]*|\b\d+(?:\.\d+)?\b|[()])/g).map(token => {
    const type = token.startsWith('"') ? 'string' : token.startsWith(';') ? 'comment' : token.startsWith(':') ? 'keyword' : /^\d/.test(token) ? 'number' : /^[()]$/.test(token) ? 'paren' : '';
    return type ? `<span class="syntax-${type}">${escape(token)}</span>` : escape(token);
  }).join('');
}
function code(source, label = 'app.grhm') {
  return `<div class="code-block"><div class="code-bar"><span>${label}</span><button class="copy-button" data-copy aria-label="Copy ${escape(label)}">Copy</button></div><pre><code>${highlight(source)}</code></pre></div>`;
}
function header(section = '') {
  return `<header class="header"><a class="wordmark" href="/" aria-label="GRHM home">grhm<span aria-hidden="true">.</span></a><nav aria-label="Main navigation"><a href="/#language">Why GRHM</a><a href="/docs" ${section === 'docs' ? 'aria-current="page"' : ''}>Documentation</a><a href="/examples" ${section === 'examples' ? 'aria-current="page"' : ''}>Examples</a></nav><a class="header-start" href="/docs/agents">Agent guide ${arrow}</a></header>`;
}
function footer() {
  return `<footer class="footer"><a class="wordmark" href="/">grhm<span aria-hidden="true">.</span></a><span>A web language built for agents.</span><nav aria-label="Footer navigation"><a href="/docs">Documentation</a><a href="/docs/reference">Reference</a><a href="/docs/about">v0.2</a></nav></footer>`;
}
function home() {
  document.title = 'GRHM — A web language built for agents';
  document.querySelector('meta[name="description"]').content = 'A compact web language for coding agents. Schema-generated reference, structured diagnostics, stable node IDs, and revision-checked patches. Compiles to React, TypeScript, CSS, and Node.';
  const steps = [
    ['Read the program', 'A named node gives the agent a precise target. The interface stays in a compact, readable form.', agentExample.source, 'app.grhm'],
    ['Describe the edit', 'Change the grid from four columns to three. The patch names the target and the revision it expects.', agentExample.patch, 'change.grhm'],
    ['Validate the result', 'The compiler checks the patched project before accepting it. A stale revision or invalid result is rejected.', JSON.stringify(agentExample.result, null, 2), 'patch result.json'],
  ];
  root.innerHTML = header() + `<main id="main">
    <section class="hero wrap">
      <div class="hero-intro"><h1>A web language<br>built for <span>agents.</span></h1><div class="hero-description"><p>Give coding agents compact source, structured feedback, and precise edits the compiler can validate. GRHM turns the result into a working web application.</p><a class="button primary" href="/docs/agents">Build with an agent ${arrow}</a><a class="text-link" href="/language-reference.txt" download>Get the language reference</a></div></div>
      <div class="agent-stage">
        <div class="agent-code">${steps.map(([title,description,source,label],i)=>`<div id="edit-step-${i}" class="edit-panel" role="region" aria-label="${title}" ${i?'hidden':''}>${code(source,label)}</div>`).join('')}</div>
        <div class="agent-steps"><h2>One change.<br>Every step explicit.</h2><div class="edit-controls" role="group" aria-label="Explore the patch workflow">${steps.map(([title,description],i)=>`<button type="button" class="edit-step" data-step="${i}" aria-pressed="${i===0}" aria-controls="edit-step-${i}"><span>${title}</span><span>${description}</span>${arrow}</button>`).join('')}</div></div>
      </div>
      <p class="example-note">Explore an example verified by the local compiler. <a href="/docs/agents#patch">See the resulting source ${arrow}</a></p>
    </section>
    <section class="language-section wrap" id="language"><h2>Structure an agent<br>can work with.</h2><div class="language-detail"><p>GRHM is designed around the work an agent repeats: understand a program, make a focused change, and use compiler feedback to check it.</p><div class="feature-lines">
      <a href="/docs/agents#context"><span>A shared vocabulary</span><span>The reference comes from the same schema that drives validation. Give the agent the forms the compiler understands.</span>${arrow}</a>
      <a href="/docs/agents#inspect"><span>Stable targets</span><span>Inspect a node by ID. Formatting and unrelated edits preserve its identity, so changes do not depend on line numbers.</span>${arrow}</a>
      <a href="/docs/agents#repair"><span>Feedback made for repair</span><span>JSON diagnostics identify the error, its location, and suggested corrections where available.</span>${arrow}</a>
      <a href="/docs/agents#patch"><span>Edits with a precondition</span><span>Revision-checked patches reject stale changes and validate the whole project before writing source.</span>${arrow}</a>
    </div></div></section>
    <section class="app-section wrap"><div class="section-intro"><h2>Less wiring.<br>More application.</h2><div><p>State, events, and interface in one small program. The compiler handles the React wiring. Add tables and API routes in the same language when your app needs a server.</p><a class="text-link" href="/examples">Explore complete examples ${arrow}</a></div></div><div class="demo-stage"><div class="demo-source">${code(DEMO)}</div><div class="demo-preview"><div class="preview-bar"><span>Compiled React application</span><span class="preview-route">/</span></div><iframe class="compiled-demo" src="/demo/index.html" loading="lazy" title="Interactive counter compiled from GRHM"></iframe></div></div></section>
    <section class="output-section wrap"><div><h2>Review the code<br>that gets generated.</h2><p>GRHM compiles to readable React, TypeScript, CSS, and a standalone Node server. Your agent can build and test the output with ordinary development tools.</p><a class="text-link" href="/docs/output">Explore the output ${arrow}</a></div><div class="file-tree" aria-label="Generated application files"><div><span>src / gen</span></div><p><span>App.tsx</span><span>Routing and page loading</span></p><p><span>pages /</span><span>React page components</span></p><p><span>lib.ts</span><span>Shared functions</span></p><p><span>styles.css</span><span>Tokens and responsive styles</span></p><p><span>server.ts</span><span>HTTP API and SQLite</span></p></div></section>
    <section class="closing wrap"><h2>Give your agent the language.</h2><a class="button primary" href="/docs/agents">Read the agent guide ${arrow}</a></section>
  </main>` + footer();
  root.querySelectorAll('[data-step]').forEach(button => button.addEventListener('click', () => {
    root.querySelectorAll('[data-step]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    root.querySelectorAll('.edit-panel').forEach(panel => { panel.hidden = panel.id !== button.getAttribute('aria-controls'); });
  }));
}
let navigation = 0;
async function render() {
  const current = ++navigation;
  if (location.pathname === '/') home();
  else {
    const { renderContent } = await import('/content.js');
    if (current !== navigation) return;
    await renderContent({root, header, footer, code, escape, arrow, isCurrent: () => current === navigation});
  }
  if (current !== navigation) return;
  root.querySelectorAll('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(button.closest('.code-block').querySelector('code').textContent);
      const label = button.getAttribute('aria-label');
      button.textContent = 'Copied';
      button.setAttribute('aria-label', 'Copied to clipboard');
      setTimeout(() => { button.textContent = 'Copy'; button.setAttribute('aria-label', label); }, 1500);
    } catch { button.textContent = 'Select to copy'; }
  }));
}
document.addEventListener('click', async event => {
  const link = event.target.closest('a');
  if (!link || link.target || link.hasAttribute('download') || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin) return;
  if (url.pathname === location.pathname && url.hash) return;
  if (/\.[a-z]+$/.test(url.pathname)) return;
  event.preventDefault();
  history.pushState({}, '', url);
  await render();
  const main = document.getElementById('main');
  if (main) { main.tabIndex = -1; main.focus({preventScroll:true}); }
  if (url.hash) document.getElementById(url.hash.slice(1))?.scrollIntoView();
  else window.scrollTo(0, 0);
});
window.addEventListener('popstate', render);
render().then(() => {
  if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
});

export { DEMO, highlight };
