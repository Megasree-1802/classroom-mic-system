# 🎙️ Wireless Classroom Voice Communication System

A low-latency, browser-based voice communication system for classrooms. 
Instead of passing around a single physical microphone, students use their own mobile phones as wireless microphones over the local Wi-Fi / Hotspot network. The teacher's laptop acts as the central receiver and broadcasts student answers through the classroom speaker system.

---

## 🏛️ System Architecture

```
Student Mobile Browser (Chrome/Safari)
     ↓ [Mobile Microphone with Echo Cancellation & AGC]
     ↓ [Tap-to-Speak Toggle Control]
Local Wi-Fi Network / Mobile Hotspot (LAN)
     ↓ [Encrypted HTTPS + WebRTC Opus / 24kHz PCM Stream]
Laptop Central Receiver (Node.js Server & Dashboard)
     ↓ [Web Audio Pipeline & Master Gain Controller]
Classroom Speaker / Sound System (3.5mm Aux / Bluetooth / HDMI)
```

---

## ⚡ Quick Start (Windows)

### 1. Prerequisites
- **Node.js**: Ensure Node.js (v18 or newer) is installed.
  Check in PowerShell or Command Prompt:
  ```powershell
  node -v
  npm -v
  ```

### 2. Install Dependencies
Open PowerShell in this project folder:
```powershell
npm install
```

### 3. Start the Classroom Server
```powershell
npm start
```
The server will:
- Discover all local IP addresses (Wi-Fi, Ethernet, Hotspot).
- Automatically generate local self-signed SSL certificates for HTTPS.
- Display a clickable local link, mobile student URL, and a **terminal QR code**.

---

## 🔍 How to Find Your Laptop's Local IP Address Using `ipconfig`

If you ever need to manually verify your laptop's IP address on the classroom network:

1. Open **PowerShell** or **Command Prompt**.
2. Run:
   ```powershell
   ipconfig
   ```
3. Scroll to the network adapter you are currently using:
   - If connected via Wi-Fi: Look under **Wireless LAN adapter Wi-Fi**.
   - If using Mobile Hotspot: Look under **Wireless LAN adapter Local Area Connection***.
   - If connected via Cable: Look under **Ethernet adapter**.
4. Note the **IPv4 Address** (e.g., `192.168.1.45` or `10.52.139.117`).
5. Your student access link is:
   ```
   https://<YOUR_IPV4_ADDRESS>:3000/student.html
   ```
   *(Note: The server console and laptop dashboard display this URL and QR code automatically!)*

---

## 📱 Mobile Phone Connection & HTTPS Security Setup

### Why HTTPS is Required
Modern mobile browsers (Google Chrome on Android and Apple Safari on iOS) **strictly prohibit microphone access** on insecure HTTP origins when connecting over local IP addresses (e.g. `http://192.168.x.x`).

### How Our System Solves This:
The server automatically generates an internal SSL certificate and serves the application over **HTTPS**.

#### Step-by-Step for Students:
1. **Connect to Same Network**: Ensure the phone is connected to the same Wi-Fi router or laptop mobile hotspot.
2. **Open the App**: Scan the QR code shown on the laptop screen (or open `https://<laptop-ip>:3000/student.html`).
3. **Accept the One-Time Security Notice**:
   - **Google Chrome (Android)**: Tap **"Advanced"** &rarr; tap **"Proceed to [IP address] (unsafe)"**.
   - **Safari (iOS / iPhone)**: Tap **"Show Details"** &rarr; tap **"visit this website"** &rarr; tap **"Visit Website"**.
4. **Grant Microphone Access**: Tap **"Allow"** when the browser asks for microphone permission.
5. **Enter Name & Speak**: Enter your name, then tap the **"TAP TO SPEAK"** button once to start speaking. Tap again to stop.

---

## 🛡️ Audio Feedback (Howling) Prevention Guide

Classrooms often suffer from acoustic feedback when a microphone picks up the amplified sound from the speaker. This system implements multiple hardware and software safeguards:

1. **Tap-to-Speak Toggle Control**: The microphone is completely muted until the student taps the button. A second tap immediately mutes and releases the channel. No open background mics.
2. **Single-Speaker Floor Control**: Only one student can transmit at any given time. If another student tries to talk while someone is speaking, the channel locks and informs them who is currently speaking.
3. **No Mobile Loopback**: Mobile phones do not play audio from other students, eliminating mobile-to-mobile screech loops.
4. **Browser Acoustic Filters**: Built-in `echoCancellation: true`, `noiseSuppression: true`, and `autoGainControl: true` are enforced on the audio stream.
5. **Physical Classroom Positioning Tips**:
   - Keep classroom speakers pointed towards students, but place the teacher's laptop away from the speaker cones.
   - Students should hold the phone approximately 10–15 cm from their mouth and speak at a normal conversational volume.
   - The teacher can use the **Master Volume Slider** and **Mute All** button on the laptop receiver dashboard to immediately cut audio if necessary.

---

## 🎛️ Laptop Receiver Dashboard Features

- **Classroom Display**: Projected onto the screen or kept on the teacher's desk.
- **Dynamic On-Screen QR Code**: Allows students to instantly join by pointing their camera at the projector.
- **Hero Speaker Spotlight**: Displays the speaking student's name, active avatar, and speaking timer.
- **Real-Time Audio Visualizer**: Live HTML5 Canvas frequency spectrum and oscilloscope showing vocal clarity.
- **Audio Test Chime**: Play a pleasant three-tone chime to test laptop speakers before class begins.
- **Student Roster**: Displays connected student devices and their connection status.

---

## 📁 Project Structure

```
d:/classroom voice system/
├── certs/                 # Auto-generated SSL certificates
│   ├── cert.pem
│   └── key.pem
├── public/                # Web client assets
│   ├── css/
│   │   └── style.css      # Dark-mode glassmorphic design system
│   ├── js/
│   │   ├── receiver.js    # Web Audio pipeline & WebRTC receiver
│   │   └── student.js     # Microphone capture & PTT sender
│   ├── index.html         # Laptop Central Receiver UI
│   └── student.html       # Student Mobile Phone UI
├── package.json           # Project manifest & npm scripts
├── server.js              # Node.js HTTPS + Socket.IO server & IP detection
└── README.md              # Complete setup and classroom instructions
```

---

## 🚀 Running Without External Internet (Offline Hotspot Mode)

This system requires **zero external internet**:
1. Turn on your laptop's **Mobile Hotspot** in Windows Settings (or use a standalone travel Wi-Fi router).
2. Connect student phones to the laptop's hotspot network.
3. Run `npm start`.
4. Everything works 100% locally and offline!
