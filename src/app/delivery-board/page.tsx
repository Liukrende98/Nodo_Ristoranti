'use client';

import { useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useLocalDeliveries, useLocalUsers, useOfflineActions, useSyncEngine } from '@/hooks/useOffline';
import { SyncIndicator } from '@/components/SyncStatus';
import { useRouter } from 'next/navigation';

export default function DeliveryBoardPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  useSyncEngine();

  // ALL FROM LOCAL DB
  const allDeliveries = useLocalDeliveries();
  const riders = useLocalUsers('delivery');
  const actions = useOfflineActions();

  useEffect(() => {
    if (!authLoading && !user) router.push('/login');
  }, [user, authLoading, router]);

  const pending = allDeliveries.filter((d) => d.status === 'pending');
  const assigned = allDeliveries.filter((d) => d.status === 'assigned');
  const active = allDeliveries.filter((d) => d.status === 'picked_up');
  const completed = allDeliveries.filter((d) => d.status === 'delivered').slice(0, 10);

  const handleAssign = (deliveryId: string) => {
    const sel = document.getElementById(`rider-${deliveryId}`) as HTMLSelectElement;
    const rider = riders.find((r) => r.id === sel?.value);
    if (sel?.value) {
      actions.assignDelivery(deliveryId, sel.value, rider?.name).catch(console.error);
    }
  };

  if (authLoading) {
    return <div className="min-h-screen flex items-center justify-center"><div className="animate-spin h-10 w-10 border-4 border-blue-500 border-t-transparent rounded-full" /></div>;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold">🛵 Consegne</span>
          <span className="text-sm text-gray-500">{user?.tenant.name}</span>
        </div>
        <div className="flex items-center gap-3">
          <SyncIndicator />
          <a href="/" className="btn-ghost btn-sm">← Dashboard</a>
        </div>
      </header>

      <main className="max-w-7xl mx-auto p-4">
        <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
          {/* Pending */}
          <Column title="🟡 Da Assegnare" count={pending.length}>
            {pending.map((d) => (
              <DeliveryCard key={d.id} d={d}>
                <div className="flex gap-2 mt-3">
                  <select className="input flex-1 text-xs" id={`rider-${d.id}`} defaultValue="">
                    <option value="" disabled>Scegli rider...</option>
                    {riders.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                  </select>
                  <button className="btn-primary btn-sm" onClick={() => handleAssign(d.id)}>Assegna</button>
                </div>
              </DeliveryCard>
            ))}
          </Column>

          {/* Assigned */}
          <Column title="🔵 Assegnati" count={assigned.length}>
            {assigned.map((d) => (
              <DeliveryCard key={d.id} d={d}>
                <button className="w-full mt-3 btn-primary btn-sm"
                  onClick={() => actions.pickupDelivery(d.id).catch(console.error)}>
                  Ritirato
                </button>
              </DeliveryCard>
            ))}
          </Column>

          {/* In transit */}
          <Column title="🟠 In Consegna" count={active.length}>
            {active.map((d) => (
              <DeliveryCard key={d.id} d={d}>
                <button className="w-full mt-3 btn-success btn-sm"
                  onClick={() => actions.deliverDelivery(d.id).catch(console.error)}>
                  Consegnato ✓
                </button>
              </DeliveryCard>
            ))}
          </Column>

          {/* Completed */}
          <Column title="✅ Completati" count={completed.length}>
            {completed.map((d) => (
              <div key={d.id} className="card opacity-60 text-sm">
                <div className="font-medium">#{d._orderNumber || '—'}</div>
                <div className="text-xs text-gray-500">{d._riderName} — {d._customerName}</div>
              </div>
            ))}
          </Column>
        </div>
      </main>
    </div>
  );
}

function Column({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <h2 className="font-semibold text-gray-700">{title}</h2>
        <span className="text-xs bg-gray-200 px-2 py-0.5 rounded-full">{count}</span>
      </div>
      <div className="space-y-3">
        {children}
        {count === 0 && <p className="text-sm text-gray-400 text-center py-8">Nessuna consegna</p>}
      </div>
    </div>
  );
}

function DeliveryCard({ d, children }: { d: any; children?: React.ReactNode }) {
  return (
    <div className="card">
      <div className="flex items-center justify-between mb-2">
        <span className="text-lg font-bold">#{d._orderNumber || '—'}</span>
        {d._syncStatus === 'local' && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />}
      </div>
      {d._customerName && <div className="text-sm font-medium">{d._customerName}</div>}
      {d._customerAddress && <div className="text-xs text-gray-500 mt-1">📍 {d._customerAddress}</div>}
      {d._customerPhone && <div className="text-xs text-gray-500">📞 {d._customerPhone}</div>}
      {d._riderName && <div className="text-xs text-blue-600 mt-1">🛵 {d._riderName}</div>}
      {children}
    </div>
  );
}
