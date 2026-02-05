'use client';

import { useEffect, useState, useCallback } from 'react';
import { useAuth, apiFetch } from '@/hooks/useAuth';
import { useRouter } from 'next/navigation';

interface InventoryItem {
  id: string;
  name: string;
  unit: string;
  currentStock: number;
  minStock: number;
  costPerUnit: number | null;
  supplier: string | null;
}

interface ReorderSuggestion {
  itemId: string;
  name: string;
  unit: string;
  currentStock: number;
  minStock: number;
  avgDailyUsage: number;
  daysUntilEmpty: number;
  suggestedOrder: number;
  supplier: string | null;
  urgency: 'critical' | 'warning' | 'info';
}

export default function InventoryPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [suggestions, setSuggestions] = useState<ReorderSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [adjusting, setAdjusting] = useState<string | null>(null);
  const [adjQty, setAdjQty] = useState('');
  const [adjType, setAdjType] = useState('receiving');
  const [adjNotes, setAdjNotes] = useState('');

  const loadData = useCallback(async () => {
    try {
      const data = await apiFetch('/api/inventory');
      setItems(data.items.map((i: any) => ({ ...i, currentStock: Number(i.currentStock), minStock: Number(i.minStock), costPerUnit: i.costPerUnit ? Number(i.costPerUnit) : null })));
    } catch (err) { console.error(err); }
  }, []);

  const loadSuggestions = async () => {
    try {
      const data = await apiFetch('/api/inventory?action=reorder-suggestions');
      setSuggestions(data.suggestions);
      setShowSuggestions(true);
    } catch (err) { console.error(err); }
  };

  useEffect(() => {
    if (!authLoading && !user) { router.push('/login'); return; }
    if (user) loadData();
  }, [user, authLoading, router, loadData]);

  const handleAdjust = async (itemId: string) => {
    if (!adjQty) return;
    try {
      await apiFetch('/api/inventory', {
        method: 'POST',
        body: JSON.stringify({ action: 'adjust', itemId, quantity: Number(adjQty), type: adjType, notes: adjNotes }),
      });
      setAdjusting(null); setAdjQty(''); setAdjNotes('');
      await loadData();
    } catch (err: any) { alert(err.message); }
  };

  if (authLoading) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <a href="/" className="text-gray-400 hover:text-gray-600">←</a>
          <h1 className="font-bold text-gray-900">📦 Inventario</h1>
        </div>
        <button onClick={loadSuggestions} className="btn-primary btn-sm">🛒 Suggerimenti Riordino</button>
      </header>

      <main className="max-w-5xl mx-auto p-4 space-y-4">
        {showSuggestions && suggestions.length > 0 && (
          <div className="card border-amber-200 bg-amber-50">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-amber-800">🛒 Suggerimenti Riordino</h2>
              <button onClick={() => setShowSuggestions(false)} className="text-gray-400 hover:text-gray-600">✕</button>
            </div>
            <div className="space-y-2">
              {suggestions.map((s) => (
                <div key={s.itemId} className={`flex items-center justify-between p-2 rounded-lg ${s.urgency === 'critical' ? 'bg-red-100' : s.urgency === 'warning' ? 'bg-amber-100' : 'bg-blue-50'}`}>
                  <div>
                    <span className="font-medium text-sm">{s.name}</span>
                    <span className="text-xs text-gray-500 ml-2">
                      Stock: {s.currentStock} {s.unit} | Min: {s.minStock} | ~{s.daysUntilEmpty}gg rimanenti
                    </span>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-bold">Ordina: {s.suggestedOrder} {s.unit}</div>
                    {s.supplier && <div className="text-xs text-gray-500">da {s.supplier}</div>}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-gray-500">
                  <th className="pb-2">Articolo</th>
                  <th className="pb-2">Stock</th>
                  <th className="pb-2">Min</th>
                  <th className="pb-2">Unità</th>
                  <th className="pb-2">Fornitore</th>
                  <th className="pb-2">Stato</th>
                  <th className="pb-2">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const isLow = item.currentStock <= item.minStock;
                  const isCritical = item.currentStock <= 0;
                  return (
                    <tr key={item.id} className={`border-b ${isCritical ? 'bg-red-50' : isLow ? 'bg-amber-50' : ''}`}>
                      <td className="py-2 font-medium">{item.name}</td>
                      <td className={`py-2 font-bold ${isCritical ? 'text-red-600' : isLow ? 'text-amber-600' : 'text-gray-900'}`}>
                        {item.currentStock}
                      </td>
                      <td className="py-2 text-gray-500">{item.minStock}</td>
                      <td className="py-2 text-gray-500">{item.unit}</td>
                      <td className="py-2 text-gray-500">{item.supplier || '—'}</td>
                      <td className="py-2">
                        {isCritical ? <span className="text-xs bg-red-600 text-white px-2 py-0.5 rounded-full">ESAURITO</span>
                          : isLow ? <span className="text-xs bg-amber-500 text-white px-2 py-0.5 rounded-full">BASSO</span>
                          : <span className="text-xs bg-emerald-100 text-emerald-700 px-2 py-0.5 rounded-full">OK</span>}
                      </td>
                      <td className="py-2">
                        <button onClick={() => { setAdjusting(item.id); setAdjQty(''); setAdjType('receiving'); setAdjNotes(''); }}
                          className="btn-ghost btn-sm text-blue-600">Aggiusta</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Adjust Modal */}
        {adjusting && (
          <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
            <div className="card w-full max-w-md">
              <h3 className="font-semibold mb-3">Aggiusta Stock — {items.find((i) => i.id === adjusting)?.name}</h3>
              <div className="space-y-3">
                <div>
                  <label className="label">Tipo</label>
                  <select className="input" value={adjType} onChange={(e) => setAdjType(e.target.value)}>
                    <option value="receiving">📦 Ricevimento merce</option>
                    <option value="waste">🗑 Spreco/Scarto</option>
                    <option value="adjustment">✏️ Correzione manuale</option>
                  </select>
                </div>
                <div>
                  <label className="label">Quantità ({adjType === 'waste' ? 'negativa' : 'positiva'})</label>
                  <input className="input" type="number" step="0.1" value={adjQty}
                    onChange={(e) => setAdjQty(e.target.value)} placeholder={adjType === 'waste' ? '-5' : '10'} />
                </div>
                <div>
                  <label className="label">Note</label>
                  <input className="input" value={adjNotes} onChange={(e) => setAdjNotes(e.target.value)} placeholder="Motivo..." />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => setAdjusting(null)} className="btn-secondary flex-1">Annulla</button>
                  <button onClick={() => handleAdjust(adjusting)} className="btn-primary flex-1">Conferma</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
