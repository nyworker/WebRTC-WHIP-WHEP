import asyncio
import fractions
import json
import logging
import math
import os
import time
import uuid
from datetime import datetime
from typing import Dict, List, Optional

import aiohttp
from aiohttp import web
from aiortc import (
    AudioStreamTrack,
    RTCPeerConnection,
    RTCSessionDescription,
    VideoStreamTrack,
)
from aiortc.contrib.media import MediaRelay
import av
import numpy as np
from PIL import Image, ImageDraw, ImageFont

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s - %(message)s",
)
logger = logging.getLogger("PulseStream")

# Global Media Relay to fan-out single WHIP track to multiple WHEP subscribers
relay = MediaRelay()

# Store active sessions and streams
# streams: { stream_id: { "video": track, "audio": track, "broadcaster_id": str, "created_at": float, "stats": dict } }
streams: Dict[str, dict] = {}
# pcs: { session_id: { "pc": RTCPeerConnection, "type": "whip"|"whep", "stream_id": str, "created_at": float } }
pcs: Dict[str, dict] = {}


class LowLatencyClockVideoTrack(VideoStreamTrack):
    """
    A synthetic video track generating a 60/30 FPS test pattern with:
    - High-precision millisecond UTC clock for glass-to-glass latency testing
    - Animated radar/bouncing elements to test framerate smoothness and jitter
    - Color bars and resolution indicators
    """
    def __init__(self, fps=30, width=640, height=360):
        super().__init__()
        self.fps = fps
        self.width = width
        self.height = height
        self._start_time = time.time()
        self._frame_count = 0

    async def recv(self):
        pts, time_base = await self.next_timestamp()
        self._frame_count += 1
        now = time.time()
        elapsed = now - self._start_time

        # Create canvas
        img = Image.new("RGB", (self.width, self.height), color=(15, 23, 42))  # Dark Slate
        draw = ImageDraw.Draw(img)

        # Draw Color Bars at bottom
        bar_height = 40
        colors = [
            (255, 255, 255), (255, 255, 0), (0, 255, 255), (0, 255, 0),
            (255, 0, 255), (255, 0, 0), (0, 0, 255), (0, 0, 0)
        ]
        bar_width = self.width / len(colors)
        for i, col in enumerate(colors):
            draw.rectangle(
                [i * bar_width, self.height - bar_height, (i + 1) * bar_width, self.height],
                fill=col
            )

        # Draw Animated Radar / Scanner for motion smoothness
        center_x, center_y = self.width // 4, (self.height - bar_height) // 2
        radius = min(center_x, center_y) - 20
        draw.ellipse(
            [center_x - radius, center_y - radius, center_x + radius, center_y + radius],
            outline=(16, 185, 129), width=2
        )
        angle = (elapsed * 180) % 360  # Complete revolution every 2 seconds
        rad = math.radians(angle)
        end_x = center_x + radius * math.cos(rad)
        end_y = center_y + radius * math.sin(rad)
        draw.line([center_x, center_y, end_x, end_y], fill=(52, 211, 153), width=3)
        draw.ellipse([center_x - 4, center_y - 4, center_x + 4, center_y + 4], fill=(255, 255, 255))

        # Draw Bouncing Ball for jitter testing
        bounce_x = int((self.width // 2) + ((self.width // 2 - 40) * math.sin(elapsed * 4)))
        bounce_y = int(50 + 20 * math.cos(elapsed * 8))
        draw.ellipse([bounce_x - 15, bounce_y - 15, bounce_x + 15, bounce_y + 15], fill=(244, 63, 94))

        # Draw Precision Millisecond Timestamp
        dt = datetime.utcfromtimestamp(now)
        time_str = dt.strftime("%H:%M:%S")
        millis = int((now % 1) * 1000)
        full_time_str = f"{time_str}.{millis:03d}"

        # Text layout
        text_x = self.width // 2 - 20
        draw.text((text_x, 80), "PULSESTREAM SYNTHETIC CLOCK", fill=(56, 189, 248))
        draw.text((text_x, 110), f"UTC TIME: {full_time_str}", fill=(255, 255, 255))
        draw.text((text_x, 140), f"FRAME: #{self._frame_count} | {self.fps} FPS", fill=(203, 213, 225))
        draw.text((text_x, 170), f"RES: {self.width}x{self.height} | CODEC: VP8/H264", fill=(148, 163, 184))

        # Convert to AVFrame
        frame = av.VideoFrame.from_image(img)
        frame.pts = pts
        frame.time_base = time_base
        return frame


class LowLatencyAudioTrack(AudioStreamTrack):
    """
    A synthetic audio track generating a 523 Hz beep every second
    to verify A/V synchronization and measure audio latency.
    """
    def __init__(self):
        super().__init__()
        self._sample_rate = 48000
        self._samples_per_frame = 960  # 20ms at 48kHz
        self._time = 0

    async def recv(self):
        if self.readyState != "live":
            from aiortc.mediastreams import MediaStreamError
            raise MediaStreamError

        if hasattr(self, "_timestamp"):
            self._timestamp += self._samples_per_frame
            wait = self._start + (self._timestamp / self._sample_rate) - time.time()
            if wait > 0:
                await asyncio.sleep(wait)
        else:
            self._start = time.time()
            self._timestamp = 0
        
        # Generate mono audio: beep for 200ms every 1000ms at 523Hz (C5 note)
        samples = np.zeros((1, self._samples_per_frame), dtype=np.int16)
        for i in range(self._samples_per_frame):
            t = self._time + (i / self._sample_rate)
            if (t % 1.0) < 0.2:  # 200ms beep
                samples[0, i] = int(20000 * math.sin(2 * math.pi * 523.25 * t))
        
        self._time += self._samples_per_frame / self._sample_rate

        # Pack into AVFrame
        frame = av.AudioFrame.from_ndarray(samples, format="s16", layout="mono")
        frame.pts = self._timestamp
        frame.time_base = fractions.Fraction(1, self._sample_rate)
        frame.sample_rate = self._sample_rate
        return frame


# Initialize default synthetic test stream
def init_test_stream():
    streams["test-clock"] = {
        "video": LowLatencyClockVideoTrack(fps=30),
        "audio": LowLatencyAudioTrack(),
        "broadcaster_id": "synthetic-server",
        "created_at": time.time(),
        "title": "Synthetic Low-Latency Clock & Radar",
        "is_synthetic": True,
        "stats": {
            "bitrate_kbps": 1200,
            "fps": 30,
            "resolution": "640x360",
            "viewers": 0
        }
    }
    logger.info("Initialized default 'test-clock' synthetic WHIP stream.")

init_test_stream()


# --- HTTP Handler Functions ---

async def handle_whip_ingest(request: web.Request) -> web.Response:
    """
    WHIP (WebRTC-HTTP Ingestion Protocol) Endpoint
    POST /api/whip?channel={channel_name}
    """
    channel = request.query.get("channel", "live-stream")
    content_type = request.headers.get("Content-Type", "")
    
    if "application/sdp" not in content_type:
        return web.Response(status=415, text="Unsupported Media Type: must be application/sdp")

    sdp_offer = await request.text()
    if not sdp_offer.strip():
        return web.Response(status=400, text="Empty SDP Offer")

    session_id = str(uuid.uuid4())
    pc = RTCPeerConnection()
    
    pcs[session_id] = {
        "pc": pc,
        "type": "whip",
        "stream_id": channel,
        "created_at": time.time(),
        "remote_ip": request.remote
    }

    # Setup stream storage for channel
    if channel not in streams or streams[channel].get("is_synthetic"):
        streams[channel] = {
            "video": None,
            "audio": None,
            "broadcaster_id": session_id,
            "created_at": time.time(),
            "title": f"Live Stream ({channel})",
            "is_synthetic": False,
            "stats": {"bitrate_kbps": 0, "fps": 0, "resolution": "1080p", "viewers": 0}
        }
    else:
        streams[channel]["broadcaster_id"] = session_id

    @pc.on("track")
    def on_track(track):
        logger.info(f"[{session_id}] WHIP received track: {track.kind} for channel '{channel}'")
        if track.kind == "video":
            streams[channel]["video"] = relay.subscribe(track)
        elif track.kind == "audio":
            streams[channel]["audio"] = relay.subscribe(track)

        @track.on("ended")
        async def on_ended():
            logger.info(f"[{session_id}] Track {track.kind} ended for channel '{channel}'")

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        logger.info(f"[{session_id}] WHIP connection state: {pc.connectionState}")
        if pc.connectionState in ["failed", "closed", "disconnected"]:
            await cleanup_session(session_id)

    # Set remote description (offer) and create answer
    offer = RTCSessionDescription(sdp=sdp_offer, type="offer")
    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    headers = {
        "Content-Type": "application/sdp",
        "Location": f"/api/whip/{session_id}"
    }
    
    logger.info(f"[{session_id}] WHIP broadcast started on channel '{channel}'")
    return web.Response(status=201, text=pc.localDescription.sdp, headers=headers)


async def handle_whep_egress(request: web.Request) -> web.Response:
    """
    WHEP (WebRTC-HTTP Egress Protocol) Endpoint
    POST /api/whep?channel={channel_name}
    """
    channel = request.query.get("channel", "test-clock")
    content_type = request.headers.get("Content-Type", "")

    if "application/sdp" not in content_type:
        return web.Response(status=415, text="Unsupported Media Type: must be application/sdp")

    sdp_offer = await request.text()
    if not sdp_offer.strip():
        return web.Response(status=400, text="Empty SDP Offer")

    if channel not in streams:
        return web.Response(status=404, text=f"Stream channel '{channel}' not found or inactive")

    stream = streams[channel]
    session_id = str(uuid.uuid4())
    pc = RTCPeerConnection()

    pcs[session_id] = {
        "pc": pc,
        "type": "whep",
        "stream_id": channel,
        "created_at": time.time(),
        "remote_ip": request.remote
    }

    # Add available tracks from the stream
    tracks_added = 0
    if stream.get("video"):
        # If synthetic, create fresh track; if WHIP relayed, subscribe proxy from relay
        if stream.get("is_synthetic"):
            pc.addTrack(LowLatencyClockVideoTrack(fps=30))
        else:
            pc.addTrack(relay.subscribe(stream["video"]))
        tracks_added += 1

    if stream.get("audio"):
        if stream.get("is_synthetic"):
            pc.addTrack(LowLatencyAudioTrack())
        else:
            pc.addTrack(relay.subscribe(stream["audio"]))
        tracks_added += 1

    if tracks_added == 0:
        return web.Response(status=404, text=f"No active media tracks on channel '{channel}'")

    stream["stats"]["viewers"] = stream["stats"].get("viewers", 0) + 1

    @pc.on("connectionstatechange")
    async def on_connectionstatechange():
        logger.info(f"[{session_id}] WHEP viewer connection state: {pc.connectionState}")
        if pc.connectionState in ["failed", "closed", "disconnected"]:
            await cleanup_session(session_id)

    # Set remote offer and create local answer
    offer = RTCSessionDescription(sdp=sdp_offer, type="offer")
    await pc.setRemoteDescription(offer)
    answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)

    headers = {
        "Content-Type": "application/sdp",
        "Location": f"/api/whep/{session_id}"
    }

    logger.info(f"[{session_id}] WHEP subscription started for channel '{channel}'")
    return web.Response(status=201, text=pc.localDescription.sdp, headers=headers)


async def handle_delete_session(request: web.Request) -> web.Response:
    """
    WHIP / WHEP Session Termination
    DELETE /api/whip/{session_id} or DELETE /api/whep/{session_id}
    """
    session_id = request.match_info.get("session_id")
    if not session_id or session_id not in pcs:
        return web.Response(status=404, text="Session not found")

    await cleanup_session(session_id)
    return web.Response(status=200, text="Session terminated successfully")


async def cleanup_session(session_id: str):
    if session_id not in pcs:
        return
    session = pcs.pop(session_id)
    pc = session["pc"]
    st_id = session.get("stream_id")
    st_type = session.get("type")

    logger.info(f"[{session_id}] Cleaning up {st_type.upper()} session for stream '{st_id}'")
    try:
        await pc.close()
    except Exception as e:
        logger.error(f"Error closing PC {session_id}: {e}")

    if st_id and st_id in streams:
        if st_type == "whep":
            streams[st_id]["stats"]["viewers"] = max(0, streams[st_id]["stats"].get("viewers", 1) - 1)
        elif st_type == "whip":
            # Broadcaster disconnected, remove stream if not synthetic and if it's the active broadcaster
            if not streams[st_id].get("is_synthetic") and streams[st_id].get("broadcaster_id") == session_id:
                logger.info(f"Broadcaster left. Removing channel '{st_id}'")
                del streams[st_id]


# --- REST API & Monitoring Endpoints ---

async def handle_list_streams(request: web.Request) -> web.Response:
    """GET /api/streams - List all active broadcast and test streams"""
    result = []
    for s_id, s_data in streams.items():
        result.append({
            "id": s_id,
            "title": s_data.get("title", s_id),
            "is_synthetic": s_data.get("is_synthetic", False),
            "has_video": s_data.get("video") is not None,
            "has_audio": s_data.get("audio") is not None,
            "uptime_seconds": int(time.time() - s_data.get("created_at", time.time())),
            "viewers": s_data.get("stats", {}).get("viewers", 0),
            "bitrate_kbps": s_data.get("stats", {}).get("bitrate_kbps", 0),
            "fps": s_data.get("stats", {}).get("fps", 30),
            "resolution": s_data.get("stats", {}).get("resolution", "1080p")
        })
    return web.json_response({"streams": result, "timestamp": time.time()})


async def handle_server_stats(request: web.Request) -> web.Response:
    """GET /api/stats - Get server performance and active connections"""
    whip_count = sum(1 for p in pcs.values() if p["type"] == "whip")
    whep_count = sum(1 for p in pcs.values() if p["type"] == "whep")
    
    return web.json_response({
        "server_name": "PulseStream Studio WHIP/WHEP Server",
        "version": "2.0.0",
        "status": "healthy",
        "active_whip_broadcasters": whip_count,
        "active_whep_viewers": whep_count,
        "total_active_connections": len(pcs),
        "active_channels": len(streams),
        "timestamp": time.time()
    })


# --- Static & Frontend Serving ---

async def handle_index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(os.path.join(os.path.dirname(__file__), "public", "index.html"))


async def on_shutdown(app):
    logger.info("Shutting down active WebRTC peer connections...")
    coros = [cleanup_session(s_id) for s_id in list(pcs.keys())]
    if coros:
        await asyncio.gather(*coros, return_exceptions=True)


def create_app() -> web.Application:
    app = web.Application()
    
    # CORS Middleware for testing with external clients / tools
    import aiohttp_cors
    cors = aiohttp_cors.setup(app, defaults={
        "*": aiohttp_cors.ResourceOptions(
            allow_credentials=True,
            expose_headers="*",
            allow_headers="*",
            allow_methods="*",
        )
    })

    # API Routes
    whip_resource = cors.add(app.router.add_resource("/api/whip"))
    cors.add(whip_resource.add_route("POST", handle_whip_ingest))
    
    whip_del_resource = cors.add(app.router.add_resource("/api/whip/{session_id}"))
    cors.add(whip_del_resource.add_route("DELETE", handle_delete_session))

    whep_resource = cors.add(app.router.add_resource("/api/whep"))
    cors.add(whep_resource.add_route("POST", handle_whep_egress))

    whep_del_resource = cors.add(app.router.add_resource("/api/whep/{session_id}"))
    cors.add(whep_del_resource.add_route("DELETE", handle_delete_session))

    cors.add(app.router.add_get("/api/streams", handle_list_streams))
    cors.add(app.router.add_get("/api/stats", handle_server_stats))

    # Static routes
    public_dir = os.path.join(os.path.dirname(__file__), "public")
    os.makedirs(public_dir, exist_ok=True)
    app.router.add_get("/", handle_index)
    app.router.add_static("/", public_dir, show_index=True)

    app.on_shutdown.append(on_shutdown)
    return app


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8088))
    logger.info(f"Starting PulseStream WHIP/WHEP Server on http://0.0.0.0:{port}")
    app = create_app()
    web.run_app(app, host="0.0.0.0", port=port)
