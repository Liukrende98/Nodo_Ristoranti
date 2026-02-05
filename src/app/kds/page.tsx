'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useLocalTasks, useLocalStations, useOfflineActions, useSyncEngine } from '@/hooks/useOffline';
import { SyncIndicator } from '@/components/SyncStatus';
import { useRouter } from 'next/navigation';

export default function KDSPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  useSyncEngine();

  const [selectedStation, setSelectedStation] = useState('all');
  const [now, setNow] = useState(Date.now());

  // ALL DATA FROM LOCAL DB — instant, works offline
  const tasks = useLocalTasks({
    stationId: selectedStation !== 'all' ? selectedStation : undefined,
    status: 'queued,in_progress',
  });
  const stations = useLocalStations();
  const actions = useOfflineActions();

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    if (!authLoading && !user) router.push('/login');
  }, [user, authLoading, router]);

  // ─── Instant Actions ───────────────────────────────────

  const handleStart = (taskId: string) => {
    actions.startTask(taskId).catch(console.error);
  };

  const handleComplete = (taskId: string) => {
    actions.completeTask(taskId).catch(console.error);
  };

  const handleCompleteSubtask = (taskId: string, subtaskId: string) => {
    actions.completeSubtask(taskId, subtaskId).catch(console.error);
  };

  const formatTimer = (startedAt?: string) => {
    if (!startedAt) return '--:--';
    const elapsed = Math.floor((now - new Date(startedAt).getTime()) / 1000);
    const mins = Math.floor(elapsed / 60);
    const secs = elapsed % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const isLate = (task: any) => {
    if (!task.startedAt || !task.estimatedMinutes) return false;
    return (now - new Date(task.startedAt).getTime()) / 60000 > task.estimatedMinutes * 1.2;
  };

  // Group by order
  const orderGroups = new Map<string, typeof tasks>();
  for (const task of tasks) {
    if (!orderGroups.has(task.orderId)) orderGroups.set(task.orderId, []);
    orderGroups.get(task.orderId)!.push(task);
  }

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-900">
        <div className="animate-spin h-10 w-10 border-4 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <header className="bg-gray-800 px-4 py-2 flex items-center justify-between border-b border-gray-700">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold text-blue-400">🍳 KDS</span>
          <span className="text-gray-400 text-sm">{user?.tenant.name}</span>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => setSelectedStation('all')}
            className={`px-3 py-1.5 rounded-lg text-sm font-medium ${selectedStation === 'all' ? 'bg-blue-600 text-white' : 'bg-gray-700 text-gray-300'}`}>
            Tutte
          </button>
          {stations.map((s) => (
            <button key={s.id} onClick={() => setSelectedStation(s.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${selectedStation === s.id ? 'text-white' : 'bg-gray-700 text-gray-300'}`}
              style={selectedStation === s.id ? { backgroundColor: (s.settings as any)?.color || '#3b82f6' } : undefined}>
              {s.name}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-3">
          <SyncIndicator />
          <a href="/" className="text-gray-400 hover:text-white text-sm">← Dashboard</a>
        </div>
      </header>

      <div className="p-4">
        {[...orderGroups.entries()].length === 0 ? (
          <div className="flex items-center justify-center h-[60vh]">
            <div className="text-center">
              <div className="text-6xl mb-4">👨‍🍳</div>
              <p className="text-xl text-gray-400">Nessun ordine in lavorazione</p>
              <p className="text-sm text-gray-500 mt-2">I nuovi ordini appariranno qui automaticamente</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[...orderGroups.entries()].map(([orderId, orderTasks]) => {
              const anyLate = orderTasks.some(isLate);
              const orderNum = orderTasks[0]?._orderNumber;
              const isLocal = orderTasks.some((t) => t._syncStatus === 'local');

              return (
                <div key={orderId} className={`rounded-xl p-4 border-2 transition-all ${anyLate ? 'border-red-500 bg-red-950/50 animate-flash' : 'border-gray-600 bg-gray-800'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-2xl font-bold">#{orderNum || '—'}</span>
                    <div className="flex items-center gap-2">
                      {anyLate && <span className="text-red-400 text-xs font-bold">⚠️ RITARDO</span>}
                      {isLocal && <span className="w-1.5 h-1.5 rounded-full bg-amber-500" title="Non sincronizzato" />}
                    </div>
                  </div>

                  <div className="space-y-2 kds-scroll max-h-[60vh] overflow-y-auto">
                    {orderTasks.map((task) => (
                      <div key={task.id}>
                        <div
                          className={task.status === 'in_progress' ? 'kds-task-in-progress' : task.status === 'queued' ? 'kds-task-queued' : 'kds-task-pending'}
                          onClick={() => task.status === 'queued' && handleStart(task.id)}
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="font-medium text-sm">{task.name}</span>
                              {task._stationName && (
                                <span className="text-[10px] px-1.5 py-0.5 rounded text-white" style={{ backgroundColor: task._stationColor || '#6366f1' }}>
                                  {task._stationName}
                                </span>
                              )}
                            </div>
                            <div className="text-xs opacity-70 mt-0.5">{task._menuItemName}</div>
                          </div>

                          {task.status === 'in_progress' && (
                            <div className={`font-mono text-lg font-bold ${isLate(task) ? 'text-red-400' : 'text-amber-300'}`}>
                              {formatTimer(task.startedAt)}
                            </div>
                          )}
                          {task.status === 'queued' && (
                            <span className="text-xs bg-blue-600 px-2 py-1 rounded-lg text-white whitespace-nowrap">AVVIA →</span>
                          )}
                        </div>

                        {task.status === 'in_progress' && (task as any).subtasks?.length > 0 && (
                          <div className="ml-4 mt-1 space-y-1">
                            {(task as any).subtasks.map((sub: any) => (
                              <button key={sub.id}
                                onClick={() => !sub.isCompleted && handleCompleteSubtask(task.id, sub.id)}
                                disabled={sub.isCompleted}
                                className={`w-full text-left flex items-center gap-2 px-2 py-1.5 rounded text-xs ${sub.isCompleted ? 'text-gray-500 line-through' : 'text-gray-200 hover:bg-gray-700'}`}>
                                <span className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 ${sub.isCompleted ? 'bg-emerald-600 border-emerald-600' : 'border-gray-500'}`}>
                                  {sub.isCompleted && '✓'}
                                </span>
                                {sub.name}
                              </button>
                            ))}
                          </div>
                        )}

                        {task.status === 'in_progress' && (
                          <button onClick={() => handleComplete(task.id)}
                            className="w-full mt-2 btn-success btn-sm">
                            ✅ Completato
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
