import * as core from '@actions/core';
import { comparisonErrorCode, runComparisonAction } from './comparison-action.js';

runComparisonAction().catch((error: unknown) =>
  core.setFailed(`Comparison failed: ${comparisonErrorCode(error, 'comparison-operation-failed')}. No evaluation pass is claimed.`));
