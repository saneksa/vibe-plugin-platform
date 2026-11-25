/** Portable conformance surface: DOM-free core, browser rig and in-memory fakes. */

export type { ConformanceResult, CoreConformanceOptions } from "./core.js";
export { runCoreConformance } from "./core.js";
export type { ConformanceOptions, TwoOrigins } from "./rig.js";
export { runConformance, startTwoOrigins } from "./rig.js";
export { FixtureAdapter } from "./fixtures/adapter.js";
export {
  FakeFrameHost,
  FakeFrameSource,
  FakeScheduler,
  MemoryStore,
  RecordingAdapter,
  sentOf,
} from "./fakes.js";
export type { FakeTimer } from "./fakes.js";
