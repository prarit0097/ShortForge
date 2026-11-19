'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { configuredAutomation, publicError } = require('./automation');
const { analyzeInput, renderInput, jobInput } = require('./schemas');
const { version } = require('../../package.json');

function reply(value, isError = false) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError };
}

async function main() {
  const automation = await configuredAutomation();
  const server = new McpServer({ name: 'ShortForge', version });
  function tool(name, description, inputSchema, execute, annotations = {}) {
    server.registerTool(name, { description, inputSchema, annotations: { ...annotations, openWorldHint: false } }, (input) => {
      try {
        return reply(execute(input));
      } catch (error) {
        return reply({ error: publicError(error) }, true);
      }
    });
  }
  tool('analyze_video', 'Plan coverage or gameplay highlights for a local recording. Returns a job ID.',
    analyzeInput, automation.analyzeVideo, { readOnlyHint: true });
  tool('get_job', 'Read a job state, stage, percentage, and result metadata.',
    jobInput, ({ jobId }) => automation.getJob(jobId), { readOnlyHint: true });
  tool('render_clips', 'Render selected segment IDs to the configured local output folder. Returns a job ID.',
    renderInput, automation.renderClips, { destructiveHint: false, idempotentHint: false });
  tool('cancel_job', 'Request cancellation of a queued or running ShortForge job.',
    jobInput, ({ jobId }) => automation.cancelJob(jobId), { idempotentHint: true });

  function shutdown() {
    automation.close();
    void server.close().catch(() => {});
  }
  process.stdin.once('end', shutdown);
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  await server.connect(new StdioServerTransport());
}

main().catch((error) => {
  process.stderr.write(`ShortForge MCP: ${publicError(error).message}\n`);
  process.exitCode = 1;
});
