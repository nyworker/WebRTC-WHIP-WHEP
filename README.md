# PulseStream Studio ⚡
**The Ultimate Low-Latency WHIP / WHEP WebRTC Testbench & Media Suite**

ONLY WORKS: 1280x720 and 2Mbps

** Better to use mediamtx:
  ● [21:37:39] ffmpeg -stream_loop -1 -re -i /home/steve/Downloads/sync.mp4 -vf "drawtext=text='%{localtime}':x=10:y=10:fontsize=48:fontcolor=white:box... 
  ● [21:08:44] ./mediamtx 


PulseStream Studio is a state-of-the-art WebRTC application and server built to test, analyze, and benchmark sub-second low-latency video and audio streaming using modern **IETF WHIP (WebRTC HTTP Ingestion Protocol)** and **WHEP (WebRTC HTTP Egress Protocol)** standards.

---

## 🌟 Key Features

1. **Python Native AIORTC WHIP/WHEP Server (`server.py`)**
   - **WHIP Ingest (`POST /api/whip`)**: Ingests WebRTC live streams via HTTP SDP negotiation. Supports webcam, desktop screen share, OBS Studio, and FFmpeg/GStreamer.
   - **WHEP Egress (`POST /api/whep`)**: Distributes ultra-low latency (< 150ms glass-to-glass) WebRTC streams to viewers.
   - **Zero-Frame-Stealing Multi-Viewer Fanout**: Uses `aiortc` MediaRelay to serve unlimited WHEP subscribers from a single WHIP broadcast without packet collision or degradation.
   - **Built-in Synthetic Low-Latency Test Clock**: Automatically generates a precision UTC millisecond timestamp clock, animated radar, and 440 Hz sync tone at 30/60 FPS directly on the server for immediate WHEP testing without external broadcasting equipment.

2. **PulseStream UI (Modern Glassmorphic Web Application)**
   - **WHEP Viewer & Latency Analyzer**: Watch any active channel with live WebRTC telemetry (Bitrate, FPS, Packet Loss, Round-Trip Time RTT, Jitter, Codec, Resolution).
   - **WHIP Broadcaster Studio**: Publish directly from your browser using your Webcam/Mic, Window Capture/Screen Share, or our built-in interactive 60 FPS Canvas Generator.
   - **Protocol & SDP Inspector**: Inspect raw HTTP POST/DELETE headers and real-time WebRTC Session Descriptions (SDP Offers and Answers) with candidate type mapping.

3. **Multi-Environment Support**
   - Run standalone with Python virtualenv or deploy alongside **MediaMTX** via Docker Compose for interop testing against Go/C SFU servers.

---

## 🚀 Quick Start

### 1. Standalone Python Setup (Recommended)
Make sure you have Python 3.10+ and FFmpeg installed.

```bash
# Create and activate virtual environment
python3 -m venv venv
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Launch PulseStream Server (defaults to port 8088)
python server.py
```

Open your browser and navigate to:
👉 **http://localhost:8088**

---

### 2. Docker Compose Setup (with MediaMTX Interop)
To run both the Python Native server and MediaMTX:

```bash
docker compose up --build -d
```
- **PulseStream UI & Server**: http://localhost:8088
- **MediaMTX SFU**: WebRTC/WHIP/WHEP available on default host ports

---

## 🧪 How to Test Low-Latency Streaming

### Method A: Immediate WHEP Playback Test (No Setup Required)
1. Open http://localhost:8088.
2. In the **WHEP Viewer & Latency** tab, select the default **`test-clock (SYNTHETIC)`** channel.
3. Click **Subscribe (WHEP)**.
4. Observe the sub-second visual UTC millisecond timer and monitor real-time Round Trip Time (RTT) and Packet Loss in the telemetry dashboard.

### Method B: In-Browser WHIP Broadcaster -> WHEP Viewer
1. Open Tab 2: **WHIP Broadcaster Studio**.
2. Enter a custom channel name (e.g., `my-stream`).
3. Choose your source: **Webcam & Microphone**, **Screen Share**, or **In-Browser Canvas Test Generator**.
4. Click **GO LIVE (WHIP)**.
5. Open a second browser window or tab to http://localhost:8088, select your new `my-stream` channel in Tab 1, and click **Subscribe (WHEP)**!

### Method C: OBS Studio (Native WHIP Support)
1. Open OBS Studio 30+ -> **Settings -> Stream**.
2. Set **Service** to `WHIP`.
3. Set **Server** to:
   ```text
   http://localhost:8088/api/whip?channel=obs
   ```
4. Click **Start Streaming**. Watch the stream live in the PulseStream WHEP Viewer!

### Method D: GStreamer CLI Pipeline
```bash
gst-launch-1.0 -v videotestsrc is-live=true ! video/x-raw,width=1280,height=720,framerate=30/1 ! videoconvert ! vp8enc target-bitrate=1500000 ! rtpvp8pay ! whipsink whip-endpoint="http://localhost:8088/api/whip?channel=gstreamer"
```

---

## 📡 API Endpoints

| Method | Endpoint | Description | Content-Type |
| :--- | :--- | :--- | :--- |
| `POST` | `/api/whip?channel={name}` | Initiate WHIP broadcast ingestion | `application/sdp` |
| `DELETE` | `/api/whip/{session_id}` | Terminate active WHIP broadcast | N/A |
| `POST` | `/api/whep?channel={name}` | Initiate WHEP egress subscription | `application/sdp` |
| `DELETE` | `/api/whep/{session_id}` | Terminate active WHEP subscription | N/A |
| `GET` | `/api/streams` | JSON list of active channels & stats | `application/json` |
| `GET` | `/api/stats` | JSON server health & active connections | `application/json` |

---

## 🛠 Tech Stack
- **Backend**: Python 3.12, `aiohttp`, `aiortc`, `PyAV`, `NumPy`, `Pillow`
- **Frontend**: Vanilla HTML5, CSS3 (Custom Glassmorphism Design System), JavaScript (WebRTC API, Canvas Capture, WebAudio)
- **Containerization**: Docker, Docker Compose, MediaMTX
