<script lang="ts">
  interface Props {
    direction: 'horizontal' | 'vertical';
    size: number;
    minSize?: number;
    maxSize?: number;
    onResize: (size: number) => void;
  }

  let { direction, size, minSize = 100, maxSize = 600, onResize }: Props = $props();

  let isDragging = $state(false);
  let startPos = $state(0);
  let startSize = $state(0);

  const step = 10;

  function handleMouseDown(e: MouseEvent) {
    isDragging = true;
    startPos = direction === 'horizontal' ? e.clientX : e.clientY;
    startSize = size;
    e.preventDefault();
  }

  function handleMouseMove(e: MouseEvent) {
    if (!isDragging) return;

    const currentPos = direction === 'horizontal' ? e.clientX : e.clientY;
    const rawDelta = currentPos - startPos;
    const delta = rawDelta;

    // For vertical resizers used above a bottom panel, dragging up should increase the panel height.
    const proposedSize = direction === 'horizontal' ? startSize + delta : startSize - delta;
    const newSize = Math.max(minSize, Math.min(maxSize, proposedSize));
    onResize(newSize);
  }

  function handleMouseUp() {
    isDragging = false;
  }

  function handleKeydown(e: KeyboardEvent) {
    if (direction === 'horizontal') {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onResize(Math.max(minSize, Math.min(maxSize, size - step)));
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        onResize(Math.max(minSize, Math.min(maxSize, size + step)));
      }
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      onResize(Math.max(minSize, Math.min(maxSize, size + step)));
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      onResize(Math.max(minSize, Math.min(maxSize, size - step)));
    }
  }

  $effect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
      document.body.style.userSelect = 'none';

      return () => {
        document.removeEventListener('mousemove', handleMouseMove);
        document.removeEventListener('mouseup', handleMouseUp);
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
      };
    }
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div
  class="resizer {direction}"
  class:dragging={isDragging}
  onmousedown={handleMouseDown}
  onkeydown={handleKeydown}
  role="separator"
  aria-orientation={direction}
  tabindex="0"
></div>

<style>
  .resizer {
    flex-shrink: 0;
    background: transparent;
    transition: background-color 0.15s ease;
    position: relative;
  }

  .resizer::after {
    content: '';
    position: absolute;
    inset: 0;
    background: transparent;
  }

  .resizer:hover,
  .resizer.dragging {
    background: var(--color-accent);
  }

  .resizer:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -1px;
  }

  .resizer.horizontal {
    width: 4px;
    cursor: col-resize;
  }

  .resizer.vertical {
    height: 4px;
    cursor: row-resize;
  }
</style>
