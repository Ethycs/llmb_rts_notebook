// PLAN-S7 §3.6 — Empty-state copy.
//
// Strings rendered when a tree has no data to show. Centralised here
// so tooltip wording stays consistent across the three trees and the
// tests can assert against a single source of truth.

export const ZONES_EMPTY = 'No .llmnb notebooks open in this workspace.';
export const AGENTS_EMPTY = 'No agents in the active notebook. Spawn one with @@spawn.';
export const ACTIVITY_EMPTY = 'No recent activity. Run a cell to see events here.';

/** Section-row stand-in shown under a zone whose `metadata.rts.zone.sections`
 *  dict is empty. */
export const ZONE_NO_SECTIONS = 'No sections — operators create them with @@section.';

/** Agent-row stand-in shown under a zone with no agents persisted yet. */
export const ZONE_NO_AGENTS = 'No agents in this zone.';
