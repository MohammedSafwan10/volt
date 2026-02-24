# Bundled ONNX Model Directory

Place the All-MiniLM-L6-v2 ONNX assets in this directory for offline bundled semantic indexing.

Expected runtime resolution order:
1. VOLT_SEMANTIC_ONNX_MODEL (override path)
2. bundled resources/models/all-MiniLM-L6-v2
3. fallback semantic embedding mode

If this folder is empty, fastembed may use its cache/download path depending on environment.
