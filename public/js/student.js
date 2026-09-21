// Student Mobile Microphone Logic

let socket = null;
let mediaStream = null;
let audioTrack = null;
let peerConnection = null;
let audioCtx = null;
let analyserNode = null;
let processorNode = null;

let isRegistered = false;
let isHoldingFloor = false;
let isFloorLockedByOther = false;
let isRequestingFloor = false;  // Guard against rapid double-taps
let studentName = '';
let speakingStartTime = null;
let timerInterval = null;

// DOM Elements
const joinScreen = document.getElementById('joinScreen');
const talkScreen = document.getElementById('talkScreen');
const studentNameInput = document.getElementById('studentNameInput');
const btnJoinRoom = document.getElementById('btnJoinRoom');
const joinErrorMessage = document.getElementById('joinErrorMessage');
const mobileConnectionBadge = document.getElementById('mobileConnectionBadge');
const mobileStatusText = document.getElementById('mobileStatusText');
const userNameBadge = document.getElementById('userNameBadge');
const userAvatarBadge = document.getElementById('userAvatarBadge');
const streamTypeBadge = document.getElementById('streamTypeBadge');
const btnPushToTalk = document.getElementById('btnPushToTalk');
const pttButtonLabel = document.getElementById('pttButtonLabel');
const mainStatusText = document.getElementById('mainStatusText');
const subStatusText = document.getElementById('subStatusText');
const speakingTimerMobile = document.getElementById('speakingTimerMobile');
const vuFill = document.getElementById('vuFill');
const btnLeaveSession = document.getElementById('btnLeaveSession');

// ICE configuration
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// 1. Check Browser Environment & Security Context
function checkSecureContext() {
  const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (!window.isSecureContext && !isLocalhost) {
    showJoinError(
      '⚠️ Insecure Connection: Mobile browsers block microphones unless HTTPS is used. ' +
      'Please make sure you are accessing https://... and accept the certificate warning.'
    );
    return false;
  }
  return true;
}

// 2. Initialize Microphone & Web Audio Graph
async function initMicrophone() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('Microphone API (getUserMedia) not supported or blocked by browser security.');
  }

  // Audio constraints with echo cancellation, noise suppression & auto gain
  const constraints = {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
      sampleRate: 24000
    },
    video: false
  };

  mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  audioTrack = mediaStream.getAudioTracks()[0];
  
  // Keep mic muted initially until student taps "TAP TO SPEAK"
  audioTrack.enabled = false;

  // Set up AudioContext for VU meter & PCM streaming
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  audioCtx = new AudioContextClass({ latencyHint: 'interactive' });
  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  const micSource = audioCtx.createMediaStreamSource(mediaStream);

  // Analyser for local VU meter
  analyserNode = audioCtx.createAnalyser();
  analyserNode.fftSize = 128;
  micSource.connect(analyserNode);

  // ScriptProcessor to send binary Int16 PCM chunks as reliable fallback
  // Buffer size: 1024 samples at 24kHz = ~42ms latency
  processorNode = audioCtx.createScriptProcessor(1024, 1, 1);
  processorNode.onaudioprocess = (e) => {
    if (!isHoldingFloor) return;

    const inputData = e.inputBuffer.getChannelData(0);
    const int16Buffer = new Int16Array(inputData.length);

    // Convert Float32 (-1.0 to 1.0) to Int16 (-32768 to 32767)
    for (let i = 0; i < inputData.length; i++) {
      const s = Math.max(-1, Math.min(1, inputData[i]));
      int16Buffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Send binary chunk over WebSocket
    if (socket && socket.connected) {
      socket.emit('audio-chunk', int16Buffer.buffer);
    }
  };

  micSource.connect(processorNode);
  // Connect to silent gain to keep processor running without local speaker output
  const silentGain = audioCtx.createGain();
  silentGain.gain.value = 0;
  processorNode.connect(silentGain);
  silentGain.connect(audioCtx.destination);

  startVuMeter();
  console.log('[Mic] Microphone acquired and audio graph initialized');
}

// 3. WebRTC Peer Connection with Receiver
async function setupWebRTC() {
  console.log('[WebRTC] Initiating peer connection to receiver');
  peerConnection = new RTCPeerConnection(rtcConfig);

  // Add audio track to peer connection
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, mediaStream);
    });
  }

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && socket) {
      socket.emit('signal', { data: { candidate: event.candidate } });
    }
  };

  peerConnection.onconnectionstatechange = () => {
    console.log('[WebRTC] Connection state:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'connected') {
      streamTypeBadge.textContent = '⚡ WebRTC + PCM';
    } else {
      streamTypeBadge.textContent = '📡 WebSocket Stream';
    }
  };

  // Create Offer
  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('signal', { data: { sdp: peerConnection.localDescription } });
  } catch (err) {
    console.warn('[WebRTC] Could not create offer, relying on WebSocket PCM:', err);
  }
}

