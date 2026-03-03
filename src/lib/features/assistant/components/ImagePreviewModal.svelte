<script lang="ts">
  import { UIIcon } from "$shared/components/ui";

  interface Props {
    src: string;
    alt: string;
    onClose: () => void;
  }

  let { src, alt, onClose }: Props = $props();

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") onClose();
  }

  function handleBackdropClick(e: MouseEvent): void {
    if ((e.target as HTMLElement).classList.contains("image-preview-modal")) {
      onClose();
    }
  }
</script>

<div
  class="image-preview-modal"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
  role="dialog"
  aria-modal="true"
  aria-label="Image preview"
  tabindex="-1"
>
  <div class="preview-content">
    <button class="preview-close" onclick={onClose} title="Close (Esc)" aria-label="Close preview" type="button">
      <UIIcon name="close" size={18} />
    </button>
    <img {src} {alt} class="preview-image" />
    <div class="preview-filename">{alt}</div>
  </div>
</div>

<style>
  .image-preview-modal {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.85);
    z-index: 1000;
    animation: fadeIn 0.2s ease;
    backdrop-filter: blur(4px);
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .preview-content {
    position: relative;
    max-width: 90vw;
    max-height: 90vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    animation: scaleIn 0.2s ease;
  }

  @keyframes scaleIn {
    from { opacity: 0; transform: scale(0.95); }
    to { opacity: 1; transform: scale(1); }
  }

  .preview-close {
    position: absolute;
    top: -40px;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.1);
    color: white;
    transition: all 0.15s ease;
  }

  .preview-close:hover {
    background: rgba(255, 255, 255, 0.2);
    transform: scale(1.1);
  }

  .preview-image {
    max-width: 90vw;
    max-height: 80vh;
    object-fit: contain;
    border-radius: 8px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.5);
  }

  .preview-filename {
    margin-top: 12px;
    font-size: 12px;
    color: rgba(255, 255, 255, 0.7);
    text-align: center;
  }
</style>
