// Classroom Voice Receiver - Central Audio Hub Logic

let socket = null;
let audioCtx = null;
let masterGainNode = null;
let analyserNode = null;
let isAudioUnlocked = false;
let isMuted = false;
let currentVolume = 1.0;

// WebRTC connections map: studentId -> RTCPeerConnection
const peerConnections = new Map();

// Timer state
let speakerTimerInterval = null;
let speakerStartTime = null;

// DOM Elements
const connectionStatus = document.getElementById('connectionStatus');
const connectionStatusText = document.getElementById('connectionStatusText');
const studentCountElem = document.getElementById('studentCount');
const rosterCountBadge = document.getElementById('rosterCountBadge');
const speakerAvatarRing = document.getElementById('speakerAvatarRing');
const speakerNameDisplay = document.getElementById('speakerNameDisplay');
const speakerStatusCaption = document.getElementById('speakerStatusCaption');
const speakingTimer = document.getElementById('speakingTimer');
const studentListContainer = document.getElementById('studentListContainer');
const qrCodeImg = document.getElementById('qrCodeImg');
const studentUrlText = document.getElementById('studentUrlText');
const btnCopyUrl = document.getElementById('btnCopyUrl');
const btnAudioUnlock = document.getElementById('btnAudioUnlock');
const volumeSlider = document.getElementById('volumeSlider');
const volumeValueText = document.getElementById('volumeValueText');
const btnMuteAll = document.getElementById('btnMuteAll');
const btnTestChime = document.getElementById('btnTestChime');
const btnEndSession = document.getElementById('btnEndSession');
const canvas = document.getElementById('audioVisualizer');
const canvasCtx = canvas.getContext('2d');
const remoteAudio = document.getElementById('remoteAudio');

// New Status Cards
const cardStudentCount = document.getElementById('cardStudentCount');
const cardAudioStatus = document.getElementById('cardAudioStatus');
const cardNetworkStatus = document.getElementById('cardNetworkStatus');
const cardOutputDevice = document.getElementById('cardOutputDevice');

// ICE configuration (LAN host candidates prioritised)
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// 1. Initialize Audio Context (Web Audio Pipeline)
function initAudioContext() {
  if (audioCtx) {
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return;
  }

  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContextClass({ latencyHint: 'interactive' });

  // Create Master Gain (Volume Control)
  masterGainNode = audioCtx.createGain();
  masterGainNode.gain.value = currentVolume;

  // Create Analyser for Visualizer
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 256;
  analyserNode.smoothingTimeConstant = 0.8;

  // Connect master gain -> analyser -> speakers
  masterGainNode.connect(analyserNode);
  analyserNode.connect(audioCtx.destination);

  isAudioUnlocked = true;
  btnAudioUnlock.innerHTML = '✅ Audio Ready';
  btnAudioUnlock.classList.remove('btn-primary');
  btnAudioUnlock.classList.add('btn-secondary');
  console.log('[Audio] AudioContext initialized and active');
}

// 2. Play Test Tone (Verify Classroom Speakers)
function playTestChime() {
  initAudioContext();
  if (!audioCtx) return;

  const now = audioCtx.currentTime;
  const osc = audioCtx.createOscillator();
  const chimeGain = audioCtx.createGain();

  osc.type = 'sine';
  osc.frequency.setValueAtTime(523.25, now); // C5
  osc.frequency.exponentialRampToValueAtTime(659.25, now + 0.15); // E5
  osc.frequency.exponentialRampToValueAtTime(783.99, now + 0.3); // G5

  chimeGain.gain.setValueAtTime(0, now);
  chimeGain.gain.linearRampToValueAtTime(0.3, now + 0.05);
  chimeGain.gain.exponentialRampToValueAtTime(0.001, now + 0.6);

  osc.connect(chimeGain);
  chimeGain.connect(masterGainNode);

  osc.start(now);
  osc.stop(now + 0.6);
}

