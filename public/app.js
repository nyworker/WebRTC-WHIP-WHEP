// PulseStream Studio WebRTC WHIP/WHEP Client Logic

let selectedChannel = 'test-clock';
let whepPC = null;
let whepSessionUrl = null;
let whepStatsInterval = null;
let whepMediaStream = null;

let whipPC = null;
let whipStream = null;
let whipSessionUrl = null;
let whipStatsInterval = null;
let canvasAnimId = null;
let audioContext = null;
let audioOsc = null;

let lastSdpOffer = '';
let lastSdpAnswer = '';

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// --- Tab Switching ---
function switchTab(tabId, btnElement) {
  document.querySelectorAll('.tab-content').forEach(tab => tab.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  
  document.getElementById(tabId).classList.add('active');
  btnElement.classList.add('active');
}

// --- Server Status & Channel Polling ---
async function fetchServerStatus() {
  try {
    const res = await fetch('/api/stats');
    if (res.ok) {
      const data = await res.json();
      document.getElementById('status-dot').classList.remove('offline');
      document.getElementById('status-text').innerText = `Online (${data.total_active_connections} active sessions)`;
    } else {
      throw new Error('Offline');
    }
  } catch (err) {
    document.getElementById('status-dot').classList.add('offline');
    document.getElementById('status-text').innerText = 'Server Offline / Connecting...';
  }
}

async function fetchStreams() {
  try {
    const res = await fetch('/api/streams');
    if (!res.ok) return;
    const data = await res.json();
    
    const container = document.getElementById('channel-list');
    container.innerHTML = '';
    
    if (data.streams.length === 0) {
      container.innerHTML = `<div style="padding: 1rem; color: var(--text-dim); text-align: center;">No channels found</div>`;
      return;
    }
    
    data.streams.forEach(st => {
      const item = document.createElement('div');
      item.className = `channel-item ${st.id === selectedChannel ? 'selected' : ''}`;
      item.onclick = () => selectChannel(st.id, item);
      
      const badgeHtml = st.is_synthetic 
        ? `<span class="badge-synth">SYNTHETIC</span>` 
        : `<span class="badge-live" style="font-size: 0.65rem; padding: 2px 6px;">LIVE (${st.resolution})</span>`;
        
      item.innerHTML = `
        <div class="channel-info">
          <span class="channel-name">${st.id} ${badgeHtml}</span>
          <span class="channel-meta">${st.title} | ${st.viewers} viewer(s) | ${st.bitrate_kbps} kbps</span>
        </div>
        <i class="fa-solid fa-circle-check" style="color: ${st.id === selectedChannel ? 'var(--accent-cyan)' : 'transparent'};"></i>
      `;
      container.appendChild(item);
    });
  } catch (err) {
    console.error('Error fetching streams:', err);
  }
}

function selectChannel(channelId, element) {
  selectedChannel = channelId;
  document.querySelectorAll('.channel-item').forEach(el => {
    el.classList.remove('selected');
    const icon = el.querySelector('.fa-circle-check');
    if (icon) icon.style.color = 'transparent';
  });
  element.classList.add('selected');
  const icon = element.querySelector('.fa-circle-check');
  if (icon) icon.style.color = 'var(--accent-cyan)';
}

// --- WHEP (Egress Subscription) ---
async function startWhep() {
  if (whepPC) await stopWhep();
  
  const startBtn = document.getElementById('whep-start-btn');
  const stopBtn = document.getElementById('whep-stop-btn');
  const videoEl = document.getElementById('whep-video');
  const placeholder = document.getElementById('whep-placeholder');
  const overlay = document.getElementById('whep-overlay');
  const stateBadge = document.getElementById('whep-state-badge');
  
  startBtn.disabled = true;
  startBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Negotiating WHEP...`;
  
  try {
    whepPC = new RTCPeerConnection(ICE_SERVERS);
    whepMediaStream = new MediaStream();
    
    whepPC.ontrack = (event) => {
      console.log('WHEP Track received:', event.track.kind);
      whepMediaStream.addTrack(event.track);
      if (videoEl.srcObject !== whepMediaStream) {
        videoEl.srcObject = whepMediaStream;
        placeholder.style.display = 'none';
        overlay.style.display = 'flex';
        stateBadge.style.display = 'block';
        stateBadge.innerText = 'LATENCY: < 150MS (ULTRA LOW)';
      }
      // Explicitly unmute video and ensure audio playback
      videoEl.muted = false;
      videoEl.play().catch(e => console.warn('Autoplay blocked:', e));
      
      const audioBtn = document.getElementById('audio-toggle-btn');
      if (audioBtn) {
        audioBtn.style.display = 'inline-flex';
        audioBtn.innerHTML = `<i class="fa-solid fa-volume-high" style="color: var(--accent-emerald);"></i> Audio On`;
      }
    };
    
    whepPC.onconnectionstatechange = () => {
      console.log('WHEP Connection State:', whepPC.connectionState);
      if (whepPC.connectionState === 'connected') {
        startBtn.innerHTML = `<i class="fa-solid fa-check"></i> Subscribed (${selectedChannel})`;
        stopBtn.disabled = false;
        startWhepTelemetry();
      } else if (['disconnected', 'failed', 'closed'].includes(whepPC.connectionState)) {
        stopWhep();
      }
    };

    // WHEP requires client to send SDP offer or receive offer from server
    // We send an offer requesting audio and video
    whepPC.addTransceiver('video', { direction: 'recvonly' });
    whepPC.addTransceiver('audio', { direction: 'recvonly' });

    const offer = await whepPC.createOffer();
    await whepPC.setLocalDescription(offer);
    
    lastSdpOffer = offer.sdp;
    updateSdpInspector('offer', offer.sdp);
    logHttp('POST', `/api/whep?channel=${selectedChannel}`, 'Sending WHEP SDP Offer...');

    const res = await fetch(`/api/whep?channel=${selectedChannel}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`WHEP Server error ${res.status}: ${errText}`);
    }

    logHttp('POST', `/api/whep?channel=${selectedChannel}`, `${res.status} Created - SDP Answer Received`);
    whepSessionUrl = res.headers.get('Location');

    const answerSdp = await res.text();
    lastSdpAnswer = answerSdp;
    updateSdpInspector('answer', answerSdp);

    await whepPC.setRemoteDescription(new RTCSessionDescription({
      type: 'answer',
      sdp: answerSdp
    }));

  } catch (err) {
    console.error('WHEP error:', err);
    alert(`Failed to start WHEP stream: ${err.message}`);
    stopWhep();
  }
}

