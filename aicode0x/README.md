# aicode:0x

Fine-tuned Qwen2.5-Coder-1.5B for aibuilder-style app generation.

## Files

- `train_data.jsonl` — 20 training examples (prompt -> HTML/CSS/JS app)
- `aicode0x_finetune.ipynb` — Lightning AI notebook for QLoRA fine-tuning
- `Modelfile` — Ollama model definition
- `gen_train.js` — Regenerate training data (node gen_train.js)

## How to train (on Lightning AI)

1. Create a Lightning AI account (free tier available)
2. Start a new notebook with GPU (T4 or better)
3. Upload `train_data.jsonl` and `aicode0x_finetune.ipynb`
4. Run all cells
5. Download `aicode0x-Q4_K_M.gguf` from the output

## How to use with Ollama

```bash
# After downloading the GGUF file:
ollama create aicode0x -f Modelfile

# Use it:
ollama run aicode0x
```

## How to use with aibuilder

Once deployed, add `aicode:0x` to the model selector in `src/models.js` and point it to the Ollama endpoint.