// 3. Fetch Server Configuration (URL & QR Code)
async function fetchConfig() {
  try {
    const res = await fetch('/api/config');
    const data = await res.json();

    if (data.qrCodeDataUrl) {
      qrCodeImg.src = data.qrCodeDataUrl;
    }
    if (data.studentUrl) {
      studentUrlText.textContent = data.studentUrl;
      studentUrlText.title = data.studentUrl;
    }
  } catch (err) {
    console.warn('[Config] Failed to fetch server configuration:', err);
    studentUrlText.textContent = `${window.location.origin}/student.html`;
  }
}

// 4. WebSocket PCM Audio Stream Playback (Jitter Buffer)
let pcmNextPlayTime = 0;
function handleIncomingPcmChunk(chunkBuffer) {
  initAudioContext();
  if (!audioCtx || isMuted) return;

  // chunkBuffer is Int16 array buffer from student
  const int16Array = new Int16Array(chunkBuffer);
  const sampleRate = 24000;
  const audioBuffer = audioCtx.createBuffer(1, int16Array.length, sampleRate);
  const channelData = audioBuffer.getChannelData(0);

  // Convert Int16 (-32768 to 32767) to Float32 (-1.0 to 1.0)
  for (let i = 0; i < int16Array.length; i++) {
    channelData[i] = int16Array[i] / 32768;
  }

  const source = audioCtx.createBufferSource();
  source.buffer = audioBuffer;
  source.connect(masterGainNode);

  const currentTime = audioCtx.currentTime;
  if (pcmNextPlayTime < currentTime) {
    pcmNextPlayTime = currentTime + 0.02; // 20ms minimal jitter buffer
  }

  source.start(pcmNextPlayTime);
  pcmNextPlayTime += audioBuffer.duration;
}