async function stopWhep() {
  if (whepStatsInterval) clearInterval(whepStatsInterval);
  whepStatsInterval = null;
  
  if (whepSessionUrl) {
    logHttp('DELETE', whepSessionUrl, 'Terminating WHEP subscription...');
    try {
      await fetch(whepSessionUrl, { method: 'DELETE' });
      logHttp('DELETE', whepSessionUrl, '200 OK - Session Closed');
    } catch (e) {
      console.warn('Error deleting WHEP session:', e);
    }
    whepSessionUrl = null;
  }
  
  if (whepPC) {
    whepPC.close();
    whepPC = null;
  }
  
  const videoEl = document.getElementById('whep-video');
  videoEl.srcObject = null;
  whepMediaStream = null;
  
  document.getElementById('whep-placeholder').style.display = 'flex';
  document.getElementById('whep-overlay').style.display = 'none';
  document.getElementById('whep-state-badge').style.display = 'none';
  const audioBtn = document.getElementById('audio-toggle-btn');
  if (audioBtn) audioBtn.style.display = 'none';
  
  const startBtn = document.getElementById('whep-start-btn');
  const stopBtn = document.getElementById('whep-stop-btn');
  startBtn.disabled = false;
  startBtn.innerHTML = `<i class="fa-solid fa-play"></i> Subscribe (WHEP)`;
  stopBtn.disabled = true;
  
  resetStats();
}

