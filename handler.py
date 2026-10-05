"""RunPod queue-based worker for test-call.mjs. Requires a CUDA GPU and ffmpeg."""
import base64
import binascii
import os
import subprocess
import tempfile
import time

MODEL_ID = "nectec/Pathumma-whisper-th-large-v3"
MAX_BYTES = 6 * 1024 * 1024
MAX_SECONDS = 120
_pipe = None


def decode_input(data):
    if not isinstance(data, dict):
        raise ValueError("input must be an object")
    encoded = data.get("audio_base64")
    if not isinstance(encoded, str) or not encoded or len(encoded) > ((MAX_BYTES + 2) // 3) * 4:
        raise ValueError("audio_base64 is required; maximum decoded size is 6 MiB")
    try:
        audio = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError("audio_base64 must contain plain base64 without a data URI prefix") from exc
    if not audio or len(audio) > MAX_BYTES:
        raise ValueError("audio must be nonempty and at most 6 MiB")
    language = data.get("language", "th")
    if language not in ("th", "en"):
        raise ValueError("language must be th or en")
    return audio, language


def get_pipeline():
    global _pipe
    if _pipe is None:
        import torch
        from transformers import pipeline
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA GPU required for this worker")
        _pipe = pipeline(
            "automatic-speech-recognition", model=MODEL_ID,
            torch_dtype=torch.float16, device="cuda:0",
            model_kwargs={"low_cpu_mem_usage": True},
        )
    return _pipe


def handler(job):
    import numpy as np
    started = time.perf_counter()
    audio, language = decode_input(job.get("input"))
    with tempfile.TemporaryDirectory(prefix="pathumma-") as folder:
        source = os.path.join(folder, "input.audio")
        with open(source, "wb") as file:
            file.write(audio)
        # Decode only a bounded duration; reject long files instead of silently truncating.
        result = subprocess.run([
            "ffmpeg", "-nostdin", "-v", "error", "-i", source,
            "-t", str(MAX_SECONDS + 1), "-ac", "1", "-ar", "16000",
            "-f", "f32le", "pipe:1"
        ], capture_output=True, timeout=45, check=False)
        if result.returncode:
            raise ValueError("Cannot decode audio. Supply WAV, MP3, M4A or WebM supported by ffmpeg.")
        samples = np.frombuffer(result.stdout, dtype=np.float32).copy()
        duration = len(samples) / 16000
        if not 0 < duration <= MAX_SECONDS:
            raise ValueError("Test clips must contain 0–120 seconds of audio")
        pipe = get_pipeline()
        inference_start = time.perf_counter()
        output = pipe(
            {"array": samples, "sampling_rate": 16000},
            chunk_length_s=30, batch_size=1,
            generate_kwargs={"language": language, "task": "transcribe"},
        )
    return {
        "ok": True, "text": output["text"].strip(), "model": MODEL_ID,
        "language": language, "audio_seconds": round(duration, 3),
        "stt_ms": round((time.perf_counter() - inference_start) * 1000),
        "worker_total_ms": round((time.perf_counter() - started) * 1000),
        "device": "cuda",
    }


if __name__ == "__main__":
    import runpod
    runpod.serverless.start({"handler": handler})