// 5. WebRTC Peer Connection Management
function getOrCreatePeerConnection(studentId) {
  if (peerConnections.has(studentId)) {
    return peerConnections.get(studentId);
  }

  console.log(`[WebRTC] Creating RTCPeerConnection for student: ${studentId}`);
  const pc = new RTCPeerConnection(rtcConfig);

  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', {
        to: studentId,
        data: { candidate: event.candidate }
      });
    }
  };

  pc.ontrack = (event) => {
    console.log(`[WebRTC] Received remote audio track from ${studentId}`);
    initAudioContext();

    // Attach stream to hidden audio element
    remoteAudio.srcObject = event.streams[0];
    remoteAudio.play().catch(e => console.log('Audio autoplay prevented:', e));

    // Connect remote stream to Web Audio graph for visualizer & master volume
    try {
      if (audioCtx) {
        const streamSource = audioCtx.createMediaStreamSource(event.streams[0]);
        streamSource.connect(masterGainNode);
      }
    } catch (e) {
      console.warn('[Audio] Could not route MediaStream to Web Audio context:', e);
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC] Connection state with ${studentId}: ${pc.connectionState}`);
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
      peerConnections.delete(studentId);
    }
  };

  peerConnections.set(studentId, pc);
  return pc;
}

// 6. Socket.IO Handlers & Real-Time Signaling
function setupSocket() {
  socket = io({
    transports: ['polling'],   // Stable polling — avoids WSS cert issues on local HTTPS
    reconnectionAttempts: 20,
    reconnectionDelay: 1000
  });

  socket.on('connect', () => {
    console.log('[Socket] Connected to server as receiver');
    connectionStatus.className = 'status-badge';
    connectionStatusText.textContent = 'Active & Ready';
    if (cardNetworkStatus) {
      cardNetworkStatus.textContent = 'Online';
      cardNetworkStatus.className = 'status-card-value active';
    }
    socket.emit('register-receiver');
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Disconnected from server');
    connectionStatus.className = 'status-badge offline';
    connectionStatusText.textContent = 'Disconnected';
    if (cardNetworkStatus) {
      cardNetworkStatus.textContent = 'Offline';
      cardNetworkStatus.className = 'status-card-value';
    }
  });

  socket.on('receiver-registered', (data) => {
    console.log('[Receiver] Registered successfully. Active students:', data.students.length);
    renderStudentList(data.students);
    if (data.activeSpeaker) {
      setSpeakerActive(data.activeSpeaker.name, data.activeSpeaker.startTime);
    } else {
      setSpeakerIdle();
    }
  });

  socket.on('students-updated', (students) => {
    renderStudentList(students);
  });

  socket.on('speaker-active', ({ name, startTime }) => {
    setSpeakerActive(name, startTime);
  });

  socket.on('speaker-idle', () => {
    setSpeakerIdle();
  });

  // WebRTC Signal from Student
  socket.on('signal', async ({ from, data }) => {
    const pc = getOrCreatePeerConnection(from);

    try {
      if (data.sdp) {
        await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit('signal', {
            to: from,
            data: { sdp: pc.localDescription }
          });
        }
      } else if (data.candidate) {
        await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (err) {
      console.error('[WebRTC] Signaling error:', err);
    }
  });

  // WebSocket PCM Audio Chunks (High reliability fallback)
  socket.on('audio-chunk', ({ studentId, name, chunk }) => {
    handleIncomingPcmChunk(chunk);
  });
}

// 7. UI State Updates
function setSpeakerActive(name, startTime) {
  speakerNameDisplay.textContent = 'LIVE SPEAKER';
  speakerAvatarRing.classList.add('active');
  speakerStatusCaption.firstElementChild.textContent = name;
  speakingTimer.classList.remove('hidden');
  
  if (cardAudioStatus) {
    cardAudioStatus.textContent = 'Transmitting';
    cardAudioStatus.className = 'status-card-value active';
  }

  speakerStartTime = startTime || Date.now();
  if (speakerTimerInterval) clearInterval(speakerTimerInterval);
  
  updateTimerDisplay();
  speakerTimerInterval = setInterval(updateTimerDisplay, 1000);
}

function setSpeakerIdle() {
  speakerNameDisplay.textContent = 'CLASSROOM AUDIO STANDBY';
  speakerAvatarRing.classList.remove('active');
  speakerStatusCaption.firstElementChild.textContent = 'Waiting for a student to speak';
  speakingTimer.classList.add('hidden');
  
  if (cardAudioStatus) {
    cardAudioStatus.textContent = 'Standby';
    cardAudioStatus.className = 'status-card-value';
  }

  if (speakerTimerInterval) {
    clearInterval(speakerTimerInterval);
    speakerTimerInterval = null;
  }
}

function updateTimerDisplay() {
  if (!speakerStartTime) return;
  const elapsedSec = Math.floor((Date.now() - speakerStartTime) / 1000);
  const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
  const secs = String(elapsedSec % 60).padStart(2, '0');
  speakingTimer.textContent = `${mins}:${secs}`;
}

function renderStudentList(students) {
  const count = students ? students.length : 0;
  studentCountElem.textContent = count;
  rosterCountBadge.textContent = `${count} active`;
  
  if (cardStudentCount) {
    cardStudentCount.textContent = `${count} Connected`;
    cardStudentCount.className = count > 0 ? 'status-card-value active' : 'status-card-value';
  }

  if (!students || students.length === 0) {
    studentListContainer.innerHTML = `
      <div style="text-align: center; padding: 1.5rem; color: var(--text-muted); font-size: 0.85rem;">
        Waiting for students to connect...
      </div>
    `;
    return;
  }

  studentListContainer.innerHTML = '';
  students.forEach(student => {
    const item = document.createElement('div');
    item.className = `student-item ${student.isSpeaking ? 'speaking' : ''}`;
    item.innerHTML = `
      <div class="student-item-name">
        <span>${student.isSpeaking ? '🟢' : '⚪'}</span>
        <span>${escapeHtml(student.name)}</span>
      </div>
      <span style="font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono);">
        ${student.isSpeaking ? 'Talking' : 'Ready'}
      </span>
    `;
    studentListContainer.appendChild(item);
  });
}

function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[m]);
}

// 8. Visualizer Canvas Render Loop
function initVisualizer() {
  function resizeCanvas() {
    canvas.width = canvas.parentElement.clientWidth;
    canvas.height = canvas.parentElement.clientHeight;
  }
  window.addEventListener('resize', resizeCanvas);
  resizeCanvas();

  const bufferLength = analyserNode ? analyserNode.frequencyBinCount : 128;
  const dataArray = new Uint8Array(bufferLength);

  let idlePhase = 0;

  function renderFrame() {
    requestAnimationFrame(renderFrame);

    const width = canvas.width;
    const height = canvas.height;
    canvasCtx.clearRect(0, 0, width, height);

    if (analyserNode && isAudioUnlocked) {
      analyserNode.getByteFrequencyData(dataArray);

      // Check if there is actual audio activity
      let sum = 0;
      for (let i = 0; i < bufferLength; i++) sum += dataArray[i];
      const avg = sum / bufferLength;

      if (avg > 5) {
        // Draw frequency bars
        const barWidth = (width / bufferLength) * 2.5;
        let x = 0;

        for (let i = 0; i < bufferLength; i++) {
          const barHeight = (dataArray[i] / 255) * height * 0.9;

          // Gradient color: Soft Mint Green based on requested palette
          const gradient = canvasCtx.createLinearGradient(0, height, 0, height - barHeight);
          gradient.addColorStop(0, '#527D64'); // Primary Button Green
          gradient.addColorStop(0.5, '#6EAF83'); // Active Lime/Mint Green
          gradient.addColorStop(1, '#527D64');

          canvasCtx.fillStyle = gradient;
          canvasCtx.fillRect(x, height - barHeight, barWidth - 1, barHeight);

          x += barWidth + 1;
          if (x > width) break;
        }
        return;
      }
    }

    // Ambient resting gentle sine wave when silent
    canvasCtx.lineWidth = 2;
    canvasCtx.strokeStyle = 'rgba(69, 107, 87, 0.25)'; // Dark Sage Green transparent
    canvasCtx.beginPath();

    const sliceWidth = width / 100;
    let x = 0;
    idlePhase += 0.03;

    for (let i = 0; i <= 100; i++) {
      const y = (height / 2) + Math.sin(i * 0.15 + idlePhase) * 6;
      if (i === 0) canvasCtx.moveTo(x, y);
      else canvasCtx.lineTo(x, y);
      x += sliceWidth;
    }

    canvasCtx.stroke();
  }

  renderFrame();
}

// 9. Event Listeners
btnAudioUnlock.addEventListener('click', () => {
  initAudioContext();
  playTestChime();
});

volumeSlider.addEventListener('input', (e) => {
  currentVolume = parseFloat(e.target.value);
  volumeValueText.textContent = `${Math.round(currentVolume * 100)}%`;
  if (masterGainNode && !isMuted) {
    masterGainNode.gain.value = currentVolume;
  }
});

btnMuteAll.addEventListener('click', () => {
  isMuted = !isMuted;
  if (isMuted) {
    if (masterGainNode) masterGainNode.gain.value = 0;
    btnMuteAll.innerHTML = '🔈 Unmute';
    btnMuteAll.classList.remove('btn-danger');
    btnMuteAll.classList.add('btn-secondary');
  } else {
    if (masterGainNode) masterGainNode.gain.value = currentVolume;
    btnMuteAll.innerHTML = '🛑 Mute All';
    btnMuteAll.classList.remove('btn-secondary');
    btnMuteAll.classList.add('btn-danger');
  }
});

btnTestChime.addEventListener('click', () => {
  playTestChime();
});

btnEndSession.addEventListener('click', () => {
  if (confirm('Are you sure you want to end the classroom session? This will disconnect all students.')) {
    console.log('[Receiver] Ending session...');
    socket.emit('end-session');
    alert('Session has been ended. All students disconnected.');
  }
});

btnCopyUrl.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(studentUrlText.textContent);
    btnCopyUrl.textContent = '✅ Copied!';
    setTimeout(() => { btnCopyUrl.textContent = '📋 Copy'; }, 2000);
  } catch (err) {
    prompt('Copy this link:', studentUrlText.textContent);
  }
});

// Start initialization
document.addEventListener('DOMContentLoaded', () => {
  fetchConfig();
  setupSocket();
  initVisualizer();

  // Try auto-unlocking audio on any first user interaction on the page
  document.addEventListener('click', () => {
    if (!isAudioUnlocked) initAudioContext();
  }, { once: true });
});
