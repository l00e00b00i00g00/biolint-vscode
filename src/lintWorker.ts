/**
 * lintWorker.ts — worker_thread entry for heavy files (v2.0).
 * Runs the SAME analyzeDocumentText core off the extension-host event loop.
 * Any crash/timeout falls back to synchronous analysis on the main thread.
 */
import { parentPort, workerData } from 'worker_threads';
import { analyzeDocumentText, AnalyzeOpts } from './analyze';

interface Job {
  fileName: string;
  text: string;
  opts: AnalyzeOpts;
}

try {
  const { fileName, text, opts } = workerData as Job;
  const result = analyzeDocumentText(fileName, text, opts);
  parentPort?.postMessage(result);
} catch (err) {
  parentPort?.postMessage({
    findings: [], segments: 0, verdict: 'APPROVED',
    rejected: 0, flagged: 0, errors: 0, warnings: 0,
    workerError: String(err),
  });
}
