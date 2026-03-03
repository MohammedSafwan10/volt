<script lang="ts">
  /**
   * VirtualList - A high-performance virtualized list component
   * 
   * Renders only visible items plus overscan for smooth scrolling.
   * Supports fixed row heights for optimal performance.
   * Includes keyboard navigation (arrow keys, Home, End, Page Up/Down).
   * 
   * Based on VS Code's virtual list implementation pattern.
   */
  import type { Snippet } from 'svelte';

  interface Props<T> {
    /** Array of items to render */
    items: T[];
    /** Height of each row in pixels */
    rowHeight: number;
    /** Number of extra items to render above/below viewport */
    overscan?: number;
    /** Optional class for the container */
    class?: string;
    /** Snippet to render each item */
    children: Snippet<[{ item: T; index: number; style: string; focused: boolean }]>;
    /** Optional key function to generate unique keys */
    getKey?: (item: T, index: number) => string | number;
    /** Optional callback when scroll position changes */
    onScroll?: (scrollTop: number) => void;
    /** Optional callback when focused index changes via keyboard */
    onFocusChange?: (index: number) => void;
    /** Optional callback when Enter is pressed on focused item */
    onSelect?: (index: number, item: T) => void;
    /** Externally controlled focused index (-1 for none) */
    focusedIndex?: number;
  }

  let {
    items,
    rowHeight,
    overscan = 5,
    class: className = '',
    children,
    getKey = (_item, index) => index,
    onScroll,
    onFocusChange,
    onSelect,
    focusedIndex = -1,
    ...rest
  }: Props<any> & Record<string, unknown> = $props();

  let scrollEl: HTMLDivElement | null = $state(null);
  let scrollTop = $state(0);
  let viewportHeight = $state(0);
  
  // Internal focused index when not externally controlled
  let internalFocusedIndex = $state(-1);
  
  // Use external focusedIndex if provided, otherwise internal
  const activeFocusIndex = $derived(focusedIndex >= 0 ? focusedIndex : internalFocusedIndex);

  // Calculate total height of all items
  const totalHeight = $derived(items.length * rowHeight);

  // Calculate visible range with overscan
  const startIndex = $derived(Math.max(0, Math.floor(scrollTop / rowHeight) - overscan));
  const endIndex = $derived.by(() => {
    const effectiveHeight = Math.max(viewportHeight, 100);
    return Math.min(items.length, Math.ceil((scrollTop + effectiveHeight) / rowHeight) + overscan);
  });

  // Get visible items slice with their indices
  const visibleItems = $derived.by(() => {
    const result: Array<{ item: any; index: number }> = [];
    for (let i = startIndex; i < endIndex; i++) {
      if (items[i] !== undefined) {
        result.push({ item: items[i], index: i });
      }
    }
    return result;
  });

  function handleScroll(): void {
    if (!scrollEl) return;
    scrollTop = scrollEl.scrollTop;
    onScroll?.(scrollTop);
  }

  /**
   * Handle keyboard navigation (VS Code-style)
   */
  function handleKeydown(e: KeyboardEvent): void {
    if (items.length === 0) return;

    const currentIndex = activeFocusIndex;
    let newIndex = currentIndex;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        newIndex = currentIndex < 0 ? 0 : Math.min(currentIndex + 1, items.length - 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        newIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
        break;
      case 'Home':
        e.preventDefault();
        newIndex = 0;
        break;
      case 'End':
        e.preventDefault();
        newIndex = items.length - 1;
        break;
      case 'PageDown':
        e.preventDefault();
        {
          const pageSize = Math.floor(viewportHeight / rowHeight);
          newIndex = Math.min(currentIndex + pageSize, items.length - 1);
        }
        break;
      case 'PageUp':
        e.preventDefault();
        {
          const pageSize = Math.floor(viewportHeight / rowHeight);
          newIndex = Math.max(currentIndex - pageSize, 0);
        }
        break;
      case 'Enter':
      case ' ':
        if (currentIndex >= 0 && currentIndex < items.length) {
          e.preventDefault();
          onSelect?.(currentIndex, items[currentIndex]);
        }
        return;
      default:
        return;
    }

    if (newIndex !== currentIndex) {
      if (focusedIndex < 0) {
        // Internal control
        internalFocusedIndex = newIndex;
      }
      onFocusChange?.(newIndex);
      ensureVisible(newIndex);
    }
  }

  // Track viewport size changes
  $effect(() => {
    if (!scrollEl) return;

    viewportHeight = scrollEl.clientHeight;
    const ro = new ResizeObserver(() => {
      if (!scrollEl) return;
      viewportHeight = scrollEl.clientHeight;
    });
    ro.observe(scrollEl);

    return () => ro.disconnect();
  });

  // Clamp scroll position when the list shrinks to avoid blank space
  $effect(() => {
    if (!scrollEl) return;
    const maxScrollTop = Math.max(0, totalHeight - scrollEl.clientHeight);
    if (scrollEl.scrollTop > maxScrollTop) {
      scrollEl.scrollTop = maxScrollTop;
      scrollTop = scrollEl.scrollTop;
      onScroll?.(scrollTop);
    }
  });

  /**
   * Scroll to a specific index
   */
  export function scrollToIndex(index: number, behavior: ScrollBehavior = 'auto'): void {
    if (!scrollEl) return;
    const targetTop = index * rowHeight;
    scrollEl.scrollTo({ top: targetTop, behavior });
  }

  /**
   * Ensure an index is visible (scroll if needed)
   */
  export function ensureVisible(index: number): void {
    if (!scrollEl) return;
    const targetTop = index * rowHeight;
    const targetBottom = targetTop + rowHeight;
    const viewTop = scrollEl.scrollTop;
    const viewBottom = viewTop + scrollEl.clientHeight;

    if (targetTop < viewTop) {
      scrollEl.scrollTop = targetTop;
    } else if (targetBottom > viewBottom) {
      scrollEl.scrollTop = targetBottom - scrollEl.clientHeight;
    }
  }

  /**
   * Get the scroll container element
   */
  export function getScrollElement(): HTMLDivElement | null {
    return scrollEl;
  }

  /**
   * Get current scroll position
   */
  export function getScrollTop(): number {
    return scrollTop;
  }

  /**
   * Set focused index programmatically
   */
  export function setFocusedIndex(index: number): void {
    if (focusedIndex < 0) {
      internalFocusedIndex = index;
    }
    onFocusChange?.(index);
  }

  /**
   * Get current focused index
   */
  export function getFocusedIndex(): number {
    return activeFocusIndex;
  }

  /**
   * Focus the list container for keyboard navigation
   */
  export function focus(): void {
    scrollEl?.focus();
  }
</script>

<div
  {...rest}
  class="virtual-list {className}"
  bind:this={scrollEl}
  onscroll={handleScroll}
  onkeydown={handleKeydown}
  tabindex="0"
  role="listbox"
>
  <div class="virtual-list-spacer" style="height: {totalHeight}px">
    {#each visibleItems as { item, index } (getKey(item, index))}
      {@const style = `position: absolute; top: ${index * rowHeight}px; left: 0; right: 0; height: ${rowHeight}px;`}
      {@const focused = index === activeFocusIndex}
      {@render children({ item, index, style, focused })}
    {/each}
  </div>
</div>

<style>
  .virtual-list {
    overflow-y: auto;
    overflow-x: hidden;
    position: relative;
    flex: 1;
    min-height: 0;
    outline: none;
  }

  .virtual-list:focus-visible {
    outline: 1px solid var(--color-accent);
    outline-offset: -1px;
  }

  .virtual-list-spacer {
    position: relative;
    width: 100%;
  }
</style>
