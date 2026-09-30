const fs = require('node:fs');
const path = require('node:path');
const { workspace } = require('vscode');
const { LanguageClient } = require('vscode-languageclient/node');

/**
 * Thin LSP client: starts `grhm lsp` for the workspace and lets the server
 * provide diagnostics, hover, completion, definitions, references, rename,
 * and formatting.
 */

let client;

function serverCommand(workspaceRoot) {
  const configured = workspace.getConfiguration('grhm').get('serverPath');
  if (typeof configured === 'string' && configured.length > 0) {
    return { command: configured, args: ['lsp'] };
  }
  if (workspaceRoot !== undefined) {
    const local = path.join(workspaceRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'grhm.cmd' : 'grhm');
    if (fs.existsSync(local)) return { command: local, args: ['lsp'] };
  }
  return { command: 'npx', args: ['grhm', 'lsp'] };
}

function activate(context) {
  const root = workspace.workspaceFolders?.[0]?.uri.fsPath;
  const { command, args } = serverCommand(root);
  client = new LanguageClient(
    'grhm',
    'GRHM Language Server',
    { command, args, options: { cwd: root } },
    { documentSelector: [{ language: 'grhm' }] },
  );
  client.start();
  context.subscriptions.push({ dispose: () => client?.stop() });
}

function deactivate() {
  return client?.stop();
}

module.exports = { activate, deactivate };