function toggleWhepAudio() {
  const videoEl = document.getElementById('whep-video');
  const audioBtn = document.getElementById('audio-toggle-btn');
  if (!videoEl || !audioBtn) return;
  
  videoEl.muted = !videoEl.muted;
  if (videoEl.muted) {
    audioBtn.innerHTML = `<i class="fa-solid fa-volume-xmark" style="color: var(--accent-rose);"></i> Muted`;
    audioBtn.style.borderColor = 'var(--accent-rose)';
  } else {
    audioBtn.innerHTML = `<i class="fa-solid fa-volume-high" style="color: var(--accent-emerald);"></i> Audio On`;
    audioBtn.style.borderColor = 'var(--accent-emerald)';
    videoEl.play().catch(() => {});
  }
}

// --- WHIP (Ingestion Broadcast) ---
function onSourceChange() {
  const source = document.getElementById('source-select').value;
  const camGroup = document.getElementById('camera-select-group');
  camGroup.style.display = (source === 'camera') ? 'block' : 'none';
}

async function startWhipPreview() {
  if (whipStream) stopWhipPreview();
  
  const source = document.getElementById('source-select').value;
  const previewEl = document.getElementById('whip-preview');
  const canvasEl = document.getElementById('whip-canvas');
  const placeholder = document.getElementById('whip-placeholder');
  
  try {
    if (source === 'camera') {
      previewEl.style.display = 'block';
      canvasEl.style.display = 'none';
      
      const resVal = document.getElementById('resolution-select').value;
      const height = parseInt(resVal);
      const width = Math.round(height * (16 / 9));
      
      whipStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: 30 } },
        audio: true
      });
      previewEl.srcObject = whipStream;
      
    } else if (source === 'screen') {
      previewEl.style.display = 'block';
      canvasEl.style.display = 'none';
      
      whipStream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', frameRate: 60 },
        audio: true
      });
      previewEl.srcObject = whipStream;
      
    } else if (source === 'canvas') {
      previewEl.style.display = 'none';
      canvasEl.style.display = 'block';
      
      whipStream = startCanvasGenerator(canvasEl);
    }
    
    placeholder.style.display = 'none';
    document.getElementById('whip-start-btn').disabled = false;
  } catch (err) {
    console.error('Error starting preview:', err);
    alert(`Could not open media source: ${err.message}`);
  }
}

function stopWhipPreview() {
  if (canvasAnimId) cancelAnimationFrame(canvasAnimId);
  canvasAnimId = null;
  
  if (audioOsc) {
    audioOsc.stop();
    audioOsc = null;
  }
  if (audioContext) {
    audioContext.close();
    audioContext = null;
  }
  
  if (whipStream) {
    whipStream.getTracks().forEach(t => t.stop());
    whipStream = null;
  }
  
  const previewEl = document.getElementById('whip-preview');
  previewEl.srcObject = null;
  document.getElementById('whip-placeholder').style.display = 'flex';
}

