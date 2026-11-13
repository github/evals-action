import * as core from '@actions/core';
import { comparisonFailureMessage, runComparisonAction } from './comparison-action.js';

runComparisonAction().catch((error: unknown) => core.setFailed(comparisonFailureMessage(error)));
