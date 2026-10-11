import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import { compile } from '../dist/codegen/index.js';

const root = await fs.mkdtemp(path.resolve('.grhm-browser-'));
let server;
let browser;
try {
  const output = compile(`(app keyboard
    (auth users)
    (api (get "/api/private" (obj :name "Guest")))
    (data (resource profile "/api/private"))
    (state opened false)
    (state selected "None")
    (state nested true)
    (state ev "destination")
    (page "/" home
      (tabs (tab "Alpha" (txt "First panel")) (tab "Beta" (txt "Second panel")))
      (menu "Actions" (item "Apple" (set selected "Apple")) (item "Banana" (set selected "Banana")))
      (txt selected)
      (txt (json-stringify profile.data))
      (btn "Sign out" (click (send post "/api/auth/logout")))
      (btn "Open dialog" (click (set opened true)))
      (link "Broken page" :to "/broken")
      (dialog :open opened :title "Settings" (btn "Last control") (btn "Disabled control" :disabled true))
      (link "Other page" :to (path "/other/{id}" :id ev)))
    (page "/other/{id}" other (txt "Other content"))
    (page "/broken" broken (txt (json-parse (concat "" "{"))))
    (page "/nested" nested-page
      (btn "Open parent" (click (set opened true)))
      (dialog :open opened :title "Parent" (btn "Parent control")
        (dialog :open nested :title "Child" (btn "Child control")))))`);
  assert.deepEqual(output.diagnostics.filter((d) => d.severity === 'error'), []);
  for (const [file, content] of output.files) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  await fs.writeFile(path.join(root, 'index.html'), '<!doctype html><html lang="en"><title>Keyboard tests</title><main id="root"></main><script type="module" src="/main.tsx"></script>');
  await fs.writeFile(path.join(root, 'main.tsx'), `import React from 'react';
    import { createRoot } from 'react-dom/client'; import { App } from './App';
    import './styles.css'; createRoot(document.getElementById('root')!).render(<App/>);`);
  server = await createServer({ root, configFile: false, server: { host: '127.0.0.1', port: 0 }, esbuild: { jsx: 'automatic' } });
  await server.listen();
  browser = await chromium.launch();
  const context = await browser.newContext();
  let account = 'Alice';
  await context.route('**/api/private', (route) => route.fulfill({ json: { name: account } }));
  await context.route('**/api/auth/logout', (route) => { account = 'Guest'; return route.fulfill({ json: { ok: true } }); });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(server.resolvedUrls.local[0]);
  const audit = async () => {
    const results = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(results.violations.filter((item) => ['serious', 'critical'].includes(item.impact)), []);
  };
  const alpha = page.getByRole('tab', { name: 'Alpha' });
  const beta = page.getByRole('tab', { name: 'Beta' });
  await expect(alpha).toBeVisible();
  await audit();
  await alpha.focus();
  await page.keyboard.press('ArrowRight');
  await expect(beta).toBeFocused();
  await expect(beta).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tabpanel')).toHaveAccessibleName('Beta');
  await page.keyboard.press('Home');
  await expect(alpha).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(beta).toBeFocused();
  const actions = page.getByRole('button', { name: 'Actions' });
  await actions.focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByRole('menuitem', { name: 'Banana' })).toBeFocused();
  await page.keyboard.press('Home');
  await expect(page.getByRole('menuitem', { name: 'Apple' })).toBeFocused();
  await page.keyboard.press('b');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(actions).toBeFocused();
  await expect(page.getByText('Banana', { exact: true })).toBeVisible();
  await actions.click();
  await page.keyboard.press('Escape');
  await expect(actions).toBeFocused();
  await actions.click();
  await page.keyboard.press('Tab');
  const opener = page.getByRole('button', { name: 'Open dialog' });
  await expect(page.getByRole('button', { name: 'Sign out' })).toBeFocused();
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'Settings' });
  await expect(dialog).toBeVisible();
  await audit();
  const close = page.getByRole('button', { name: 'Close dialog' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Last control' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  await expect(actions).toBeEnabled();
  await page.getByRole('link', { name: 'Other page' }).click();
  await expect(page).toHaveURL(/\/other\/destination$/);
  await expect(page.getByText('Other content')).toBeVisible();
  await page.goBack();
  await expect(alpha).toBeVisible();
  const otherTab = await context.newPage();
  await otherTab.goto(server.resolvedUrls.local[0]);
  await expect(otherTab.getByText('{"name":"Alice"}', { exact: true })).toBeVisible();
  await expect(page.getByText('{"name":"Alice"}', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('{"name":"Guest"}', { exact: true })).toBeVisible();
  await expect(otherTab.getByText('{"name":"Guest"}', { exact: true })).toBeVisible();
  await expect(otherTab.getByText('{"name":"Alice"}', { exact: true })).toHaveCount(0);
  await page.goto(new URL('/nested', server.resolvedUrls.local[0]).href);
  await page.getByRole('button', { name: 'Open parent' }).click();
  await expect(page.getByRole('dialog', { name: 'Child', exact: true }).getByRole('button', { name: 'Close dialog' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.getByRole('button', { name: 'Child control' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Child', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Open parent' })).toBeFocused();
  assert.deepEqual(errors, []);
  await page.goto(server.resolvedUrls.local[0]);
  await page.getByRole('link', { name: 'Broken page' }).click();
  await expect(page.getByRole('alert')).toHaveText(/This page could not load/);
  await expect(page.getByRole('button', { name: 'Reload page' })).toBeVisible();
  await page.goBack();
  await expect(alpha).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  console.log('Browser regressions passed: tabs, menus, modal focus, history routing, cross-tab session invalidation, accessibility audits.');
} finally {
  await browser?.close();
  await server?.close();
  await fs.rm(root, { recursive: true, force: true });
}
