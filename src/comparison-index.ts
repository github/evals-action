import * as core from '@actions/core';
import { runComparisonAction } from './comparison-action.js';
import { ComparisonError } from './comparison-context.js';

runComparisonAction().catch((error: unknown) =>
  core.setFailed(`Comparison failed: ${error instanceof ComparisonError ? error.code : 'comparison-operation-failed'}. No evaluation pass is claimed.`));
