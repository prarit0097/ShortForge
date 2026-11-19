'use strict';

const { parseArgs } = require('node:util');
const { setTimeout: delay } = require('node:timers/promises');
const { configuredAutomation, publicError } = require('./automation');
const { AutomationError } = require('./errors');

const USAGE = [
  'Usage:',
  '  node src/automation/cli.js analyze <relative-source> [--mode coverage|gameplay] [--scan-mode accurate|fast]',
  '  node src/automation/cli.js render <relative-source> --segments <segment-id>[,<segment-id>] [--mode coverage|gameplay]',
  '    [--scan-mode accurate|fast] [--aspect-ratio 9:16] [--reframe-mode crop|blur] [--quality balanced|high|max]',
  'Coverage mode accepts --target-length, --min-length, --max-length, and --scene-threshold.',
  'Use the IDs from analyze and the same analysis options when rendering.',
  'Configure SHORTFORGE_INPUT_ROOT and SHORTFORGE_OUTPUT_ROOT as absolute local folder paths.',
].join('\n');

function parseCommand(args) {
  const stringOptions = ['mode', 'scan-mode', 'segments', 'aspect-ratio', 'reframe-mode', 'quality',
    'target-length', 'min-length', 'max-length', 'scene-threshold'];
  const options = Object.fromEntries(stringOptions.map((key) => [key, { type: 'string' }]));
  options.help = { type: 'boolean', short: 'h' };
  try {
    return parseArgs({ args, options, allowPositionals: true });
  } catch (_) {
    throw new AutomationError('INVALID_ARGS', 'Invalid command options. Run with --help for usage.');
  }
}

async function main(args) {
  const { values, positionals } = parseCommand(args);
  if (!args.length || values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  const [command, source] = positionals;
  const renderOnly = ['segments', 'aspect-ratio', 'reframe-mode', 'quality'];
  if (positionals.length !== 2 || !['analyze', 'render'].includes(command) ||
      (command === 'render' && !values.segments) ||
      (command === 'analyze' && renderOnly.some((key) => values[key] !== undefined))) {
    throw new AutomationError('INVALID_ARGS', 'Invalid command. Run with --help for usage.');
  }

  const automation = await configuredAutomation();
  let interrupted = false;
  const cancel = () => {
    interrupted = true;
    automation.close();
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const number = (key) => values[key] === undefined ? undefined : Number(values[key]);
  async function wait(jobId) {
    while (true) {
      const status = automation.getJob(jobId);
      if (['succeeded', 'failed', 'cancelled'].includes(status.state)) return status;
      await delay(25);
    }
  }

  try {
    const analysis = await wait(automation.analyzeVideo({
      source, mode: values.mode, scanMode: values['scan-mode'], targetLengthSec: number('target-length'),
      minLengthSec: number('min-length'), maxLengthSec: number('max-length'), sceneThreshold: number('scene-threshold'),
    }).jobId);
    let status = analysis;
    if (command === 'render' && analysis.state === 'succeeded' && !interrupted) {
      status = await wait(automation.renderClips({
        analysisId: analysis.jobId, segmentIds: values.segments.split(','), aspectRatio: values['aspect-ratio'],
        reframeMode: values['reframe-mode'], outputQuality: values.quality,
      }).jobId);
    }
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    if (interrupted || status.state === 'cancelled') process.exitCode = 130;
    else if (status.state !== 'succeeded' || ['failed', 'partial'].includes(status.result?.outcome)) process.exitCode = 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}

main(process.argv.slice(2)).catch((error) => {
  const { code, message } = publicError(error);
  process.stderr.write(`ShortForge CLI ${code}: ${message}\n`);
  process.exitCode = 1;
});