async function startWhipBroadcast() {
  if (!whipStream) {
    await startWhipPreview();
    if (!whipStream) return;
  }
  
  const channel = document.getElementById('whip-channel-input').value.trim() || 'live-demo';
  const startBtn = document.getElementById('whip-start-btn');
  const stopBtn = document.getElementById('whip-stop-btn');
  const badge = document.getElementById('whip-state-badge');
  
  startBtn.disabled = true;
  startBtn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i> Negotiating WHIP...`;
  
  try {
    whipPC = new RTCPeerConnection(ICE_SERVERS);
    
    whipStream.getTracks().forEach(track => {
      const sender = whipPC.addTrack(track, whipStream);
      if (track.kind === 'video') {
        const params = sender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 6000000; // 6 Mbps Target
        sender.setParameters(params);
      }
    });
    
    whipPC.onconnectionstatechange = () => {
      console.log('WHIP Connection State:', whipPC.connectionState);
      if (whipPC.connectionState === 'connected') {
        startBtn.style.display = 'none';
        stopBtn.style.display = 'inline-flex';
        stopBtn.disabled = false;
        badge.style.display = 'flex';
        startWhipTelemetry();
        fetchStreams();
      } else if (['disconnected', 'failed', 'closed'].includes(whipPC.connectionState)) {
        stopWhipBroadcast();
      }
    };
    
    const offer = await whipPC.createOffer();
    await whipPC.setLocalDescription(offer);
    
    lastSdpOffer = offer.sdp;
    updateSdpInspector('offer', offer.sdp);
    logHttp('POST', `/api/whip?channel=${channel}`, 'Sending WHIP SDP Offer...');
    
    const res = await fetch(`/api/whip?channel=${channel}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: offer.sdp
    });
    
    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`WHIP Server error ${res.status}: ${errText}`);
    }
    
    logHttp('POST', `/api/whip?channel=${channel}`, `${res.status} Created - SDP Answer Received`);
    whipSessionUrl = res.headers.get('Location');
    
    const answerSdp = await res.text();
    lastSdpAnswer = answerSdp;
    updateSdpInspector('answer', answerSdp);
    
    await whipPC.setRemoteDescription(new RTCSessionDescription({
      type: 'answer',
      sdp: answerSdp
    }));
    
  } catch (err) {
    console.error('WHIP error:', err);
    alert(`Failed to start WHIP broadcast: ${err.message}`);
    stopWhipBroadcast();
  }
}

async function stopWhipBroadcast() {
  if (whipStatsInterval) clearInterval(whipStatsInterval);
  whipStatsInterval = null;
  
  if (whipSessionUrl) {
    logHttp('DELETE', whipSessionUrl, 'Terminating WHIP broadcast session...');
    try {
      await fetch(whipSessionUrl, { method: 'DELETE' });
      logHttp('DELETE', whipSessionUrl, '200 OK - Broadcast Terminated');
    } catch (e) {
      console.warn('Error deleting WHIP session:', e);
    }
    whipSessionUrl = null;
  }
  
  if (whipPC) {
    whipPC.close();
    whipPC = null;
  }
  
  stopWhipPreview();
  
  const startBtn = document.getElementById('whip-start-btn');
  const stopBtn = document.getElementById('whip-stop-btn');
  startBtn.style.display = 'inline-flex';
  startBtn.disabled = false;
  startBtn.innerHTML = `<i class="fa-solid fa-tower-broadcast"></i> GO LIVE (WHIP)`;
  stopBtn.style.display = 'none';
  document.getElementById('whip-state-badge').style.display = 'none';
  
  document.getElementById('whip-stat-bitrate').innerHTML = `0 <span class="stat-unit">kbps</span>`;
  document.getElementById('whip-stat-fps').innerHTML = `0 <span class="stat-unit">fps</span>`;
  
  fetchStreams();
}

