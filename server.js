const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const express = require('express');
const { Server } = require('socket.io');
const selfsigned = require('selfsigned');
const QRCode = require('qrcode');

const HTTPS_PORT = process.env.HTTPS_PORT || 3000;
const HTTP_PORT = process.env.HTTP_PORT || 3080;

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// 1. Discover local IPv4 network addresses
function getNetworkInterfacesInfo() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const [name, netList] of Object.entries(interfaces)) {
    for (const net of netList) {
      // Look for non-internal IPv4
      if (net.family === 'IPv4' && !net.internal) {
        const isWiFi = /wi-?fi|wlan|wireless/i.test(name);
        const isEthernet = /ethernet|eth|en/i.test(name);
        addresses.push({
          interface: name,
          ip: net.address,
          isWiFi,
          isEthernet,
          priority: isWiFi ? 1 : isEthernet ? 2 : 3
        });
      }
    }
  }

  // Sort Wi-Fi first, then Ethernet, then others
  addresses.sort((a, b) => a.priority - b.priority);
  return addresses;
}

const networkAddresses = getNetworkInterfacesInfo();
const primaryAddress = networkAddresses.length > 0 ? networkAddresses[0].ip : 'localhost';

// 2. SSL Certificate Generation & Persistence
const certsDir = path.join(__dirname, 'certs');
const certPath = path.join(certsDir, 'cert.pem');
const keyPath = path.join(certsDir, 'key.pem');

async function getOrCreateCertificates() {
  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true });
  }

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return {
      cert: fs.readFileSync(certPath, 'utf8'),
      key: fs.readFileSync(keyPath, 'utf8')
    };
  }

  console.log('Generating local self-signed SSL certificates for HTTPS...');
  const altNames = [
    { type: 2, value: 'localhost' },
    { type: 7, ip: '127.0.0.1' }
  ];

  for (const net of networkAddresses) {
    altNames.push({ type: 7, ip: net.ip });
  }

  const pems = await selfsigned.generate(
    [{ name: 'commonName', value: primaryAddress }],
    {
      days: 365,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames }]
    }
  );

  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private);

  return { cert: pems.cert, key: pems.private };
}

// 3. API endpoint to provide connection info & QR codes to clients
let cachedQrDataUrl = '';
const primaryStudentUrl = `https://${primaryAddress}:${HTTPS_PORT}/student.html`;

QRCode.toDataURL(primaryStudentUrl, { margin: 1, width: 300 })
  .then(url => { cachedQrDataUrl = url; })
  .catch(err => console.error('Failed to generate QR code data URL:', err));

app.get('/api/config', (req, res) => {
  res.json({
    primaryIp: primaryAddress,
    port: HTTPS_PORT,
    studentUrl: primaryStudentUrl,
    receiverUrl: `https://${primaryAddress}:${HTTPS_PORT}/index.html`,
    allAddresses: networkAddresses,
    qrCodeDataUrl: cachedQrDataUrl
  });
});

async function start() {
  const sslCredentials = await getOrCreateCertificates();

  // 4. Create HTTPS Server and Socket.IO
  const httpsServer = https.createServer(sslCredentials, app);
  const io = new Server(httpsServer, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST'],
      allowedHeaders: ['Content-Type'],
      credentials: false
    },
    allowEIO3: true,                // Support older Engine.IO clients (some Android browsers)
    pingTimeout: 30000,             // How long to wait for a ping response (ms)
    pingInterval: 10000,            // Interval between pings (ms) — reduces drop-outs
    maxHttpBufferSize: 1e7          // 10MB buffer for binary audio chunks
  });

  // State Management
  let receiverSocketId = null;
  const students = new Map(); // socketId -> { id, name, isSpeaking, joinedAt, audioMode }
  let activeSpeaker = null;   // null or { socketId, name, startTime }

