'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth, apiFetch } from '@/hooks/useAuth';
import { useSocket } from '@/hooks/useSocket';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

interface Analytics {
  totalOrders: number;
  completedOrders: number;
  activeOrders: number;
  cancelledOrders: number;
  revenue: number;
  avgPrepMinutes: number;
  lateOrders: number;
  latePercent: number;
  topItems: { name: string; count: number }[];
  byChannel: Record<string, number>;
}

interface StationStat {
  id: string;
  name: string;
  capacity: number;
  settings: any;
  completedToday: number;
  activeNow: number;
  loadPercent: number;
  avgDurationMinutes: number;
}

export default function DashboardPage() {
  const { user, loading: authLoading, logout } = useAuth();
  const router = useRouter();
  const { connected, on } = useSocket();
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [stations, setStations] = useState<StationStat[]>([]);

  const loadData = useCallback(async () => {
    try {
      const [aRes, sRes] = await Promise.all([
        apiFetch('/api/analytics?type=today'),
        apiFetch('/api/analytics?type=stations'),
      ]);
      setAnalytics(aRes);
      setStations(sRes.stations);
    } catch (err) {
      console.error(err);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && !user) { router.push('/login'); return; }
    if (user) loadData();
  }, [user, authLoading, router, loadData]);

  useEffect(() => {
    const unsubs = [
      on('order:created', () => loadData()),
      on('order:updated', () => loadData()),
      on('task:completed', () => loadData()),
    ];
    return () => unsubs.forEach((u) => u?.());
  }, [on, loadData]);

  useEffect(() => {
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin h-8 w-8 border-4 border-blue-600 border-t-transparent rounded-full" />
      </div>
    );
  }

  if (!user) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b border-gray-200 px-4 py-3">
        <div className="max-w-7xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center">
              <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <div>
              <h1 className="font-bold text-gray-900">OpsOS</h1>
              <p className="text-xs text-gray-500">{user.tenant.name}</p>
            </div>
          </div>

          <nav className="flex items-center gap-2 flex-wrap">
            <Link href="/kds" className="btn-secondary btn-sm">🍳 Cucina</Link>
            <Link href="/delivery-board" className="btn-secondary btn-sm">🛵 Consegne</Link>
            <Link href="/admin/menu" className="btn-secondary btn-sm">📋 Menu</Link>
            <Link href="/admin/inventory" className="btn-secondary btn-sm">📦 Inventario</Link>
            <div className="flex items-center gap-2 ml-2 pl-2 border-l">
              <span className={`w-2 h-2 rounded-full ${connected ? 'bg-emerald-500' : 'bg-red-500'}`} />
              <span className="text-sm text-gray-600">{user.name}</span>
              <button onClick={logout} className="btn-ghost btn-sm text-gray-400">Esci</button>
            </div>
          </nav>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4 space-y-6">
        {analytics && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <KPI label="Ordini Oggi" value={analytics.totalOrders} icon="📋" />
            <KPI label="Attivi Ora" value={analytics.activeOrders} icon="🔥" accent="amber" />
            <KPI label="Completati" value={analytics.completedOrders} icon="✅" accent="emerald" />
            <KPI label="Fatturato" value={`€${analytics.revenue.toFixed(0)}`} icon="💰" accent="blue" />
            <KPI label="Tempo Medio" value={`${analytics.avgPrepMinutes.toFixed(0)}m`} icon="⏱" />
            <KPI label="In Ritardo" value={`${analytics.latePercent}%`} icon="⚠️"
              accent={analytics.latePercent > 20 ? 'red' : 'gray'} />
          </div>
        )}

        <div className="grid lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 card">
            <h2 className="font-semibold text-gray-900 mb-4">Carico Postazioni</h2>
            <div className="grid md:grid-cols-2 gap-3">
              {stations.map((s) => (
                <div key={s.id} className="flex items-center gap-3 p-3 rounded-lg bg-gray-50">
                  <div className="w-10 h-10 rounded-lg flex items-center justify-center text-white text-sm font-bold"
                    style={{ backgroundColor: (s.settings as any)?.color || '#6366f1' }}>
                    {s.activeNow}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <span className="font-medium text-sm">{s.name}</span>
                      <span className="text-xs text-gray-500">{s.completedToday} completati</span>
                    </div>
                    <div className="mt-1 w-full bg-gray-200 rounded-full h-2">
                      <div className={`h-2 rounded-full transition-all ${
                        s.loadPercent > 80 ? 'bg-red-500' : s.loadPercent > 50 ? 'bg-amber-500' : 'bg-emerald-500'
                      }`} style={{ width: `${Math.min(100, s.loadPercent)}%` }} />
                    </div>
                    <div className="flex justify-between mt-0.5">
                      <span className="text-xs text-gray-400">{s.activeNow}/{s.capacity} slots</span>
                      <span className="text-xs text-gray-400">~{s.avgDurationMinutes}min/task</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {analytics && (
            <div className="card">
              <h2 className="font-semibold text-gray-900 mb-4">Top Articoli Oggi</h2>
              <div className="space-y-2">
                {analytics.topItems.map((item, i) => (
                  <div key={item.name} className="flex items-center justify-between p-2 rounded-lg hover:bg-gray-50">
                    <span className="text-sm"><span className="text-gray-400 mr-2">#{i + 1}</span>{item.name}</span>
                    <span className="text-sm font-medium text-gray-600">×{item.count}</span>
                  </div>
                ))}
                {analytics.topItems.length === 0 && (
                  <p className="text-sm text-gray-400 text-center py-4">Nessun ordine ancora</p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="fixed bottom-6 right-6">
          <Link href="/admin/orders/new" className="btn-primary btn-lg shadow-lg rounded-full flex items-center gap-2">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            Nuovo Ordine
          </Link>
        </div>
      </main>
    </div>
  );
}

function KPI({ label, value, icon, accent = 'gray' }: {
  label: string; value: string | number; icon: string; accent?: string;
}) {
  const colors: Record<string, string> = {
    gray: '', blue: 'bg-blue-50 text-blue-700', emerald: 'bg-emerald-50 text-emerald-700',
    amber: 'bg-amber-50 text-amber-700', red: 'bg-red-50 text-red-700',
  };
  return (
    <div className={`card ${colors[accent] || ''}`}>
      <div className="text-lg mb-1">{icon}</div>
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}
