#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const project = path.resolve(here, '..');
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(project, 'dist/index.js'), '--stdio'],
  cwd: project,
  stderr: 'pipe',
  env: process.env,
});
const client = new Client({ name: 'chat-unleashed-surface-test', version: '1.0.0' });
await client.connect(transport);

const deferred = [
  'pages_inspect', 'pages_verify', 'pages_styles', 'pages_find', 'pages_stats', 'pages_objects',
  'pages_duplicate', 'pages_text_layout', 'pages_document_layout', 'pages_section_layout',
  'iwork_ui_control', 'iwork_arrange', 'iwork_apps', 'iwork_document', 'iwork_shapes', 'iwork_script',
  'numbers_inspect', 'numbers_verify', 'numbers_find', 'numbers_stats', 'keynote_notes', 'keynote_inspect',
  'keynote_verify', 'keynote_find', 'keynote_stats', 'keynote_image_slides',
];

const { tools } = await client.listTools();
const names = new Set(tools.map((tool) => tool.name));
if (tools.length !== 90) throw new Error(`expected 90 public tools, got ${tools.length}`);

for (const required of [
  'run_command', 'write_file', 'read_file', 'web', 'screen_observe', 'ui_do',
  'task_plan', 'task_run', 'capability_search', 'capability_call',
]) {
  if (!names.has(required)) throw new Error(`missing public tool ${required}`);
}
for (const name of deferred) {
  if (names.has(name)) throw new Error(`deferred capability leaked into tools/list: ${name}`);
}

for (const name of deferred) {
  const result = await client.callTool({
    name: 'capability_search',
    arguments: { query: name, limit: 1 },
  });
  const text = (result.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
  if (!text.includes(`${name} -`) || !text.includes('arguments schema:')) {
    throw new Error(`deferred capability is not discoverable with schema: ${name}\n${text.slice(0, 500)}`);
  }
}

const invalid = await client.callTool({
  name: 'capability_call',
  arguments: { name: 'pages_duplicate', arguments: {} },
});
const invalidText = (invalid.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
if (!invalid.isError || !/invalid arguments for pages_duplicate/i.test(invalidText)) {
  throw new Error(`deferred capability did not preserve schema validation: ${invalidText.slice(0, 500)}`);
}

await client.close();
console.log('tool surface passed: 90 public tools, 26 deferred capabilities remain searchable, validated and callable');
