<script lang="ts">
  import Toast from "./Toast.svelte";
  import { toastStore } from "$lib/stores/toast.svelte";
</script>

<!--
  Toast Container
  Position: bottom-right
  Stacks toasts vertically with newest at bottom
  Doesn't block editor or terminal (pointer-events: none on container)
-->
<div class="toast-container" aria-label="Notifications">
  {#each toastStore.toasts as toast (toast.id)}
    <Toast {toast} />
  {/each}
</div>

<style>
  .toast-container {
    position: fixed;
    bottom: 40px; /* Above status bar */
    left: 16px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none; /* Allow clicks through container */
    max-height: calc(100vh - 100px);
    overflow: hidden;
  }
</style>