// --- Canvas Synthetic Generator ---
function startCanvasGenerator(canvas) {
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  
  let frame = 0;
  const startTime = Date.now();
  
  function draw() {
    frame++;
    const now = Date.now();
    const elapsed = (now - startTime) / 1000;
    
    // Background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // Grid
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.1)';
    ctx.lineWidth = 1;
    for (let x = 0; x < canvas.width; x += 40) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, canvas.height); ctx.stroke();
    }
    for (let y = 0; y < canvas.height; y += 40) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y); ctx.stroke();
    }
    
    // Animated Radar
    const cx = 350, cy = 360, r = 200;
    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, r * 0.6, 0, Math.PI * 2); ctx.stroke();
    
    // High Entropy Visual Noise (to force high bitrate encoding up to 6 Mbps)
    const noiseSize = 8;
    for (let i = 0; i < 3000; i++) {
      ctx.fillStyle = `hsl(${Math.random() * 360}, 100%, 50%)`;
      ctx.fillRect(
        Math.random() * canvas.width, 
        Math.random() * canvas.height, 
        noiseSize, 
        noiseSize
      );
    }
    
    const angle = (elapsed * 3) % (Math.PI * 2);
    ctx.strokeStyle = '#34d399';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + r * Math.cos(angle), cy + r * Math.sin(angle));
    ctx.stroke();
    
    // Bouncing Ball
    const bx = 800 + Math.sin(elapsed * 4) * 250;
    const by = 200 + Math.cos(elapsed * 6) * 120;
    ctx.fillStyle = '#f43f5e';
    ctx.beginPath(); ctx.arc(bx, by, 30, 0, Math.PI * 2); ctx.fill();
    
    // Text Telemetry
    ctx.fillStyle = '#38bdf8';
    ctx.font = 'bold 36px Outfit, sans-serif';
    ctx.fillText('PULSESTREAM BROWSER STUDIO WHIP SOURCE', 100, 80);
    
    const timeStr = new Date().toISOString().replace('T', ' ').replace('Z', '');
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 48px Fira Code, monospace';
    ctx.fillText(`UTC: ${timeStr}`, 100, 600);
    
    ctx.fillStyle = '#94a3b8';
    ctx.font = '28px Fira Code, monospace';
    ctx.fillText(`FRAME: #${frame} | STREAM BITRATE TEST PATTERN`, 100, 650);
    
    canvasAnimId = requestAnimationFrame(draw);
  }
  
  draw();
  const videoStream = canvas.captureStream(60);
  
  // Generate Audio Oscillator Beep
  try {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const dest = audioContext.createMediaStreamDestination();
    audioOsc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    
    audioOsc.type = 'sine';
    audioOsc.frequency.value = 440;
    gain.gain.value = 0.1;
    
    audioOsc.connect(gain);
    gain.connect(dest);
    audioOsc.start();
    
    const audioTrack = dest.stream.getAudioTracks()[0];
    if (audioTrack) videoStream.addTrack(audioTrack);
  } catch (e) {
    console.warn('AudioContext failed:', e);
  }
  
  return videoStream;
}

// --- Telemetry & Analytics ---
let lastBytesReceived = 0;
let lastFramesDecoded = 0;
let lastTimestamp = Date.now();

function startWhepTelemetry() {
  if (whepStatsInterval) clearInterval(whepStatsInterval);
  lastBytesReceived = 0;
  lastFramesDecoded = 0;
  lastTimestamp = Date.now();
  
  whepStatsInterval = setInterval(async () => {
    if (!whepPC) return;
    try {
      const stats = await whepPC.getStats();
      const now = Date.now();
      const dt = (now - lastTimestamp) / 1000;
      
      stats.forEach(report => {
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          const bytes = report.bytesReceived || 0;
          const frames = report.framesDecoded || 0;
          
          if (lastBytesReceived > 0 && dt > 0) {
            const kbps = Math.round(((bytes - lastBytesReceived) * 8) / (dt * 1000));
            const fps = Math.round((frames - lastFramesDecoded) / dt);
            
            document.getElementById('stat-bitrate').innerHTML = `${kbps} <span class="stat-unit">kbps</span>`;
            document.getElementById('stat-fps').innerHTML = `${fps} <span class="stat-unit">fps</span>`;
          }
          
          lastBytesReceived = bytes;
          lastFramesDecoded = frames;
          
          if (report.packetsLost !== undefined && report.packetsReceived !== undefined) {
            const total = report.packetsLost + report.packetsReceived;
            const loss = total > 0 ? ((report.packetsLost / total) * 100).toFixed(1) : '0.0';
            document.getElementById('stat-loss').innerHTML = `${loss} <span class="stat-unit">%</span>`;
          }
          
          if (report.frameWidth && report.frameHeight) {
            const codec = report.decoderImplementation || 'VP8/H.264';
            document.getElementById('stat-codec').innerText = `${codec} (${report.frameWidth}x${report.frameHeight})`;
          }
        }
        
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          if (report.currentRoundTripTime !== undefined) {
            const rttMs = Math.round(report.currentRoundTripTime * 1000);
            document.getElementById('stat-rtt').innerHTML = `${rttMs} <span class="stat-unit">ms</span>`;
          }
        }
        
        if (report.type === 'remote-candidate' || report.type === 'local-candidate') {
          if (report.candidateType) {
            document.getElementById('stat-ice').innerText = `${report.candidateType.toUpperCase()} (UDP/STUN)`;
          }
        }
      });
      lastTimestamp = now;
    } catch (e) {
      console.error('Telemetry error:', e);
    }
  }, 1000);
}

