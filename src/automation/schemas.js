'use strict';

const { z } = require('zod');
const { ASPECT_RATIOS, DEFAULTS } = require('../main/constants');
const { AutomationError } = require('./errors');

const MAX_PLAN_CLIPS = 1000;
const analysisFields = {
  source: z.string().min(1).max(1024).describe('A video path relative to the configured input folder.'),
  mode: z.enum(['coverage', 'gameplay']).default('coverage'),
  scanMode: z.enum(['accurate', 'fast']).default('accurate'),
  targetLengthSec: z.number().min(5).max(120).default(DEFAULTS.targetLengthSec),
  minLengthSec: z.number().min(5).max(120).default(DEFAULTS.minLengthSec),
  maxLengthSec: z.number().min(5).max(120).default(DEFAULTS.maxLengthSec),
  sceneThreshold: z.number().min(0.1).max(0.9).default(DEFAULTS.sceneThreshold),
};

const jobInput = z.strictObject({ jobId: z.uuid() });
const analyzeInput = z.strictObject(analysisFields).refine(
  ({ minLengthSec, targetLengthSec, maxLengthSec }) => minLengthSec <= targetLengthSec && targetLengthSec <= maxLengthSec,
  { message: 'Clip lengths must satisfy minimum ≤ target ≤ maximum.' },
);
const renderInput = z.strictObject({
  analysisId: z.uuid(),
  segmentIds: z.array(z.string().regex(/^segment-[1-9]\d{0,3}-[a-f0-9]{12}$/)).min(1).max(20)
    .refine((ids) => ids.length === new Set(ids).size, { message: 'Select each segment once.' }),
  aspectRatio: z.enum(Object.keys(ASPECT_RATIOS)).default(DEFAULTS.aspectRatio),
  reframeMode: z.enum(['crop', 'blur']).default(DEFAULTS.reframeMode),
  outputQuality: z.enum(['balanced', 'high', 'max']).default(DEFAULTS.outputQuality),
});

function validated(schema, args) {
  const result = schema.safeParse(args);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue?.path[0];
    const knownFields = ['jobId', 'analysisId', 'segmentIds', 'aspectRatio', 'reframeMode', 'outputQuality', ...Object.keys(analysisFields)];
    const message = issue?.code === 'custom' ? issue.message
      : knownFields.includes(field) ? `Check the ${field} option.` : 'The automation arguments are invalid.';
    throw new AutomationError('INVALID_ARGS', message);
  }
  return result.data;
}

module.exports = { MAX_PLAN_CLIPS, analyzeInput, renderInput, jobInput, validated };
