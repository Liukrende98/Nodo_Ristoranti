'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useAuth } from './useAuth';

const SOCKET_URL = process.env.NEXT_PUBLIC_SOCKET_URL || 'http://localhost:3001';

export function useSocket() {
  const { user } = useAuth();
  const socketRef = useRef<Socket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!user) return;

    const socket = io(SOCKET_URL, {
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionAttempts: 10,
    });

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('join_tenant', { tenantId: user.tenantId });
    });

    socket.on('disconnect', () => {
      setConnected(false);
    });

    socketRef.current = socket;

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [user]);

  const on = useCallback((event: string, handler: (data: any) => void) => {
    socketRef.current?.on(event, handler);
    return () => {
      socketRef.current?.off(event, handler);
    };
  }, []);

  const joinStation = useCallback((stationId: string) => {
    socketRef.current?.emit('join_station', { stationId });
  }, []);

  return { connected, on, joinStation };
}
