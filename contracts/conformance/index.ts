/** Portable conformance surface: DOM-free core plus its in-memory fakes. */

export type { ConformanceResult, CoreConformanceOptions } from "./core.js";
export { runCoreConformance } from "./core.js";
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