// 4. Socket.IO Connection & Signaling
function setupSocket() {
  socket = io({
    transports: ['polling'],   // Force XHR polling only — WSS upgrade fails on self-signed certs on mobile
    reconnectionAttempts: 10,
    reconnectionDelay: 2000,
    timeout: 10000
  });

  socket.on('connect', () => {
    console.log('[Socket] Connected to classroom server');
    mobileConnectionBadge.className = 'status-badge';
    mobileStatusText.textContent = 'Connected';

    if (isRegistered) {
      socket.emit('register-student', { name: studentName });
    }
  });

  socket.on('disconnect', () => {
    console.log('[Socket] Disconnected');
    mobileConnectionBadge.className = 'status-badge offline';
    mobileStatusText.textContent = 'Disconnected';
    stopSpeaking();
  });

  socket.on('student-registered', (data) => {
    console.log('[Student] Registered successfully');
    if (data.activeSpeaker && data.activeSpeaker.socketId !== socket.id) {
      handleFloorLocked(data.activeSpeaker.name);
    }
    setupWebRTC();
  });

  socket.on('floor-granted', () => {
    console.log('[Floor] Granted by classroom server');
    isRequestingFloor = false;
    startSpeaking();
  });

  socket.on('floor-denied', (data) => {
    console.log('[Floor] Denied:', data.reason);
    isRequestingFloor = false;
    if (data.currentSpeaker) {
      handleFloorLocked(data.currentSpeaker);
    }
    vibratePhone([50, 50, 50]); // Warning buzz
  });

  socket.on('floor-locked', ({ speakerName }) => {
    handleFloorLocked(speakerName);
  });

  socket.on('floor-free', () => {
    handleFloorFree();
  });

  socket.on('receiver-status', ({ online }) => {
    if (!online) {
      subStatusText.textContent = '⚠️ Laptop receiver is offline';
    } else if (!isHoldingFloor && !isFloorLockedByOther) {
      subStatusText.textContent = 'Ready — Tap the button to speak';
    }
  });

  // WebRTC Signal from Receiver (Answer / ICE candidate)
  socket.on('signal', async ({ data }) => {
    if (!peerConnection) return;

    try {
      if (data.sdp) {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(data.sdp));
      } else if (data.candidate) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
      }
    } catch (err) {
      console.error('[WebRTC] Signal handling error:', err);
    }
  });

  // Handle server-initiated session end
  socket.on('session-ended', () => {
    alert('The classroom session has been ended by the teacher.');
    leaveSession(false); // Force leave without confirmation
  });
}

// 5. Floor & Speaking State Controls (Toggle Mode)
function toggleSpeaking() {
  if (isHoldingFloor) {
    // Currently speaking → stop
    releaseFloor();
  } else {
    // Currently muted → request to speak
    requestFloor();
  }
}

function requestFloor() {
  if (isFloorLockedByOther || isHoldingFloor || isRequestingFloor) return;
  if (!socket || !socket.connected) {
    alert('Not connected to classroom server yet.');
    return;
  }
  isRequestingFloor = true;
  socket.emit('request-floor');
}

function releaseFloor() {
  if (!isHoldingFloor) return;
  socket.emit('release-floor');
  stopSpeaking();
}

function startSpeaking() {
  isHoldingFloor = true;
  if (audioTrack) audioTrack.enabled = true;

  btnPushToTalk.classList.add('talking');
  pttButtonLabel.textContent = 'STOP SPEAKING';

  mainStatusText.textContent = '🔴 LIVE';
  mainStatusText.style.color = 'var(--accent-emerald)';
  subStatusText.textContent = 'Transmitting to classroom speaker';

  speakingStartTime = Date.now();
  speakingTimerMobile.classList.remove('hidden');
  updateMobileTimer();
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(updateMobileTimer, 1000);

  vibratePhone(40); // Tactile confirmation
}

function stopSpeaking() {
  isHoldingFloor = false;
  isRequestingFloor = false;
  if (audioTrack) audioTrack.enabled = false;

  btnPushToTalk.classList.remove('talking');
  pttButtonLabel.textContent = 'TAP TO SPEAK';

  mainStatusText.textContent = 'MUTED';
  mainStatusText.style.color = 'var(--text-muted)';
  subStatusText.textContent = 'Tap the button to speak through classroom speaker';

  speakingTimerMobile.classList.add('hidden');
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  vuFill.style.width = '0%';
  vibratePhone(25); // Subtle release click
}

function handleFloorLocked(speakerName) {
  isFloorLockedByOther = true;
  isRequestingFloor = false;
  btnPushToTalk.classList.add('locked');
  pttButtonLabel.textContent = 'LOCKED';

  mainStatusText.textContent = `${speakerName} is speaking`;
  mainStatusText.style.color = 'var(--accent-amber)';
  subStatusText.textContent = 'Classroom channel is occupied. Please wait.';
}