let lastWhipBytes = 0;
let lastWhipFrames = 0;
let lastWhipTime = Date.now();

function startWhipTelemetry() {
  if (whipStatsInterval) clearInterval(whipStatsInterval);
  lastWhipBytes = 0;
  lastWhipFrames = 0;
  lastWhipTime = Date.now();
  
  whipStatsInterval = setInterval(async () => {
    if (!whipPC) return;
    try {
      const stats = await whipPC.getStats();
      const now = Date.now();
      const dt = (now - lastWhipTime) / 1000;
      
      stats.forEach(report => {
        if (report.type === 'outbound-rtp' && report.kind === 'video') {
          const bytes = report.bytesSent || 0;
          const frames = report.framesEncoded || 0;
          
          if (lastWhipBytes > 0 && dt > 0) {
            const kbps = Math.round(((bytes - lastWhipBytes) * 8) / (dt * 1000));
            const fps = Math.round((frames - lastWhipFrames) / dt);
            
            document.getElementById('whip-stat-bitrate').innerHTML = `${kbps} <span class="stat-unit">kbps</span>`;
            document.getElementById('whip-stat-fps').innerHTML = `${fps} <span class="stat-unit">fps</span>`;
          }
          lastWhipBytes = bytes;
          lastWhipFrames = frames;
        }
      });
      lastWhipTime = now;
    } catch (e) {
      console.error('WHIP telemetry error:', e);
    }
  }, 1000);
}

function resetStats() {
  document.getElementById('stat-fps').innerHTML = `0 <span class="stat-unit">fps</span>`;
  document.getElementById('stat-bitrate').innerHTML = `0 <span class="stat-unit">kbps</span>`;
  document.getElementById('stat-loss').innerHTML = `0.0 <span class="stat-unit">%</span>`;
  document.getElementById('stat-rtt').innerHTML = `0 <span class="stat-unit">ms</span>`;
  document.getElementById('stat-codec').innerText = `--`;
  document.getElementById('stat-ice').innerText = `--`;
}

// --- Protocol & HTTP Inspector ---
function logHttp(method, url, statusText) {
  const box = document.getElementById('http-log-box');
  const time = new Date().toLocaleTimeString();
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.innerHTML = `
    <span class="log-time">[${time}]</span> 
    <span class="log-method">${method}</span> 
    <span class="log-url">${url}</span> -> 
    <span class="log-status">${statusText}</span>
  `;
  box.prepend(entry);
}

function updateSdpInspector(type, sdpText) {
  if (type === 'offer') lastSdpOffer = sdpText;
  if (type === 'answer') lastSdpAnswer = sdpText;
  showSdp(type);
}

function showSdp(type) {
  const box = document.getElementById('sdp-inspector-box');
  const content = (type === 'offer') ? lastSdpOffer : lastSdpAnswer;
  
  if (!content) {
    box.innerText = `No SDP ${type.toUpperCase()} recorded yet.`;
    return;
  }
  
  box.innerText = `=== WEB RTC SDP ${type.toUpperCase()} ===\n\n` + content;
}

// --- Initialization ---
window.addEventListener('DOMContentLoaded', () => {
  fetchServerStatus();
  fetchStreams();
  setInterval(fetchServerStatus, 3000);
  setInterval(fetchStreams, 5000);
});
