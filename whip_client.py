import asyncio
import aiohttp
import argparse
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaPlayer


async def run(channel, device, width, height, fps, input_format):
    # Initialize the video capture device using FFmpeg via PyAV
    options = {
        "video_size": f"{width}x{height}",
        "framerate": str(fps),
        "fflags": "nobuffer",
        "flags": "low_delay",
        "strict": "experimental",
        "framedrop": "1"
    }
    if input_format:
        options["input_format"] = input_format
        
    print(f"Opening {device} with options: {options}")
    player = MediaPlayer(device, format="v4l2", options=options)

    pc = RTCPeerConnection()
    
    if player.video:
        # Increase the max bitrate for the video sender
        sender = pc.addTrack(player.video)
        
        # Negotiate WHIP
        offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        
        url = f"http://localhost:8088/api/whip?channel={channel}"
        print(f"Sending WHIP Offer to {url}...")
        
        async with aiohttp.ClientSession() as session:
            async with session.post(url, data=pc.localDescription.sdp, headers={"Content-Type": "application/sdp"}) as response:
                if response.status not in (200, 201):
                    print(f"WHIP Error: {response.status} {await response.text()}")
                    return
                
                answer_sdp = await response.text()
                await pc.setRemoteDescription(RTCSessionDescription(sdp=answer_sdp, type="answer"))
                print("WHIP Connection established! Streaming...")
                
                # Keep alive until cancelled
                try:
                    while True:
                        await asyncio.sleep(1)
                except asyncio.CancelledError:
                    print("Stopping broadcast...")
    else:
        print("No video track found!")

    await pc.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WHIP Broadcaster using FFmpeg/v4l2 via aiortc")
    parser.add_argument("--channel", default="ffmpeg-live")
    parser.add_argument("--device", default="/dev/video4")
    parser.add_argument("--width", type=int, default=1920)
    parser.add_argument("--height", type=int, default=1080)
    parser.add_argument("--fps", type=float, default=29.97)
    parser.add_argument("--input-format", type=str, default="mjpeg", help="v4l2 input format (e.g. mjpeg, yuyv422)")
    
    args = parser.parse_args()
    
    try:
        asyncio.run(run(args.channel, args.device, args.width, args.height, args.fps, args.input_format))
    except KeyboardInterrupt:
        pass
