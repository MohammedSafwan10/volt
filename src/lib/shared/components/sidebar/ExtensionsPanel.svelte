<script lang="ts">
  import { UIIcon } from '$shared/components/ui';
</script>

<div class="extensions-panel">
  <div class="empty-state">
    <div class="empty-icon">
      <UIIcon name="extensions" size={48} />
    </div>
    <h3>Extensions</h3>
    <p>Extension support coming soon</p>
    <p class="hint">Browse and install extensions to add new features</p>
  </div>
</div>

<style>
  .extensions-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 16px;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    flex: 1;
    text-align: center;
    color: var(--color-text-secondary);
  }

  .empty-icon {
    opacity: 0.3;
    margin-bottom: 12px;
  }

  h3 {
    margin: 0 0 4px 0;
    font-size: 14px;
    font-weight: 500;
    color: var(--color-text);
  }

  p {
    margin: 0;
    font-size: 12px;
  }

  .hint {
    margin-top: 8px;
    font-size: 11px;
    opacity: 0.7;
  }
</style>
