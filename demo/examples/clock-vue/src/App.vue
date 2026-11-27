<script setup lang="ts">
import { inject, onMounted, onUnmounted, ref } from "vue";
import type { HostApi } from "@vibe/plugin-contracts/sdk";

// The typed hostAPI arrives from mount() by injection, not from the DOM.
const host = inject<HostApi>("host")!;

const now = ref(new Date());
const mode = ref("dark");
let timer: number | undefined;

// The stylesheet keys on <html data-theme>: the whole page follows the host.
const onTheme = (value: unknown): void => {
  const next =
    typeof value === "object" && value !== null && "mode" in value
      ? String((value as { mode: unknown }).mode)
      : String(value);
  document.documentElement.dataset.theme = next;
  mode.value = next;
};

const notify = (): void => {
  void host.notify.show({ level: "info", message: "Hello from Vue" });
};

onMounted(() => {
  timer = window.setInterval(() => {
    now.value = new Date();
  }, 1000);
  void host.theme.get().then(onTheme).catch(() => undefined);
  host.on("theme.changed", onTheme);
});

onUnmounted(() => {
  if (timer !== undefined) window.clearInterval(timer);
  host.off("theme.changed", onTheme);
});
</script>

<template>
  <div class="clock-inner">
    <header class="clock-header">
      <span class="clock-version">clock-vue 1.0.0</span>
      <span class="clock-mode">theme: {{ mode }}</span>
    </header>
    <div class="clock-panel">
      <div class="clock-time">{{ now.toLocaleTimeString() }}</div>
      <div class="clock-date">
        {{ now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) }}
      </div>
    </div>
    <button type="button" class="clock-notify" @click="notify">Notify host</button>
  </div>
</template>
