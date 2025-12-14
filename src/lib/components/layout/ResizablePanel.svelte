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
    position: relative;
    z-index: 10;
  }

  /* Invisible hit area for easier grabbing */
  .resizer::before {
    content: '';
    position: absolute;
  }

  /* Visible line indicator */
  .resizer::after {
    content: '';
    position: absolute;
    background: transparent;
    transition: background-color 0.1s ease;
  }

  .resizer:hover::after,
  .resizer.dragging::after {
    background: var(--color-accent);
  }

  .resizer:focus-visible {
    outline: none;
  }

  .resizer:focus-visible::after {
    background: var(--color-accent);
  }

  /* Horizontal resizer (sidebar) */
  .resizer.horizontal {
    width: 4px;
    cursor: col-resize;
    margin-left: -2px;
  }

  .resizer.horizontal::before {
    inset: 0 -2px;
  }

  .resizer.horizontal::after {
    top: 0;
    bottom: 0;
    left: 50%;
    width: 1px;
    transform: translateX(-50%);
  }

  /* Vertical resizer (bottom panel) */
  .resizer.vertical {
    height: 4px;
    cursor: row-resize;
    margin-top: -2px;
  }

  .resizer.vertical::before {
    inset: -2px 0;
  }

  .resizer.vertical::after {
    left: 0;
    right: 0;
    top: 50%;
    height: 1px;
    transform: translateY(-50%);
  }
</style>
