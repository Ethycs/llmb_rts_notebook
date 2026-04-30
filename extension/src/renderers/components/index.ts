// Barrel re-exports for renderer components.
//
// Each export is the per-tool renderer named in the RFC-001 catalog. The
// run-renderer.ts dispatcher imports from this single barrel rather than
// reaching into each file individually.

export { renderNotify } from './notify.js';
export { renderRequestApproval, renderPropose, renderProposeEdit } from './approval.js';
export {
  renderReportProgress,
  renderReportCompletion,
  renderReportProblem
} from './progress.js';
export {
  renderAsk,
  renderClarify,
  renderPresent,
  renderEscalate
} from './conversational.js';
export {
  renderReadFile,
  renderWriteFile,
  renderRunCommand
} from './proxied.js';
export { renderAgentEmit } from './agent-emit.js';
export {
  renderContaminationBadge,
  bindContaminationBadgeHandlers,
  CONTAMINATION_BADGE_CLASS,
  CONTAMINATION_PANEL_CLASS,
  CONTAMINATION_RESET_BUTTON_CLASS,
  RESET_DATA_ATTR
} from './contamination-badge.js';
export type {
  ContaminationLogEntry,
  ContaminationBadgeProps
} from './contamination-badge.js';
export { escapeHtml, escapeAttr } from './escape.js';
