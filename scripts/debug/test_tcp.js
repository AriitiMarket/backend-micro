const net = require('net');
const socket = new net.Socket();
socket.setTimeout(5000);
socket.on('connect', () => { console.log('connected'); socket.destroy(); });
socket.on('error', (e) => console.error('error:', e.message));
socket.on('timeout', () => console.error('timeout'));
socket.connect(27017, 'mongodb');