/**
 * Pipeline state management — CRUD for pipeline.json.
 *
 * Tracks which stage the processing pipeline is at for a given collection,
 * enabling resume after interruption.
 */

import type { FileIO } from "../agents/scene-manager.js";
import { processingPaths } from "./processing-paths.js";
import type { PipelineStage, PipelineState } from "./processing-types.js";

/** Ordered stages for advancement. */
const STAGE_ORDER: PipelineStage[] = [
  "classifier",
  "extractors",
  "merge",
  "index",
  "rule-card",
  "complete",
];

/**
 * Create a fresh pipeline state.
 */
export function createPipelineState(collectionSlug: string): PipelineState {
  return {
    collectionSlug,
    currentStage: "classifier",
    updatedAt: new Date().toISOString(),
    stageData: {},
    batchIds: [],
  };
}

/**
 * Load pipeline state from disk. Returns null if not found.
 */
export async function loadPipelineState(
  io: FileIO,
  homeDir: string,
  collectionSlug: string,
): Promise<PipelineState | null> {
  const paths = processingPaths(homeDir, collectionSlug);
  if (!(await io.exists(paths.pipelineState))) return null;
  const raw = await io.readFile(paths.pipelineState);
  return JSON.parse(raw) as PipelineState;
}

/**
 * Save pipeline state to disk.
 */
export async function savePipelineState(
  io: FileIO,
  homeDir: string,
  state: PipelineState,
): Promise<void> {
  const paths = processingPaths(homeDir, state.collectionSlug);
  // Ensure base directory exists
  await io.mkdir(paths.base);
  state.updatedAt = new Date().toISOString();
  await io.writeFile(paths.pipelineState, JSON.stringify(state, null, 2));
}

/**
 * Advance pipeline to the next stage. Returns the new stage.
 * Throws if already at "complete".
 */
export function advanceStage(state: PipelineState): PipelineStage {
  const idx = STAGE_ORDER.indexOf(state.currentStage);
  if (idx === -1 || idx >= STAGE_ORDER.length - 1) {
    throw new Error(`Cannot advance past stage: ${state.currentStage}`);
  }
  state.currentStage = STAGE_ORDER[idx + 1];
  return state.currentStage;
}

/**
 * Check if the pipeline has reached or passed a given stage.
 */
export function hasReachedStage(state: PipelineState, stage: PipelineStage): boolean {
  return STAGE_ORDER.indexOf(state.currentStage) >= STAGE_ORDER.indexOf(stage);
}

/**
 * Get the stage order index (for comparison).
 */
export function stageIndex(stage: PipelineStage): number {
  return STAGE_ORDER.indexOf(stage);
}