function handleFloorFree() {
  isFloorLockedByOther = false;
  btnPushToTalk.classList.remove('locked');

  if (!isHoldingFloor) {
    pttButtonLabel.textContent = 'TAP TO SPEAK';
    mainStatusText.textContent = 'MUTED';
    mainStatusText.style.color = 'var(--text-muted)';
    subStatusText.textContent = 'Microphone ready. Tap button to answer.';
  }
}

function updateMobileTimer() {
  if (!speakingStartTime) return;
  const elapsedSec = Math.floor((Date.now() - speakingStartTime) / 1000);
  const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
  const secs = String(elapsedSec % 60).padStart(2, '0');
  speakingTimerMobile.textContent = `${mins}:${secs}`;
}

function vibratePhone(pattern) {
  if (navigator.vibrate) {
    navigator.vibrate(pattern);
  }
}

// 6. Local VU Meter Animation
function startVuMeter() {
  const dataArray = new Uint8Array(analyserNode.frequencyBinCount);

  function checkLevel() {
    requestAnimationFrame(checkLevel);

    if (isHoldingFloor && analyserNode) {
      analyserNode.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      const avg = sum / dataArray.length;
      const percentage = Math.min(100, Math.round((avg / 128) * 100));
      vuFill.style.width = `${percentage}%`;
    } else {
      vuFill.style.width = '0%';
    }
  }

  checkLevel();
}

function showJoinError(msg) {
  joinErrorMessage.textContent = msg;
  joinErrorMessage.classList.remove('hidden');
}

// 7. Session Teardown
function leaveSession(requireConfirmation = true) {
  if (requireConfirmation && !confirm('Are you sure you want to leave the classroom session?')) {
    return;
  }

  console.log('[App] Leaving session...');
  
  // Stop speaking if currently active
  if (isHoldingFloor) {
    releaseFloor();
  }

  // Stop hardware microphone tracks immediately
  if (audioTrack) {
    audioTrack.stop();
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
  }

  // Close WebRTC Connection
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  // Disconnect WebSocket to notify server we've left
  if (socket && socket.connected) {
    socket.disconnect();
  }

  // Reset UI State
  isRegistered = false;
  talkScreen.classList.add('hidden');
  joinScreen.classList.remove('hidden');
  btnJoinRoom.disabled = false;
  btnJoinRoom.textContent = '🎙️ Connect My Microphone';
  studentNameInput.value = '';
}

// 8. Event Listeners
btnJoinRoom.addEventListener('click', async () => {
  const name = studentNameInput.value.trim();
  if (!name) {
    showJoinError('Please enter your name.');
    studentNameInput.focus();
    return;
  }

  joinErrorMessage.classList.add('hidden');
  btnJoinRoom.disabled = true;
  btnJoinRoom.textContent = '⌛ Requesting Microphone...';

  try {
    await initMicrophone();
    studentName = name;
    isRegistered = true;

    userNameBadge.textContent = studentName;
    socket.emit('register-student', { name: studentName });

    // Transition screen
    joinScreen.classList.add('hidden');
    talkScreen.classList.remove('hidden');
    console.log('[App] Switched to talk screen');
  } catch (err) {
    console.error('[App] Mic error:', err);
    btnJoinRoom.disabled = false;
    btnJoinRoom.textContent = '🎙️ Connect My Microphone';

    let errorDetail = err.message || 'Could not access microphone.';
    if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
      errorDetail = 'Microphone permission was denied. Tap the lock icon in your browser address bar to allow microphone access.';
    }
    showJoinError(errorDetail);
  }
});

// Toggle PTT: Single tap toggles between speaking and muted
btnPushToTalk.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  toggleSpeaking();
});

// Prevent accidental pointerup from releasing floor (we are in toggle mode now)
btnPushToTalk.addEventListener('pointerup', (e) => {
  e.preventDefault();
  // No action — toggle is handled entirely in pointerdown
});

btnPushToTalk.addEventListener('pointercancel', (e) => {
  e.preventDefault();
  // No action — toggle mode, no release on cancel
});

// Keyboard spacebar shortcut for testing on laptop (toggle mode)
window.addEventListener('keydown', (e) => {
  if (e.code === 'Space' && !e.repeat && document.activeElement !== studentNameInput) {
    e.preventDefault();
    toggleSpeaking();
  }
});

// Leave Session Button
if (btnLeaveSession) {
  btnLeaveSession.addEventListener('click', () => {
    leaveSession(true);
  });
}

// Cleanup on tab close/refresh
window.addEventListener('beforeunload', () => {
  leaveSession(false);
});

window.addEventListener('pagehide', () => {
  leaveSession(false);
});

document.addEventListener('DOMContentLoaded', () => {
  checkSecureContext();
  setupSocket();
});
