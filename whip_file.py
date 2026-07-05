import asyncio
import aiohttp
import argparse
from aiortc import RTCPeerConnection, RTCSessionDescription
from aiortc.contrib.media import MediaPlayer

async def run(channel, filepath):
    print(f"Opening file/stream: {filepath}")
    
    # If it's a live UDP stream, don't buffer it!
    options = {}
    if filepath.startswith("udp://"):
        options = {"fflags": "nobuffer", "flags": "low_delay"}
        
    player = MediaPlayer(filepath, options=options)

    pc = RTCPeerConnection()
    
    if player.video:
        pc.addTrack(player.video)
        print("Attached video track.")
    if player.audio:
        pc.addTrack(player.audio)
        print("Attached audio track.")
        
    if not player.video and not player.audio:
        print("No media tracks found in file!")
        return

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
            print("WHIP Connection established! Streaming media file...")
            
            # Keep alive until cancelled
            try:
                while True:
                    await asyncio.sleep(1)
            except asyncio.CancelledError:
                print("Stopping broadcast...")

    await pc.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WHIP Media File Broadcaster")
    parser.add_argument("--channel", default="file-stream")
    parser.add_argument("--file", required=True, help="Path to the media file to play")
    
    args = parser.parse_args()
    
    try:
        asyncio.run(run(args.channel, args.file))
    except KeyboardInterrupt:
        pass