io.on('connection', (socket) => {
  // --- Laptop Receiver Handlers ---
  socket.on('register-receiver', () => {
    receiverSocketId = socket.id;
    console.log(`[Receiver] Laptop connected (socket: ${socket.id})`);

    // Send current state to newly connected receiver
    socket.emit('receiver-registered', {
      success: true,
      activeSpeaker,
      students: Array.from(students.values())
    });

    // Notify all students that the classroom receiver is online
    socket.broadcast.emit('receiver-status', { online: true });
  });

  // --- Student Handlers ---
  socket.on('register-student', ({ name }) => {
    const cleanName = (name && name.trim()) ? name.trim().slice(0, 30) : `Student-${socket.id.slice(0, 4)}`;
    const studentInfo = {
      id: socket.id,
      name: cleanName,
      isSpeaking: false,
      joinedAt: Date.now()
    };
    students.set(socket.id, studentInfo);
    console.log(`[Student] Registered: ${cleanName} (${socket.id})`);

    socket.emit('student-registered', {
      success: true,
      student: studentInfo,
      receiverOnline: Boolean(receiverSocketId),
      activeSpeaker
    });

    // Update receiver student list
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('students-updated', Array.from(students.values()));
    }
  });

  // --- Push-to-Talk Floor Control ---
  socket.on('request-floor', () => {
    const student = students.get(socket.id);
    if (!student) {
      socket.emit('floor-denied', { reason: 'Student not registered' });
      return;
    }

    if (!receiverSocketId) {
      socket.emit('floor-denied', { reason: 'Receiver is not connected yet' });
      return;
    }

    if (activeSpeaker && activeSpeaker.socketId !== socket.id) {
      // Floor is occupied by someone else
      socket.emit('floor-denied', {
        reason: 'Floor occupied',
        currentSpeaker: activeSpeaker.name
      });
      return;
    }

    if (activeSpeaker && activeSpeaker.socketId === socket.id) {
      // Already holds the floor, ignore duplicate request
      return;
    }

    // Grant floor
    activeSpeaker = {
      socketId: socket.id,
      name: student.name,
      startTime: Date.now()
    };
    student.isSpeaking = true;

    console.log(`[Floor] Granted to: ${student.name} (${socket.id})`);

    // Acknowledge requesting student
    socket.emit('floor-granted', { success: true });

    // Inform receiver who is speaking
    io.to(receiverSocketId).emit('speaker-active', {
      studentId: socket.id,
      name: student.name,
      startTime: activeSpeaker.startTime
    });

    // Notify other students that floor is locked
    socket.broadcast.emit('floor-locked', {
      speakerId: socket.id,
      speakerName: student.name
    });
  });

  socket.on('release-floor', () => {
    if (activeSpeaker && activeSpeaker.socketId === socket.id) {
      const student = students.get(socket.id);
      if (student) student.isSpeaking = false;

      console.log(`[Floor] Released by: ${activeSpeaker.name} (${socket.id})`);
      activeSpeaker = null;

      socket.emit('floor-released', { success: true });

      if (receiverSocketId) {
        io.to(receiverSocketId).emit('speaker-idle');
      }

      // Notify all students floor is now free
      io.emit('floor-free');
    }
  });

  // --- WebRTC Signaling ---
  socket.on('signal', ({ to, data }) => {
    // Relay WebRTC signaling message (offer, answer, ice-candidate)
    const targetId = to || receiverSocketId;
    if (targetId) {
      io.to(targetId).emit('signal', {
        from: socket.id,
        data
      });
    }
  });

  // --- WebSocket PCM Binary Audio Stream (Fallback & Direct Stream) ---
  socket.on('audio-chunk', (audioBuffer) => {
    // Only relay audio if this student holds the floor
    if (activeSpeaker && activeSpeaker.socketId === socket.id && receiverSocketId) {
      io.to(receiverSocketId).emit('audio-chunk', {
        studentId: socket.id,
        name: activeSpeaker.name,
        chunk: audioBuffer
      });
    }
  });

  // --- End Classroom Session ---
  socket.on('end-session', () => {
    if (socket.id === receiverSocketId) {
      console.log('[Receiver] Ended the session manually.');
      // Notify all connected clients
      io.emit('session-ended');
      
      // Clear active speaker immediately
      activeSpeaker = null;
      io.emit('floor-free');
    }
  });

  // --- Disconnect Handler ---
  socket.on('disconnect', () => {
    if (socket.id === receiverSocketId) {
      console.log('[Receiver] Laptop disconnected');
      receiverSocketId = null;
      io.emit('receiver-status', { online: false });
    }

    if (students.has(socket.id)) {
      const student = students.get(socket.id);
      console.log(`[Student] Disconnected: ${student.name} (${socket.id})`);
      students.delete(socket.id);

      // If active speaker disconnected, free the floor immediately
      if (activeSpeaker && activeSpeaker.socketId === socket.id) {
        activeSpeaker = null;
        if (receiverSocketId) {
          io.to(receiverSocketId).emit('speaker-idle');
        }
        io.emit('floor-free');
      }

      // Update student list on receiver
      if (receiverSocketId) {
        io.to(receiverSocketId).emit('students-updated', Array.from(students.values()));
      }
    }
  });
});

// 5. HTTP Server for friendly redirect to HTTPS
const redirectApp = express();
redirectApp.use((req, res) => {
  const host = req.headers.host ? req.headers.host.split(':')[0] : primaryAddress;
  res.redirect(`https://${host}:${HTTPS_PORT}${req.url}`);
});
const httpServer = http.createServer(redirectApp);

  // 6. Start listening
  httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
    httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
      printStartupBanner();
    });
  });
}

start().catch(err => {
  console.error('Fatal server startup error:', err);
  process.exit(1);
});

function printStartupBanner() {
  console.log('\n===============================================================');
  console.log('  🎙️  WIRELESS CLASSROOM VOICE COMMUNICATION SYSTEM');
  console.log('===============================================================');
  console.log(`\n💻 LAPTOP RECEIVER (Classroom Display / Sound System):`);
  console.log(`   https://localhost:${HTTPS_PORT}`);
  console.log(`   https://${primaryAddress}:${HTTPS_PORT}\n`);
  
  console.log(`📱 STUDENT MOBILE MICROPHONE URL:`);
  console.log(`   ${primaryStudentUrl}\n`);

  if (networkAddresses.length > 1) {
    console.log('📡 Other detected Network IP addresses:');
    for (const addr of networkAddresses) {
      console.log(`   - ${addr.interface}: https://${addr.ip}:${HTTPS_PORT}/student.html`);
    }
    console.log('');
  }

  console.log('🔒 HTTPS & MOBILE MICROPHONE NOTE:');
  console.log('   Mobile browsers require HTTPS for microphone access.');
  console.log('   When students open the link, their browser will display');
  console.log('   "Your connection is not private / Not secure".');
  console.log('   -> Tap "Advanced" -> "Proceed to site (unsafe)".');
  console.log('   This enables the mobile microphone with zero external internet required!\n');

  console.log('📲 SCAN THIS QR CODE WITH YOUR PHONE CAMERA:');
  QRCode.toString(primaryStudentUrl, { type: 'terminal', small: true }, (err, qrStr) => {
    if (!err) console.log(qrStr);
    console.log('===============================================================\n');
  });
}
