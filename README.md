# RunPod · Pathumma Whisper Thai Large v3

ชุดทดสอบสำหรับ **RunPod Serverless แบบ Queue** ใช้โมเดล `nectec/Pathumma-whisper-th-large-v3` ผ่าน Transformers บน CUDA GPU ไม่ใช่ MLX ของ Mac และเป็น worker แยกสำหรับ STT โดยเฉพาะ

มี 2 ส่วน:
- `handler.py` + `Dockerfile` + `requirements.txt`: worker ถอดเสียงภาษาไทย
- `test-call.mjs`: client Node.js 22+ ส่งไฟล์เสียง → `/run` → poll `/status/{job_id}` → แสดง JSON

## 1. สร้าง image ของ worker

ต้องมี Docker และบัญชี Docker Hub เปลี่ยน `YOUR_DOCKER_USER` เป็นชื่อ registry ของคุณ:

```bash
git clone https://github.com/snpeerapun/runpod-pathumma-stt.git
cd runpod-pathumma-stt
docker build --platform linux/amd64 -t YOUR_DOCKER_USER/pathumma-stt:v1 .
docker login
docker push YOUR_DOCKER_USER/pathumma-stt:v1
```

Mac ต้อง build `linux/amd64` สำหรับ RunPod; การถอดเสียงจริงใน container ต้องใช้ NVIDIA GPU จึงรัน inference บน Mac โดยตรงไม่ได้

## 2. สร้าง Serverless endpoint

ใน RunPod Console → Serverless → New Endpoint → Import from Docker Registry:

- Container image: `YOUR_DOCKER_USER/pathumma-stt:v1`
- Endpoint type: **Queue**
- GPU: สำหรับการทดลองนี้เริ่มที่ VRAM 24 GB เพื่อเผื่อหน่วยความจำของ large-v3; ยังไม่ได้ benchmark การใช้ VRAM จริงของ worker นี้
- Active/min workers: **0**, Max workers: **1** สำหรับการทดสอบครั้งแรก
- Container disk: เริ่มที่ **30 GB** เพื่อเผื่อ image และ model cache
- Execution timeout: **600 วินาที** หรือเพิ่มเมื่อ cold start โหลดโมเดลไม่ทัน
- Start command: ใช้ค่าใน image (`python -u handler.py`)
- ไม่ต้องเปิด HTTP port; RunPod SDK รับงานผ่าน queue

โมเดลจะดาวน์โหลดจาก Hugging Face เมื่อมีงานแรก แล้วค้างในหน่วยความจำระหว่าง worker ยังอยู่ ครั้งแรกจึงรวมเวลา download/load ไว้ด้วย เมื่อ scale to zero แล้วได้ worker ใหม่อาจดาวน์โหลดใหม่ หากใช้ Network Volume ตั้ง `HF_HOME=/runpod-volume/hf-cache` เพื่อเก็บ cache บน volume

Deploy แล้วคัดลอก **Endpoint ID** และสร้าง RunPod API key ที่เข้าถึง endpoint นี้ได้ ไม่ต้องใส่ RunPod API key ใน worker

## 3. ตั้งค่าบนเครื่องที่เรียกทดสอบ

รันจาก root ของ repo:

```bash
export RUNPOD_ENDPOINT_ID='YOUR_ENDPOINT_ID'
```

ใส่ API key โดยไม่แสดงบนจอ (macOS zsh):

```zsh
read -s 'RUNPOD_API_KEY?RunPod API key: '
export RUNPOD_API_KEY
```

สำหรับ bash ใช้ `read -s -p 'RunPod API key: ' RUNPOD_API_KEY` แล้ว `export RUNPOD_API_KEY`

## 4. เตรียมไฟล์เสียงและเรียกทดสอบ

เริ่มด้วยเสียงพูดภาษาไทยจริง 5–15 วินาที เช่น “สวัสดี วันนี้อากาศเป็นอย่างไร” รองรับ WAV/MP3/M4A/WebM ที่ ffmpeg อ่านได้ จำกัดไฟล์ **6 MiB** และเสียง **120 วินาที** สำหรับชุดทดลองนี้

หากต้องการแปลงเป็น WAV mono 16 kHz:

```bash
ffmpeg -i input.m4a -ac 1 -ar 16000 sample.wav
```

ตรวจ payload โดยไม่เรียก RunPod และไม่ใช้ API key:

```bash
node test-call.mjs --audio ./sample.wav --dry-run
```

เรียก GPU จริง:

```bash
node test-call.mjs --audio ./sample.wav --timeout 900
```

เก็บผล JSON:

```bash
node test-call.mjs --audio ./sample.wav --timeout 900 > result.json
```

จะเห็นข้อความถอดเสียง `text`, โมเดล `model`, `stt_ms` (เฉพาะช่วง inference), `worker_total_ms` (รวม decode และโหลดโมเดลใน worker), `delay_ms` / `execution_ms` จาก RunPod และ `client_elapsed_ms` ฝั่ง client

ลองรันไฟล์เดิมอีกครั้งขณะ worker ยังอุ่นอยู่เพื่อแยก cold start ออกจากเวลา inference ปกติ การเรียกจริงใช้ GPU และคิดค่าบริการตามการใช้งานบัญชี RunPod

ถ้า script รอหมดเวลาหรือ connection หลุดแล้วมี Job ID ให้ตรวจงานเดิมโดย **ไม่ส่งงานใหม่**:

```bash
node test-call.mjs --job YOUR_JOB_ID --timeout 900
```

การหยุด script / client timeout ไม่ยกเลิกงานบน RunPod ให้ดู Requests ใน console เพื่อยกเลิกงานหากต้องการ หากส่งงานแล้ว network ล้มก่อนรับ Job ID ให้ตรวจ Requests ก่อนส่งซ้ำ

## รูปแบบ API ที่ worker นี้รองรับ

```json
{
  "input": {
    "audio_base64": "BASE64_OF_AUDIO_FILE",
    "language": "th"
  }
}
```

`audio_base64` เป็น base64 ปกติ ไม่ใช่ data URI, `language` เป็น `th` (ค่าเริ่มต้น) หรือ `en` สคริปต์นี้ไม่ใช่ payload มาตรฐานของ Whisper template ทุกตัว ต้องใช้กับ worker นี้หรือ worker ที่มี schema ตรงกัน

## ทดสอบโค้ดโดยไม่ใช้ GPU / ไม่เรียก RunPod

จาก root repo:

```bash
node --test test-call.test.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s . -p 'test_handler.py'
```

ทดสอบ schema, submit/poll/resume, ข้อผิดพลาด, ไม่ submit ซ้ำอัตโนมัติ และ validation ไฟล์ การทดสอบเหล่านี้ไม่ยืนยันคุณภาพ transcription หรือ GPU compatibility ต้อง build/deploy แล้วทดลองเสียงจริงอีกครั้ง

## อ้างอิง

- [NECTEC model card](https://huggingface.co/nectec/Pathumma-whisper-th-large-v3)
- [RunPod request lifecycle](https://docs.runpod.io/serverless/endpoints/send-requests)
- [Deploy a Docker worker](https://docs.runpod.io/serverless/workers/deploy)
