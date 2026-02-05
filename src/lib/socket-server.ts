/**
 * Socket.io Server
 * 
 * Runs on port 3001 alongside the Next.js app on 3000.
 * Listens for events from the event bus and broadcasts to connected clients.
 * 
 * Usage: npx tsx src/lib/socket-server.ts
 */

import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import { eventBus } from './realtime';

const PORT = parseInt(process.env.SOCKET_PORT || '3001', 10);

const httpServer = createServer();
const io = new SocketServer(httpServer, {
  cors: {
    origin: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    methods: ['GET', 'POST'],
    credentials: true,
  },
  pingInterval: 25000,
  pingTimeout: 20000,
});

// ─── Connection Handling ─────────────────────────────────

io.on('connection', (socket) => {
  console.log(`[Socket] Connected: ${socket.id}`);

  // Client joins their tenant room
  socket.on('join_tenant', ({ tenantId }: { tenantId: string }) => {
    if (!tenantId) return;
    socket.join(`tenant:${tenantId}`);
    console.log(`[Socket] ${socket.id} joined tenant:${tenantId}`);
  });

  // Client joins a station-specific room (for KDS filtering)
  socket.on('join_station', ({ stationId }: { stationId: string }) => {
    if (!stationId) return;
    socket.join(`station:${stationId}`);
    console.log(`[Socket] ${socket.id} joined station:${stationId}`);
  });

  socket.on('disconnect', (reason) => {
    console.log(`[Socket] Disconnected: ${socket.id} (${reason})`);
  });
});

// ─── Event Bus → Socket.io Bridge ────────────────────────

eventBus.on('tenant-event', ({ tenantId, event, data }) => {
  io.to(`tenant:${tenantId}`).emit(event, data);

  // Also emit to station-specific rooms if applicable
  if (data?.stationId) {
    io.to(`station:${data.stationId}`).emit(event, data);
  }
});

// ─── Start Server ────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`\n🔌 Socket.io server running on port ${PORT}`);
  console.log(`   CORS origin: ${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}\n`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Socket] Shutting down...');
  io.close();
  httpServer.close();
  process.exit(0);
});
