import asyncio
import base64
import json
import sys
import unicodedata
import edge_tts

# Force UTF-8 on Windows stdin and stdout to avoid CP1252 accent decoding issues
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

# Default female anime waifu voice: Dalia (Mexican Spanish, cheerful & sweet)
# Tuned with +8Hz pitch for anime companion aesthetic, +15% rate for natural conversation pace
DEFAULT_VOICE = "es-MX-DaliaNeural"
DEFAULT_PITCH = "+8Hz"
DEFAULT_RATE = "+15%"

async def synthesize(text: str, voice: str, pitch: str, rate: str) -> str:
    # Ensure NFC canonical normalization so accents and umlauts merge cleanly
    normalized = unicodedata.normalize("NFC", text)
    communicate = edge_tts.Communicate(normalized, voice, pitch=pitch, rate=rate)
    data = b""
    async for chunk in communicate.stream():
        if chunk["type"] == "audio":
            data += chunk["data"]
    if not data:
        raise ValueError("Audio stream was empty")
    return base64.b64encode(data).decode("ascii")

async def handle_request(trimmed: str, limit: asyncio.Semaphore):
    req_id = ""
    try:
        req = json.loads(trimmed)
        req_id = req.get("id", "")
        text = req.get("text", "").strip()
        voice = req.get("voice") or DEFAULT_VOICE
        pitch = req.get("pitch") or DEFAULT_PITCH
        rate = req.get("rate") or DEFAULT_RATE

        if not text:
            reply = {"id": req_id, "audio": "", "error": None}
        else:
            async with limit:
                # One retry: the Edge service sometimes drops a connection.
                try:
                    b64_audio = await synthesize(text, voice, pitch, rate)
                except Exception:
                    b64_audio = await synthesize(text, voice, pitch, rate)
            reply = {"id": req_id, "audio": b64_audio, "error": None}
    except Exception as err:
        reply = {"id": req_id, "audio": "", "error": str(err)}
    sys.stdout.write(json.dumps(reply) + "\n")
    sys.stdout.flush()

async def main():
    sys.stdout.write("READY\n")
    sys.stdout.flush()

    loop = asyncio.get_running_loop()
    # Several sentences synthesize at the same time, so a long answer does not queue up.
    limit = asyncio.Semaphore(4)
    tasks = set()

    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
        trimmed = line.strip()
        if not trimmed:
            continue
        if trimmed == "QUIT":
            break

        task = asyncio.create_task(handle_request(trimmed, limit))
        tasks.add(task)
        task.add_done_callback(tasks.discard)

if __name__ == "__main__":
    asyncio.run(main())
