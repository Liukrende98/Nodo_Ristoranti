'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useLocalMenu, useOfflineActions, useSyncEngine } from '@/hooks/useOffline';
import { SyncIndicator } from '@/components/SyncStatus';
import { useRouter } from 'next/navigation';
import type { CreateOrderInput } from '@/lib/offline';

interface CartItem {
  menuItemId: string;
  name: string;
  price: number;
  quantity: number;
  modifications: string;
  notes: string;
}

export default function NewOrderPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();
  useSyncEngine();

  const { items: menuItems, categories } = useLocalMenu();
  const actions = useOfflineActions();

  const [selectedCategory, setSelectedCategory] = useState('all');
  const [cart, setCart] = useState<CartItem[]>([]);
  const [channel, setChannel] = useState('phone');
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [customerAddress, setCustomerAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [priority, setPriority] = useState(0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!authLoading && !user) router.push('/login');
  }, [user, authLoading, router]);

  // ETA estimate (local calculation from workflow templates)
  const etaMinutes = cart.length > 0
    ? Math.max(...cart.map((c) => {
        const item = menuItems.find((m) => m.id === c.menuItemId);
        return (item as any)?.estimatedTotalMinutes || 10;
      })) + 2
    : null;

  const addToCart = (item: any) => {
    setCart((prev) => {
      const existing = prev.find((c) => c.menuItemId === item.id);
      if (existing) return prev.map((c) => c.menuItemId === item.id ? { ...c, quantity: c.quantity + 1 } : c);
      return [...prev, { menuItemId: item.id, name: item.name, price: item.price, quantity: 1, modifications: '', notes: '' }];
    });
  };

  const updateQty = (id: string, delta: number) => {
    setCart((prev) => prev.map((c) => c.menuItemId === id ? { ...c, quantity: Math.max(1, c.quantity + delta) } : c));
  };

  const removeFromCart = (id: string) => setCart((prev) => prev.filter((c) => c.menuItemId !== id));

  const total = cart.reduce((sum, c) => sum + c.price * c.quantity, 0);

  const handleSubmit = async () => {
    if (cart.length === 0) return;
    setSubmitting(true);
    setError('');

    try {
      const input: CreateOrderInput = {
        channel,
        customerName: customerName || undefined,
        customerPhone: customerPhone || undefined,
        customerAddress: customerAddress || undefined,
        notes: notes || undefined,
        priority,
        items: cart.map((c) => ({
          menuItemId: c.menuItemId,
          quantity: c.quantity,
          modifications: c.modifications || undefined,
          notes: c.notes || undefined,
        })),
      };

      // INSTANT — writes to IndexedDB, queues server sync
      await actions.createOrder(input);
      router.push('/');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSubmitting(false);
    }
  };

  const filtered = selectedCategory === 'all' ? menuItems : menuItems.filter((m) => m.category === selectedCategory);

  if (authLoading) return null;

  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <a href="/" className="text-gray-400 hover:text-gray-600">←</a>
          <h1 className="font-bold text-gray-900">Nuovo Ordine</h1>
        </div>
        <div className="flex items-center gap-3">
          {etaMinutes && (
            <div className="bg-blue-50 px-3 py-1.5 rounded-lg flex items-center gap-2">
              <span className="text-blue-600 text-sm">⏱ ETA:</span>
              <span className="text-blue-700 font-bold">{etaMinutes} min</span>
            </div>
          )}
          <SyncIndicator />
        </div>
      </header>

      <div className="max-w-7xl mx-auto p-4 grid lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-4">
          <div className="card">
            <label className="label">Canale</label>
            <div className="flex gap-2 flex-wrap">
              {[{ v: 'phone', l: '📞 Telefono' }, { v: 'in_store', l: '🏪 Sala' }, { v: 'online', l: '🌐 Online' }].map((ch) => (
                <button key={ch.v} onClick={() => setChannel(ch.v)}
                  className={`px-4 py-2 rounded-lg text-sm font-medium ${channel === ch.v ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}>
                  {ch.l}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-2 flex-wrap">
            <button onClick={() => setSelectedCategory('all')}
              className={`px-3 py-1.5 rounded-lg text-sm ${selectedCategory === 'all' ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-100'}`}>
              Tutti
            </button>
            {categories.map((cat) => (
              <button key={cat} onClick={() => setSelectedCategory(cat)}
                className={`px-3 py-1.5 rounded-lg text-sm ${selectedCategory === cat ? 'bg-gray-800 text-white' : 'bg-white text-gray-600 hover:bg-gray-100'}`}>
                {cat}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            {filtered.map((item) => {
              const inCart = cart.find((c) => c.menuItemId === item.id);
              return (
                <button key={item.id} onClick={() => addToCart(item)}
                  className={`card text-left hover:shadow-md transition-shadow ${inCart ? 'ring-2 ring-blue-500' : ''}`}>
                  <div className="font-medium text-sm">{item.name}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{item.category}</div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="font-bold text-blue-600">€{item.price.toFixed(2)}</span>
                    {inCart && <span className="bg-blue-600 text-white text-xs px-2 py-0.5 rounded-full">×{inCart.quantity}</span>}
                  </div>
                </button>
              );
            })}
            {filtered.length === 0 && (
              <p className="col-span-full text-center text-gray-400 py-8">Nessun articolo disponibile offline. Connettiti per caricare il menu.</p>
            )}
          </div>
        </div>

        <div className="space-y-4">
          <div className="card">
            <h2 className="font-semibold mb-3">👤 Cliente</h2>
            <div className="space-y-2">
              <input className="input" placeholder="Nome" value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              <input className="input" placeholder="Telefono" value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} />
              <input className="input" placeholder="Indirizzo (consegna)" value={customerAddress} onChange={(e) => setCustomerAddress(e.target.value)} />
              <textarea className="input" placeholder="Note" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
              <div>
                <label className="label">Priorità</label>
                <div className="flex gap-2">
                  {[{ v: 0, l: 'Normale' }, { v: 1, l: '⬆ Alta' }, { v: 2, l: '🔥 Urgente' }].map((p) => (
                    <button key={p.v} onClick={() => setPriority(p.v)}
                      className={`px-3 py-1.5 rounded-lg text-xs ${priority === p.v
                        ? p.v === 2 ? 'bg-red-600 text-white' : p.v === 1 ? 'bg-amber-500 text-white' : 'bg-gray-800 text-white'
                        : 'bg-gray-100 text-gray-600'}`}>
                      {p.l}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="card">
            <h2 className="font-semibold mb-3">🛒 Carrello ({cart.length})</h2>
            {cart.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">Tocca un articolo per aggiungerlo</p>
            ) : (
              <div className="space-y-3">
                {cart.map((item) => (
                  <div key={item.menuItemId} className="flex items-start gap-2 pb-2 border-b border-gray-100">
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm">{item.name}</div>
                      <div className="text-xs text-gray-500">€{item.price.toFixed(2)} cad.</div>
                      <input className="input mt-1 text-xs" placeholder="Modifiche (es. senza cipolla)"
                        value={item.modifications}
                        onChange={(e) => setCart((prev) => prev.map((c) => c.menuItemId === item.menuItemId ? { ...c, modifications: e.target.value } : c))} />
                    </div>
                    <div className="flex items-center gap-1">
                      <button onClick={() => updateQty(item.menuItemId, -1)} className="w-7 h-7 rounded bg-gray-100 text-sm hover:bg-gray-200">−</button>
                      <span className="w-6 text-center text-sm font-bold">{item.quantity}</span>
                      <button onClick={() => updateQty(item.menuItemId, 1)} className="w-7 h-7 rounded bg-gray-100 text-sm hover:bg-gray-200">+</button>
                      <button onClick={() => removeFromCart(item.menuItemId)} className="w-7 h-7 rounded text-red-400 hover:text-red-600 text-sm">✕</button>
                    </div>
                  </div>
                ))}
                <div className="flex items-center justify-between pt-2 font-bold">
                  <span>Totale</span>
                  <span className="text-lg">€{total.toFixed(2)}</span>
                </div>
              </div>
            )}
          </div>

          {error && <div className="bg-red-50 text-red-700 px-4 py-3 rounded-lg text-sm">{error}</div>}

          <button onClick={handleSubmit} disabled={cart.length === 0 || submitting}
            className="btn-primary w-full btn-lg">
            {submitting ? 'Creazione...' : `Conferma Ordine — €${total.toFixed(2)}`}
          </button>
        </div>
      </div>
    </div>
  );
}
